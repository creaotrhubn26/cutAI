import { Router, type IRouter, type Request, type Response } from "express";
import { db, videosTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);
const router: IRouter = Router();

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? "/tmp/cutai-uploads";
const THUMB_DIR  = process.env.THUMB_DIR  ?? "/tmp/cutai-thumbs";
fs.mkdirSync(THUMB_DIR, { recursive: true });

function thumbPath(videoId: string, t: number): string {
  return path.join(THUMB_DIR, `${videoId}_${Math.round(t * 100)}.jpg`);
}

/**
 * GET /videos/:videoId/frames?t=5.0
 * Returns a single JPEG thumbnail frame at time t (seconds).
 * Cached in THUMB_DIR for subsequent requests.
 */
router.get("/videos/:videoId/frames", async (req: Request, res: Response) => {
  try {
    const videoId = String(req.params.videoId);
    const t = parseFloat((req.query.t as string) ?? "0") || 0;

    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
    if (!video) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

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

    if (!fs.existsSync(out)) {
      res.status(500).json({ error: "Thumbnail generation failed" });
      return;
    }

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(path.resolve(out));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

/**
 * GET /videos/:videoId/thumbstrip
 * Returns N evenly-spaced thumbnail frames for a scrubbing strip.
 */
router.get("/videos/:videoId/thumbstrip", async (req: Request, res: Response) => {
  try {
    const videoId = String(req.params.videoId);
    const count  = Math.min(10, parseInt((req.query.count as string) ?? "4") || 4);
    const start  = parseFloat((req.query.start as string) ?? "0") || 0;
    const end    = parseFloat((req.query.end   as string) ?? "0");

    const [video] = await db.select().from(videosTable).where(eq(videosTable.id, videoId)).limit(1);
    if (!video) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    const filePath = video.filePath ?? path.join(UPLOAD_DIR, video.filename);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "File not found" });
      return;
    }

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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

export default router;
