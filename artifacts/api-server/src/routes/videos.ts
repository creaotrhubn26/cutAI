import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { videosTable, projectsTable, activityTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import multer from "multer";
import path from "path";
import fs from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  ListProjectVideosParams,
  GetVideoParams,
  DeleteVideoParams,
} from "@workspace/api-zod";

const execFileAsync = promisify(execFile);
const THUMBNAIL_DIR = process.env.THUMBNAIL_DIR ?? "/tmp/cutai-thumbnails";
const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/cutai-uploads";
const CHUNK_DIR = process.env.CHUNK_DIR ?? "/tmp/cutai-chunks";

for (const dir of [THUMBNAIL_DIR, UPLOAD_DIR, CHUNK_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Startup: clean up orphaned files (uploads with no DB record, old chunk dirs)
// ---------------------------------------------------------------------------
async function cleanupOrphans() {
  try {
    const dbVideos = await db.select({ filePath: videosTable.filePath }).from(videosTable);
    const dbPaths = new Set(dbVideos.map((v) => v.filePath));

    // Delete upload files not tracked in DB
    const uploadFiles = fs.readdirSync(UPLOAD_DIR);
    for (const f of uploadFiles) {
      const full = path.join(UPLOAD_DIR, f);
      if (!dbPaths.has(full)) {
        try { fs.unlinkSync(full); console.log("[cleanup] removed orphan:", f); } catch {}
      }
    }

    // Delete chunk directories older than 2 hours
    const chunkDirs = fs.readdirSync(CHUNK_DIR);
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    for (const d of chunkDirs) {
      const full = path.join(CHUNK_DIR, d);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          console.log("[cleanup] removed stale chunk dir:", d);
        }
      } catch {}
    }
  } catch (err) {
    console.error("[cleanup] orphan cleanup failed:", err);
  }
}

// Run cleanup 5s after startup (non-blocking)
setTimeout(cleanupOrphans, 5000);

// ---------------------------------------------------------------------------
// Multer configs
// ---------------------------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const unique = `${randomUUID()}${path.extname(file.originalname)}`;
    cb(null, unique);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype.startsWith("video/") ||
      file.mimetype.startsWith("audio/") ||
      file.mimetype === "application/octet-stream"
    ) cb(null, true);
    else cb(new Error("Only video or audio files are allowed"));
  },
});

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, _file, cb) => cb(null, `chunk_tmp_${randomUUID()}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function probeVideo(filePath: string) {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_streams",
      "-show_format",
      filePath,
    ]);
    const probe = JSON.parse(stdout);
    const vs = probe.streams?.find((s: any) => s.codec_type === "video");
    return {
      width: vs?.width as number | undefined,
      height: vs?.height as number | undefined,
      duration: parseFloat(probe.format?.duration ?? "0"),
    };
  } catch {
    return { width: undefined, height: undefined, duration: 0 };
  }
}

async function transcodeToProxy(
  srcPath: string,
  videoId: string,
  dbRef: typeof db,
  table: typeof videosTable,
  eqFn: typeof eq
) {
  const outFilename = `${randomUUID()}.mp4`;
  const outPath = path.join(UPLOAD_DIR, outFilename);
  try {
    await execFileAsync("ffmpeg", [
      "-i", srcPath,
      "-vf", "scale=-2:1080",
      "-c:v", "libx264", "-crf", "22", "-preset", "fast",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outPath,
    ]);
    const { width, height, duration } = await probeVideo(outPath);
    const stat = fs.statSync(outPath);
    // Delete the 4K source now that we have the 1080p proxy
    try { fs.unlinkSync(srcPath); } catch {}
    await dbRef.update(table).set({
      filename: outFilename,
      filePath: outPath,
      sizeBytes: stat.size,
      width,
      height,
      durationSeconds: duration || undefined,
      status: "ready",
    }).where(eqFn(table.id, videoId));
  } catch (err) {
    console.error("Transcode failed:", err);
    // Fall back to original file; mark ready so UI isn't stuck
    await dbRef.update(table).set({ status: "ready" }).where(eqFn(table.id, videoId));
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const router: IRouter = Router();

router.get("/projects/:id/videos", async (req, res) => {
  const { id } = ListProjectVideosParams.parse(req.params);
  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, id));
  res.json(videos.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })));
});

// Admin: manually trigger orphan cleanup
router.post("/admin/cleanup", async (_req, res) => {
  cleanupOrphans().catch(console.error);
  res.json({ ok: true, message: "Cleanup started" });
});

// Admin: disk usage summary
router.get("/admin/disk", (_req, res) => {
  const getSize = (dir: string) => {
    try {
      let total = 0;
      const files = fs.readdirSync(dir);
      for (const f of files) {
        try { total += fs.statSync(path.join(dir, f)).size; } catch {}
      }
      return total;
    } catch { return 0; }
  };
  res.json({
    uploadBytes: getSize(UPLOAD_DIR),
    chunkBytes: getSize(CHUNK_DIR),
    thumbnailBytes: getSize(THUMBNAIL_DIR),
  });
});

// ---------------------------------------------------------------------------
// Chunked upload
// ---------------------------------------------------------------------------
router.post("/videos/chunk", chunkUpload.single("chunk"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No chunk data" });

  const { uploadId, chunkIndex, totalChunks, projectId, filename, mimeType, fileSize } = req.body;
  if (!uploadId || chunkIndex === undefined || !totalChunks || !projectId || !filename) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Missing required fields" });
  }

  const uploadDir = path.join(CHUNK_DIR, uploadId);
  fs.mkdirSync(uploadDir, { recursive: true });

  const idx = String(chunkIndex).padStart(8, "0");
  const chunkPath = path.join(uploadDir, `chunk_${idx}`);
  fs.renameSync(req.file.path, chunkPath);

  const received = fs.readdirSync(uploadDir).filter(f => f.startsWith("chunk_")).length;
  const total = parseInt(totalChunks, 10);

  if (received < total) {
    return res.status(200).json({ received, total });
  }

  // All chunks received — stream-assemble with delete-as-you-go to stay within quota
  const finalFilename = `${randomUUID()}${path.extname(filename)}`;
  const finalPath = path.join(UPLOAD_DIR, finalFilename);

  const sortedChunks = fs.readdirSync(uploadDir)
    .filter(f => f.startsWith("chunk_"))
    .sort();

  const writeStream = fs.createWriteStream(finalPath);

  try {
    for (const chunkFile of sortedChunks) {
      const chunkFilePath = path.join(uploadDir, chunkFile);
      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(chunkFilePath);
        readStream.on("error", reject);
        readStream.on("end", () => {
          // Delete each chunk immediately after piping to free quota space
          try { fs.unlinkSync(chunkFilePath); } catch {}
          resolve();
        });
        readStream.pipe(writeStream, { end: false });
      });
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
      writeStream.end();
    });
  } catch (assembleErr: any) {
    writeStream.destroy();
    try { fs.unlinkSync(finalPath); } catch {}
    console.error("Assembly failed:", assembleErr);
    return res.status(500).json({
      error: "Assembly failed",
      detail: assembleErr?.message ?? String(assembleErr),
    });
  }

  // Clean up the (now empty) chunk directory
  try { fs.rmSync(uploadDir, { recursive: true, force: true }); } catch {}

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) {
    try { fs.unlinkSync(finalPath); } catch {}
    return res.status(400).json({ error: "Project not found" });
  }

  const { width, height, duration } = await probeVideo(finalPath);
  const needsTranscode = height && height > 1080;
  const actualSize = fs.statSync(finalPath).size;

  const videoId = randomUUID();
  const [video] = await db.insert(videosTable).values({
    id: videoId,
    projectId,
    filename: finalFilename,
    originalName: filename,
    mimeType: mimeType || "video/mp4",
    sizeBytes: actualSize,
    filePath: finalPath,
    width,
    height,
    durationSeconds: duration || undefined,
    status: needsTranscode ? "transcoding" : "ready",
  }).returning();

  await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
  await db.insert(activityTable).values({
    id: randomUUID(),
    type: "video_uploaded",
    description: `Video "${filename}" uploaded to "${project.name}"${needsTranscode ? " (downscaling 4K→1080p)" : ""}`,
    projectId,
    projectName: project.name,
  });

  if (needsTranscode) {
    transcodeToProxy(finalPath, videoId, db, videosTable, eq).catch(console.error);
  }

  return res.status(201).json({ ...video, createdAt: video.createdAt.toISOString() });
});

// ---------------------------------------------------------------------------
// Regular (single-request) upload — kept for small files
// ---------------------------------------------------------------------------
router.post("/videos", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const projectId = req.body?.projectId;
  if (!projectId) return res.status(400).json({ error: "projectId is required" });

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(400).json({ error: "Project not found" });

  const id = randomUUID();
  const [video] = await db
    .insert(videosTable)
    .values({
      id,
      projectId,
      filename: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      sizeBytes: req.file.size,
      filePath: req.file.path,
      status: "ready",
    })
    .returning();

  await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
  await db.insert(activityTable).values({
    id: randomUUID(),
    type: "video_uploaded",
    description: `Video "${req.file.originalname}" uploaded to "${project.name}"`,
    projectId,
    projectName: project.name,
  });

  res.status(201).json({ ...video, createdAt: video.createdAt.toISOString() });
});

// ---------------------------------------------------------------------------
// Audio waveform — returns normalized amplitude array for timeline display
// ---------------------------------------------------------------------------
router.get("/videos/:id/waveform", async (req, res) => {
  const id = req.params.id;
  const points = Math.min(1000, Math.max(50, parseInt(String(req.query.points ?? "300"), 10)));

  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id));
  if (!video) return res.status(404).json({ error: "Not found" });

  const cacheFile = path.join(THUMBNAIL_DIR, `${id}_wf${points}.json`);
  if (fs.existsSync(cacheFile)) {
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.json(JSON.parse(fs.readFileSync(cacheFile, "utf-8")));
  }

  const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  const rawPath = path.join(THUMBNAIL_DIR, `${id}_pcm.raw`);
  try {
    // Extract mono PCM at 500Hz — enough for waveform display, fast to process
    await execFileAsync("ffmpeg", [
      "-i", filePath, "-ac", "1", "-vn",
      "-acodec", "pcm_s16le", "-ar", "500",
      "-f", "s16le", "-y", rawPath,
    ]);

    const raw = fs.readFileSync(rawPath);
    // Int16Array from the raw buffer (must use slice to handle Buffer's internal offset)
    const samples = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
    const totalSamples = samples.length;
    const windowSize = Math.max(1, Math.floor(totalSamples / points));

    const waveform: number[] = [];
    for (let i = 0; i < points; i++) {
      const start = i * windowSize;
      const end = Math.min(start + windowSize, totalSamples);
      let sum = 0;
      for (let j = start; j < end; j++) sum += Math.abs(samples[j]);
      const rms = end > start ? sum / (end - start) : 0;
      waveform.push(Math.round((rms / 32768) * 1000) / 1000);
    }

    try { fs.unlinkSync(rawPath); } catch {}
    const result = { waveform, duration: video.durationSeconds ?? 0, points };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result)); } catch {}
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.json(result);
  } catch (err: any) {
    try { fs.unlinkSync(rawPath); } catch {}
    // Return empty waveform instead of 500 (video may have no audio track)
    const empty = { waveform: new Array(points).fill(0), duration: video.durationSeconds ?? 0, points, noAudio: true };
    return res.json(empty);
  }
});

router.get("/videos/:id/thumbnail.jpg", async (req, res) => {
  const id = req.params.id;
  const t = parseFloat(String(req.query.t ?? "1.0"));
  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id));
  if (!video) return res.status(404).json({ error: "Not found" });

  // Audio-only files have no video frames — return 404 immediately
  const isAudioOnly = video.mimeType?.startsWith("audio/") ||
    Boolean(video.originalName?.match(/\.(mp3|wav|aac|m4a|ogg|flac)$/i) && !video.mimeType?.startsWith("video/"));
  if (isAudioOnly) return res.status(404).json({ error: "Audio-only file — no thumbnail available" });

  const thumbPath = path.join(THUMBNAIL_DIR, `${id}_${Math.floor(t)}.jpg`);

  if (!fs.existsSync(thumbPath)) {
    const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Video file not found" });

    try {
      await execFileAsync("ffmpeg", [
        "-y", "-ss", String(t), "-i", filePath,
        "-vframes", "1", "-q:v", "4", "-vf", "scale=320:-1",
        thumbPath,
      ]);
    } catch {
      return res.status(404).json({ error: "Failed to extract thumbnail" });
    }
  }

  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(thumbPath);
});

// ---------------------------------------------------------------------------
// Streaming playback
// ---------------------------------------------------------------------------
router.get("/videos/:id/stream", async (req, res) => {
  const id = req.params.id;
  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id));
  if (!video) return res.status(404).json({ error: "Not found" });

  const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Video file not found" });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  const cacheHeaders = {
    "Cache-Control": "public, max-age=3600",
    "Accept-Ranges": "bytes",
    "Content-Type": video.mimeType || "video/mp4",
  };

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      ...cacheHeaders,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": chunkSize,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      ...cacheHeaders,
      "Content-Length": fileSize,
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ---------------------------------------------------------------------------
// Enhanced audio stream (after AI enhancement job)
// ---------------------------------------------------------------------------
router.get("/videos/:id/enhanced-audio", async (req, res) => {
  const id = req.params.id;
  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id));
  if (!video) return res.status(404).json({ error: "Not found" });

  const enhancedPath = path.join(UPLOAD_DIR, `${id}_enhanced.wav`);
  if (!fs.existsSync(enhancedPath)) {
    return res.status(404).json({ error: "Enhanced audio not available — run AI Enhance Audio first" });
  }

  const stat = fs.statSync(enhancedPath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Accept-Ranges": "bytes",
      "Content-Length": chunkSize,
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=3600",
    });
    fs.createReadStream(enhancedPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Accept-Ranges": "bytes",
      "Content-Length": fileSize,
      "Content-Type": "audio/wav",
      "Cache-Control": "public, max-age=3600",
    });
    fs.createReadStream(enhancedPath).pipe(res);
  }
});

// ---------------------------------------------------------------------------
// Get / Delete
// ---------------------------------------------------------------------------
router.get("/videos/:id", async (req, res) => {
  const { id } = GetVideoParams.parse(req.params);
  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id));
  if (!video) return res.status(404).json({ error: "Not found" });
  res.json({ ...video, createdAt: video.createdAt.toISOString() });
});

router.delete("/videos/:id", async (req, res) => {
  const { id } = DeleteVideoParams.parse(req.params);
  const [video] = await db.select().from(videosTable).where(eq(videosTable.id, id));
  if (!video) return res.status(404).json({ error: "Not found" });
  try { fs.unlinkSync(video.filePath); } catch {}
  await db.delete(videosTable).where(eq(videosTable.id, id));
  res.status(204).send();
});

export default router;
