import { Router } from "express";
import { db } from "@workspace/db/client";
import { videos } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);
const router = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/cutai-uploads";
const THUMB_DIR  = process.env.THUMB_DIR  ?? "/tmp/cutai-thumbs";
fs.mkdirSync(THUMB_DIR, { recursive: true });

function thumbPath(videoId: string, t: number): string {
  return path.join(THUMB_DIR, `${videoId}_${Math.round(t * 100)}.jpg`);
}

/**
 * GET /api/videos/:videoId/frames?t=5.0
 * Returns a single JPEG thumbnail frame at time t (seconds).
 * Cached in THUMB_DIR for subsequent requests.
 */
router.get("/api/videos/:videoId/frames", async (req, res) => {
  try {
    const { videoId } = req.params;
    const t = parseFloat((req.query.t as string) ?? "0") || 0;

    const [video] = await db.select().from(videos).where(eq(videos.id, Number(videoId))).limit(1);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const filePath = path.join(UPLOAD_DIR, video.storagePath ?? "");
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    const out = thumbPath(videoId, t);
    if (!fs.existsSync(out)) {
      const cmd = [
        "ffmpeg", "-y",
        "-ss", String(Math.max(0, t)),
        "-i", JSON.stringify(filePath),
        "-vframes", "1",
        "-vf", "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2:black",
        "-q:v", "6",
        "-pix_fmt", "yuv420p",
        JSON.stringify(out),
      ].join(" ");
      await execAsync(cmd).catch(() => null);
    }

    if (!fs.existsSync(out)) return res.status(500).json({ error: "Thumbnail generation failed" });

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(path.resolve(out));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/videos/:videoId/thumbnail.jpg
 * Returns the representative thumbnail (at 10% into clip).
 * Already handled by existing videos route but this catches alternates.
 */
router.get("/api/videos/:videoId/thumbstrip", async (req, res) => {
  try {
    const { videoId } = req.params;
    const count  = Math.min(10, parseInt((req.query.count as string)  ?? "4") || 4);
    const start  = parseFloat((req.query.start as string)  ?? "0")  || 0;
    const end    = parseFloat((req.query.end   as string)  ?? "0");

    const [video] = await db.select().from(videos).where(eq(videos.id, Number(videoId))).limit(1);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const filePath = path.join(UPLOAD_DIR, video.storagePath ?? "");
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

    const duration = end > start ? end - start : (video.durationSeconds ?? 10);
    const times: number[] = [];
    for (let i = 0; i < count; i++) {
      times.push(start + (duration / count) * (i + 0.5));
    }

    const results: { t: number; url: string }[] = [];
    await Promise.all(
      times.map(async (t) => {
        const out = thumbPath(videoId, t);
        if (!fs.existsSync(out)) {
          const cmd = [
            "ffmpeg", "-y",
            "-ss", String(Math.max(0, t)),
            "-i", JSON.stringify(filePath),
            "-vframes", "1",
            "-vf", "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2:black",
            "-q:v", "7",
            "-pix_fmt", "yuv420p",
            JSON.stringify(out),
          ].join(" ");
          await execAsync(cmd).catch(() => null);
        }
        if (fs.existsSync(out)) {
          results.push({ t, url: `/api/videos/${videoId}/frames?t=${t.toFixed(2)}` });
        }
      })
    );

    results.sort((a, b) => a.t - b.t);
    res.json({ videoId, frames: results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
