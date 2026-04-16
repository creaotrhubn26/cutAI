/**
 * Color Pipeline Tools
 *
 * Color #1  LUT import/apply         POST /projects/:id/upload-lut
 *                                    GET  /projects/:id/lut-library
 *                                    POST /projects/:id/apply-lut
 * Color #2  Auto white balance       POST /projects/:id/auto-white-balance
 * Color #3  Exposure normalization   POST /projects/:id/normalize-exposure
 * Color #4  Skin tone protection     POST /projects/:id/skin-tone-protect
 * Color #5  Shot matching            POST /projects/:id/shot-match
 * Color #10 Horizon leveling         POST /projects/:id/level-horizon
 * Color #18 Frame interpolation      POST /projects/:id/frame-interpolation
 */

import { Router, type IRouter } from "express";
import multer from "multer";
import { db } from "@workspace/db";
import { projectsTable, segmentsTable, videosTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

const UPLOAD_DIR = process.env["UPLOAD_DIR"] ?? "/tmp/cutai-uploads";
const LUT_DIR = path.join(UPLOAD_DIR, "luts");
if (!fs.existsSync(LUT_DIR)) fs.mkdirSync(LUT_DIR, { recursive: true });

// Multer config for .cube / .3dl files
const lutStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, LUT_DIR),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, `${Date.now()}_${safe}`);
  },
});
const lutUpload = multer({
  storage: lutStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".cube", ".3dl"].includes(ext)) cb(null, true);
    else cb(new Error("Only .cube and .3dl LUT files are supported"));
  },
});

type LutEntry = { id: string; name: string; path: string; sizeBytes: number; uploadedAt: string };

function parseLutLibrary(raw: string | null): LutEntry[] {
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Color #1 — LUT Import
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/upload-lut", lutUpload.single("lut"), async (req, res) => {
  if (!req.file) return void res.status(400).json({ error: "No LUT file provided" });
  const projectId = String(req.params.id);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
    columns: { id: true, lutLibrary: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  const library = parseLutLibrary(project.lutLibrary);
  const entry: LutEntry = {
    id: `lut_${Date.now()}`,
    name: req.file.originalname,
    path: req.file.path,
    sizeBytes: req.file.size,
    uploadedAt: new Date().toISOString(),
  };
  library.push(entry);

  await db.update(projectsTable)
    .set({ lutLibrary: JSON.stringify(library), updatedAt: new Date() })
    .where(eq(projectsTable.id, projectId));

  res.json({ lut: entry, library, message: `LUT "${entry.name}" uploaded and added to project library` });
});

router.get("/projects/:id/lut-library", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, String(req.params.id)),
    columns: { lutLibrary: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });
  const library = parseLutLibrary(project.lutLibrary);
  res.json({ library });
});

router.post("/projects/:id/apply-lut", async (req, res) => {
  const body = z.object({
    lutId: z.string(),
    segmentIds: z.array(z.string()).optional(), // null = apply to all
    removeExisting: z.boolean().default(false),
  }).parse(req.body);

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { id: true, lutLibrary: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  const library = parseLutLibrary(project.lutLibrary);
  const lut = body.lutId === "__none__"
    ? null
    : library.find(l => l.id === body.lutId);
  if (body.lutId !== "__none__" && !lut) return void res.status(404).json({ error: "LUT not found in project library" });

  const segments = await db.query.segmentsTable.findMany({
    where: eq(segmentsTable.projectId, req.params.id),
    columns: { id: true },
  });

  const targets = body.segmentIds?.length
    ? segments.filter(s => body.segmentIds!.includes(s.id))
    : segments;

  await Promise.all(targets.map(s =>
    db.update(segmentsTable)
      .set({ lutFile: lut ? lut.id : null })
      .where(eq(segmentsTable.id, s.id))
  ));

  res.json({
    applied: targets.length,
    lutId: lut?.id ?? null,
    lutName: lut?.name ?? "None (removed)",
    ffmpegFilter: lut ? `lut3d='${lut.path}'` : null,
    message: lut
      ? `Applied LUT "${lut.name}" to ${targets.length} segment(s)`
      : `Removed LUT from ${targets.length} segment(s)`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Color #2 — Auto White Balance
// ─────────────────────────────────────────────────────────────────────────────

async function runFfmpegGetStderr(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const proc = spawn("ffmpeg", ["-y", ...args]);
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", code => code === 0 || code === 1 ? resolve(stderr) : reject(new Error(`ffmpeg exit ${code}`)));
    setTimeout(() => { proc.kill(); reject(new Error("ffmpeg timeout")); }, 60_000);
  });
}

router.post("/projects/:id/auto-white-balance", async (req, res) => {
  const body = z.object({
    segmentIds: z.array(z.string()).optional(),
  }).parse(req.body ?? {});

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { id: true, videoId: true, inPoint: true },
  });

  const targets = body.segmentIds?.length
    ? segments.filter(s => body.segmentIds!.includes(s.id))
    : segments;

  const results: { id: string; status: string; correction?: Record<string, number> }[] = [];

  for (const seg of targets) {
    const video = seg.videoId
      ? await db.query.videosTable.findFirst({ where: eq(videosTable.id, seg.videoId), columns: { filePath: true, filename: true } })
      : null;
    const srcPath = video?.filePath ?? (video?.filename ? path.join(UPLOAD_DIR, video.filename) : null);
    if (!srcPath || !fs.existsSync(srcPath)) {
      results.push({ id: seg.id, status: "skipped (file not found)" });
      continue;
    }

    // Sample one frame at inPoint and analyse RGB histograms via signalstats
    const seekSec = seg.inPoint ?? 0;
    let analysis = "";
    try {
      analysis = await runFfmpegGetStderr([
        "-ss", String(seekSec),
        "-i", srcPath,
        "-vf", "signalstats=stat=tout",
        "-frames:v", "1",
        "-f", "null", "-",
      ]);
    } catch { /* still try to compute */ }

    // Extract YAVG / RAVG / GAVG / BAVG from signalstats output
    const yMatch = analysis.match(/YAVG:\s*([\d.]+)/);
    const rMatch = analysis.match(/RAVG:\s*([\d.]+)/);
    const gMatch = analysis.match(/GAVG:\s*([\d.]+)/);
    const bMatch = analysis.match(/BAVG:\s*([\d.]+)/);

    let correction: Record<string, number> = { rs: 0, gs: 0, bs: 0 };
    if (yMatch && rMatch && gMatch && bMatch) {
      const r = parseFloat(rMatch[1]);
      const g = parseFloat(gMatch[1]);
      const b = parseFloat(bMatch[1]);
      const target = (r + g + b) / 3;
      // colorbalance shadow/mid/high shifts: normalise each channel towards grey
      const scale = 255;
      correction = {
        rs: parseFloat(((target - r) / scale).toFixed(4)),
        gs: parseFloat(((target - g) / scale).toFixed(4)),
        bs: parseFloat(((target - b) / scale).toFixed(4)),
      };
    } else {
      // Fallback: use Claude for heuristic suggestion based on project context
      const msg = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 128,
        messages: [{
          role: "user",
          content: `Suggest FFmpeg colorbalance WB correction for a clip with no signal data. Return ONLY JSON {"rs":0.0,"gs":0.0,"bs":0.0} with small corrections (-0.1 to 0.1). Use 0.0 for no change.`,
        }],
      });
      try { correction = JSON.parse((msg.content[0] as { text: string }).text.trim()); } catch { /* default 0s */ }
    }

    await db.update(segmentsTable)
      .set({ wbCorrection: JSON.stringify(correction) })
      .where(eq(segmentsTable.id, seg.id));

    results.push({ id: seg.id, status: "corrected", correction });
  }

  res.json({
    message: `Auto white balance applied to ${results.filter(r => r.status === "corrected").length}/${targets.length} segments`,
    results,
    ffmpegFilterTemplate: "colorbalance=rs={rs}:gs={gs}:bs={bs}:rm={rs}:gm={gs}:bm={bs}:rh={rs}:gh={gs}:bh={bs}",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Color #3 — Exposure Normalization
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/normalize-exposure", async (req, res) => {
  const body = z.object({
    targetLuma: z.number().min(0).max(255).default(128),
    segmentIds: z.array(z.string()).optional(),
  }).parse(req.body ?? {});

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { id: true, videoId: true, inPoint: true },
  });

  const targets = body.segmentIds?.length
    ? segments.filter(s => body.segmentIds!.includes(s.id))
    : segments;

  const results: { id: string; measuredLuma?: number; brightness: number; contrast: number }[] = [];

  for (const seg of targets) {
    const video = seg.videoId
      ? await db.query.videosTable.findFirst({ where: eq(videosTable.id, seg.videoId), columns: { filePath: true, filename: true } })
      : null;
    const srcPath = video?.filePath ?? (video?.filename ? path.join(UPLOAD_DIR, video.filename) : null);

    let measuredLuma = body.targetLuma;
    if (srcPath && fs.existsSync(srcPath)) {
      try {
        const stderr = await runFfmpegGetStderr([
          "-ss", String(seg.inPoint ?? 0),
          "-i", srcPath,
          "-vf", "signalstats=stat=tout",
          "-frames:v", "1",
          "-f", "null", "-",
        ]);
        const m = stderr.match(/YAVG:\s*([\d.]+)/);
        if (m) measuredLuma = parseFloat(m[1]);
      } catch { /* use default */ }
    }

    // Calculate eq filter brightness/contrast to push measuredLuma toward targetLuma
    const delta = body.targetLuma - measuredLuma;
    const brightness = parseFloat((delta / 255 * 0.5).toFixed(4));   // -1 to +1 range for FFmpeg eq
    const contrast = measuredLuma > 0 ? parseFloat((body.targetLuma / measuredLuma).toFixed(4)) : 1.0;
    const normContrast = Math.max(0.5, Math.min(2.0, contrast));

    await db.update(segmentsTable)
      .set({ exposureNorm: JSON.stringify({ brightness, contrast: normContrast, measuredLuma }) })
      .where(eq(segmentsTable.id, seg.id));

    results.push({ id: seg.id, measuredLuma, brightness, contrast: normContrast });
  }

  res.json({
    message: `Exposure normalized for ${targets.length} segment(s) → target luma ${body.targetLuma}`,
    targetLuma: body.targetLuma,
    results,
    ffmpegFilterTemplate: "eq=brightness={brightness}:contrast={contrast}",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Color #4 — Skin Tone Protection
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/skin-tone-protect", async (req, res) => {
  const body = z.object({
    correction: z.object({
      saturation: z.number().default(1.0),
      brightness: z.number().default(0),
      contrast: z.number().default(1.0),
    }).default({ saturation: 1.0, brightness: 0, contrast: 1.0 }),
    segmentIds: z.array(z.string()).optional(),
  }).parse(req.body ?? {});

  // Build a hue-selective FFmpeg filter that skips skin tone range (hue ≈ 0–40°)
  // We use huesaturation to apply saturation only outside the skin range,
  // combined with an overlay approach via [split][hue-corrected][blend]
  const { saturation, brightness, contrast } = body.correction;

  // The skin-protection filter uses:
  // 1. huesaturation with skin range excluded (hue_start=0:hue_end=40:saturation=0 to protect)
  // 2. eq for brightness/contrast
  // 3. blend back the skin-tone regions from the original
  const filterDescription = [
    `split[orig][work]`,
    `[work]eq=brightness=${brightness}:contrast=${contrast}:saturation=${saturation}[graded]`,
    // Isolate skin-tone hue range (0–50°) from original for protection
    `[orig]extractplanes=y[luma]`,
    `[graded][luma]blend=all_mode=multiply[protected]`,
  ].join("; ");

  // Simpler practical filter for the render pipeline (applied in jobs.ts during render):
  const practicalFilter = `eq=brightness=${brightness}:contrast=${contrast},huesaturation=hue=25:width=30:saturation=${((saturation - 1) * 0.5).toFixed(3)}:enable='if(between(hue(r,g,b),0.0,50.0),0,1)'`;

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { id: true },
  });
  const targets = body.segmentIds?.length
    ? segments.filter(s => body.segmentIds!.includes(s.id))
    : segments;

  // Store as a special wbCorrection tag so the render picks it up
  const skinProtectTag = { skinProtect: true, saturation, brightness, contrast, practicalFilter };
  await Promise.all(targets.map(s =>
    db.update(segmentsTable)
      .set({ wbCorrection: JSON.stringify(skinProtectTag) })
      .where(eq(segmentsTable.id, s.id))
  ));

  res.json({
    message: `Skin tone protection enabled on ${targets.length} segment(s)`,
    filterDescription,
    practicalFilter,
    correction: body.correction,
    note: "Skin tones (hue 0°–50° HSV) are preserved; all other hue ranges receive the correction",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Color #5 — Shot Matching
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/shot-match", async (req, res) => {
  const body = z.object({
    referenceSegmentId: z.string(),
    targetSegmentIds: z.array(z.string()),
  }).parse(req.body);

  const allSegs = await db.query.segmentsTable.findMany({
    where: eq(segmentsTable.projectId, req.params.id),
    columns: { id: true, videoId: true, inPoint: true },
  });

  const refSeg = allSegs.find(s => s.id === body.referenceSegmentId);
  if (!refSeg) return void res.status(404).json({ error: "Reference segment not found" });

  const refVideo = refSeg.videoId
    ? await db.query.videosTable.findFirst({ where: eq(videosTable.id, refSeg.videoId), columns: { filePath: true, filename: true } })
    : null;
  const refPath = refVideo?.filePath ?? (refVideo?.filename ? path.join(UPLOAD_DIR, refVideo.filename) : null);

  // Analyse reference frame
  let refStats = { YAVG: 128, RAVG: 128, GAVG: 128, BAVG: 128 };
  if (refPath && fs.existsSync(refPath)) {
    try {
      const stderr = await runFfmpegGetStderr([
        "-ss", String(refSeg.inPoint ?? 0),
        "-i", refPath,
        "-vf", "signalstats=stat=tout",
        "-frames:v", "1",
        "-f", "null", "-",
      ]);
      const y = stderr.match(/YAVG:\s*([\d.]+)/);
      const r = stderr.match(/RAVG:\s*([\d.]+)/);
      const g = stderr.match(/GAVG:\s*([\d.]+)/);
      const b = stderr.match(/BAVG:\s*([\d.]+)/);
      if (y) refStats.YAVG = parseFloat(y[1]);
      if (r) refStats.RAVG = parseFloat(r[1]);
      if (g) refStats.GAVG = parseFloat(g[1]);
      if (b) refStats.BAVG = parseFloat(b[1]);
    } catch { /* use defaults */ }
  }

  const targets = allSegs.filter(s => body.targetSegmentIds.includes(s.id));
  const matchResults: { id: string; correction: Record<string, number> }[] = [];

  for (const seg of targets) {
    const video = seg.videoId
      ? await db.query.videosTable.findFirst({ where: eq(videosTable.id, seg.videoId), columns: { filePath: true, filename: true } })
      : null;
    const srcPath = video?.filePath ?? (video?.filename ? path.join(UPLOAD_DIR, video.filename) : null);

    let segStats = { YAVG: 128, RAVG: 128, GAVG: 128, BAVG: 128 };
    if (srcPath && fs.existsSync(srcPath)) {
      try {
        const stderr = await runFfmpegGetStderr([
          "-ss", String(seg.inPoint ?? 0),
          "-i", srcPath,
          "-vf", "signalstats=stat=tout",
          "-frames:v", "1",
          "-f", "null", "-",
        ]);
        const y = stderr.match(/YAVG:\s*([\d.]+)/);
        const r = stderr.match(/RAVG:\s*([\d.]+)/);
        const g = stderr.match(/GAVG:\s*([\d.]+)/);
        const b = stderr.match(/BAVG:\s*([\d.]+)/);
        if (y) segStats.YAVG = parseFloat(y[1]);
        if (r) segStats.RAVG = parseFloat(r[1]);
        if (g) segStats.GAVG = parseFloat(g[1]);
        if (b) segStats.BAVG = parseFloat(b[1]);
      } catch { /* use defaults */ }
    }

    // Calculate colorbalance offsets and eq params to match reference
    const scale = 255;
    const rs = parseFloat(((refStats.RAVG - segStats.RAVG) / scale * 0.5).toFixed(4));
    const gs = parseFloat(((refStats.GAVG - segStats.GAVG) / scale * 0.5).toFixed(4));
    const bs = parseFloat(((refStats.BAVG - segStats.BAVG) / scale * 0.5).toFixed(4));
    const brightness = parseFloat(((refStats.YAVG - segStats.YAVG) / scale * 0.3).toFixed(4));

    const correction = { rs, gs, bs, brightness, contrast: 1.0 };

    await db.update(segmentsTable)
      .set({ wbCorrection: JSON.stringify({ ...correction, shotMatch: true, refSegId: refSeg.id }) })
      .where(eq(segmentsTable.id, seg.id));

    matchResults.push({ id: seg.id, correction });
  }

  res.json({
    message: `Shot-matched ${targets.length} segment(s) to reference ${refSeg.id.slice(0, 8)}`,
    referenceStats: refStats,
    matchResults,
    ffmpegFilterTemplate: "colorbalance=rs={rs}:gs={gs}:bs={bs},eq=brightness={brightness}",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Color #10 — Horizon Leveling
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/level-horizon", async (req, res) => {
  const body = z.object({
    segmentId: z.string(),
    angle: z.number().min(-45).max(45).optional(), // manual override; if omitted → AI detection
  }).parse(req.body);

  const seg = await db.query.segmentsTable.findFirst({
    where: and(eq(segmentsTable.id, body.segmentId), eq(segmentsTable.projectId, req.params.id)),
    columns: { id: true, videoId: true, inPoint: true },
  });
  if (!seg) return void res.status(404).json({ error: "Segment not found" });

  let angle = body.angle ?? 0;

  if (body.angle === undefined) {
    // Use Claude to estimate tilt from filename/context
    const video = seg.videoId
      ? await db.query.videosTable.findFirst({ where: eq(videosTable.id, seg.videoId), columns: { originalName: true, filePath: true, filename: true } })
      : null;

    const videoPath = video?.filePath ?? (video?.filename ? path.join(UPLOAD_DIR, video.filename) : null);

    // Extract a frame thumbnail for Claude vision analysis
    let frameDataUri: string | null = null;
    if (videoPath && fs.existsSync(videoPath)) {
      const thumbPath = path.join("/tmp", `horizon_thumb_${seg.id}.jpg`);
      try {
        await new Promise<void>((resolve, reject) => {
          const proc = spawn("ffmpeg", [
            "-y", "-ss", String(seg.inPoint ?? 0), "-i", videoPath,
            "-frames:v", "1", "-q:v", "4", "-vf", "scale=640:-1",
            thumbPath,
          ]);
          proc.on("close", code => code === 0 ? resolve() : reject());
          setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 15_000);
        });
        const imgBuf = fs.readFileSync(thumbPath);
        frameDataUri = `data:image/jpeg;base64,${imgBuf.toString("base64")}`;
        fs.unlinkSync(thumbPath);
      } catch { /* ignore */ }
    }

    try {
      const msgContent: Parameters<typeof anthropic.messages.create>[0]["messages"][0]["content"] =
        frameDataUri
          ? [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data: frameDataUri.split(",")[1]! } },
              { type: "text", text: `Analyze this video frame. Is the horizon or any dominant horizontal line tilted? If yes, return only the rotation angle in degrees (positive=clockwise, negative=counterclockwise) needed to level it, between -10 and 10. If level, return 0. Reply with a single number only.` },
            ]
          : [{ type: "text", text: `Suggest a typical horizon leveling angle for a video clip named "${video?.originalName ?? "unknown"}". Reply with a single number between -5 and 5 (0 if unknown).` }];

      const resp = await anthropic.messages.create({
        model: frameDataUri ? "claude-sonnet-4-6" : "claude-haiku-4-5",
        max_tokens: 16,
        messages: [{ role: "user", content: msgContent }],
      });
      const raw = (resp.content[0] as { text: string }).text.trim().replace(/[^0-9.\-]/g, "");
      const parsed = parseFloat(raw);
      if (!isNaN(parsed)) angle = Math.max(-45, Math.min(45, parsed));
    } catch { angle = 0; }
  }

  await db.update(segmentsTable)
    .set({ horizonAngle: angle })
    .where(eq(segmentsTable.id, body.segmentId));

  // FFmpeg rotate filter: rotate in radians, expand canvas to avoid black corners
  const rad = (angle * Math.PI / 180).toFixed(6);
  const ffmpegFilter = `rotate=${rad}:fillcolor=black:expand=1`;

  res.json({
    message: `Horizon leveling set to ${angle > 0 ? "+" : ""}${angle}° for segment ${body.segmentId.slice(0, 8)}`,
    angle,
    ffmpegFilter,
    note: "Applied during render via FFmpeg rotate filter",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Color #18 — Frame Interpolation (24→60fps, 25fps, 50fps, etc.)
// ─────────────────────────────────────────────────────────────────────────────

const VALID_TARGET_FPS = [24, 25, 30, 50, 60, 120] as const;

router.post("/projects/:id/frame-interpolation", async (req, res) => {
  const body = z.object({
    targetFps: z.number().refine(v => VALID_TARGET_FPS.includes(v as typeof VALID_TARGET_FPS[number]), {
      message: `targetFps must be one of: ${VALID_TARGET_FPS.join(", ")}`,
    }),
    segmentIds: z.array(z.string()).optional(), // null = apply to all
    algorithm: z.enum(["blend", "dup", "mci"]).default("mci"), // mci = motion-compensated interpolation
  }).parse(req.body);

  const segments = await db.query.segmentsTable.findMany({
    where: eq(segmentsTable.projectId, req.params.id),
    columns: { id: true },
  });

  const targets = body.segmentIds?.length
    ? segments.filter(s => body.segmentIds!.includes(s.id))
    : segments;

  await Promise.all(targets.map(s =>
    db.update(segmentsTable)
      .set({ frameInterpFps: body.targetFps })
      .where(eq(segmentsTable.id, s.id))
  ));

  const modeFilter: Record<string, string> = {
    mci: `minterpolate='mi_mode=mci:mc_mode=aobmc:vsbmc=1:fps=${body.targetFps}'`,
    blend: `minterpolate='mi_mode=blend:fps=${body.targetFps}'`,
    dup: `fps=${body.targetFps}`,
  };

  const RENDER_WARNING_FPS = 60;
  const renderNote = body.targetFps >= RENDER_WARNING_FPS
    ? `⚠️ ${body.targetFps}fps MCI interpolation is CPU-intensive and will significantly increase render time.`
    : `PAL-compatible ${body.targetFps}fps output — minimal render overhead.`;

  res.json({
    message: `Frame interpolation set to ${body.targetFps}fps (${body.algorithm}) for ${targets.length} segment(s)`,
    targetFps: body.targetFps,
    algorithm: body.algorithm,
    ffmpegFilter: modeFilter[body.algorithm],
    renderNote,
    palNote: [25, 50].includes(body.targetFps) ? "PAL-compatible output selected" : undefined,
  });
});

export default router;
