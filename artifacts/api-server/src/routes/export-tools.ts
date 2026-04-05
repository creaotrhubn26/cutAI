/**
 * Advanced Export Tools
 *
 * Export #2  Batch export (16:9 / 9:16 / 1:1) POST /projects/:id/batch-export
 * Export #19 Mezzanine ProRes 422 HQ           POST /projects/:id/mezzanine-export
 * Export #20 YouTube auto-fill metadata         POST /projects/:id/generate-youtube-metadata
 *            (YouTube upload itself is in youtube.ts)
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { projectsTable, segmentsTable, videosTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

const RENDER_DIR = process.env["RENDER_DIR"] ?? "/tmp/cutai-renders";
const UPLOAD_DIR = process.env["UPLOAD_DIR"] ?? "/tmp/cutai-uploads";

if (!fs.existsSync(RENDER_DIR)) fs.mkdirSync(RENDER_DIR, { recursive: true });

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const proc = spawn("ffmpeg", ["-y", ...args]);
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`)));
    setTimeout(() => { proc.kill(); reject(new Error("ffmpeg timeout")); }, 1_800_000); // 30 min
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Export #2 — Batch Export (16:9, 9:16, 1:1 simultaneously)
// ─────────────────────────────────────────────────────────────────────────────

const ASPECT_CONFIGS: Record<string, {
  label: string; vfSuffix: string; width: number; height: number;
}> = {
  "16:9":  { label: "Landscape",  vfSuffix: "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2", width: 1920, height: 1080 },
  "9:16":  { label: "Portrait",   vfSuffix: "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2", width: 1080, height: 1920 },
  "1:1":   { label: "Square",     vfSuffix: "scale=1080:1080:force_original_aspect_ratio=decrease,pad=1080:1080:(ow-iw)/2:(oh-ih)/2", width: 1080, height: 1080 },
  "4:5":   { label: "Instagram",  vfSuffix: "scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2", width: 1080, height: 1350 },
};

router.post("/projects/:id/batch-export", async (req, res) => {
  const body = z.object({
    aspectRatios: z.array(z.enum(["16:9", "9:16", "1:1", "4:5"])).default(["16:9", "9:16", "1:1"]),
    crf: z.number().min(15).max(35).default(23),
    codec: z.enum(["h264", "h265"]).default("h264"),
  }).parse(req.body ?? {});

  const renderPath = path.join(RENDER_DIR, `${req.params.id}.mp4`);
  if (!fs.existsSync(renderPath)) {
    return void res.status(422).json({
      error: "Rendered MP4 not found. Please render the project first.",
      renderRequired: true,
    });
  }

  const codec = body.codec === "h265" ? "libx265" : "libx264";
  const batchDir = path.join(RENDER_DIR, "batch", req.params.id);
  if (!fs.existsSync(batchDir)) fs.mkdirSync(batchDir, { recursive: true });

  const jobResults = await Promise.allSettled(
    body.aspectRatios.map(async ar => {
      const cfg = ASPECT_CONFIGS[ar];
      const outPath = path.join(batchDir, `${ar.replace(":", "x")}.mp4`);
      await runFfmpeg([
        "-i", renderPath,
        "-vf", cfg.vfSuffix,
        "-c:v", codec,
        "-crf", String(body.crf),
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", "192k",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        outPath,
      ]);
      return { ar, label: cfg.label, path: outPath, width: cfg.width, height: cfg.height,
        sizeBytes: fs.existsSync(outPath) ? fs.statSync(outPath).size : 0 };
    })
  );

  const outputs = jobResults.map((r, i) => {
    const ar = body.aspectRatios[i]!;
    const cfg = ASPECT_CONFIGS[ar];
    if (r.status === "fulfilled") {
      return {
        aspectRatio: ar, label: cfg.label,
        status: "ready",
        downloadUrl: `/api/projects/${req.params.id}/batch-export/${ar.replace(":", "x")}/download`,
        sizeBytes: r.value.sizeBytes,
        width: cfg.width, height: cfg.height,
      };
    }
    return { aspectRatio: ar, label: cfg.label, status: "error", error: (r.reason as Error).message };
  });

  await db.update(projectsTable)
    .set({ batchExportConfig: JSON.stringify({ lastBatch: new Date().toISOString(), aspectRatios: body.aspectRatios, codec: body.codec }), updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id));

  res.json({ outputs, message: `Batch export: ${outputs.filter(o => o.status === "ready").length}/${body.aspectRatios.length} completed` });
});

router.get("/projects/:id/batch-export/:aspect/download", (req, res) => {
  const { id, aspect } = req.params;
  const safeAspect = aspect.replace(/[^0-9x]/g, "");
  const filePath = path.join(RENDER_DIR, "batch", id, `${safeAspect}.mp4`);
  if (!fs.existsSync(filePath)) return void res.status(404).json({ error: "Export not found. Run batch-export first." });
  const label = safeAspect.replace("x", ":");
  res.setHeader("Content-Disposition", `attachment; filename="${id.slice(0, 8)}_${label.replace(":", "x")}.mp4"`);
  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(filePath).pipe(res);
});

// ─────────────────────────────────────────────────────────────────────────────
// Export #19 — Mezzanine Export (ProRes 422 HQ)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/mezzanine-export", async (req, res) => {
  const body = z.object({
    profile: z.enum(["proxy", "lt", "standard", "hq", "4444"]).default("hq"),
  }).parse(req.body ?? {});

  const renderPath = path.join(RENDER_DIR, `${req.params.id}.mp4`);
  if (!fs.existsSync(renderPath)) {
    return void res.status(422).json({
      error: "Rendered MP4 not found. Please render the project first.",
      renderRequired: true,
    });
  }

  // ProRes profiles: 0=proxy, 1=lt, 2=standard, 3=hq, 4=4444
  const profileMap: Record<string, number> = { proxy: 0, lt: 1, standard: 2, hq: 3, "4444": 4 };
  const profileIndex = profileMap[body.profile];

  const mezzDir = path.join(RENDER_DIR, "mezzanine");
  if (!fs.existsSync(mezzDir)) fs.mkdirSync(mezzDir, { recursive: true });
  const outPath = path.join(mezzDir, `${req.params.id}_prores${profileIndex}.mov`);

  try {
    await runFfmpeg([
      "-i", renderPath,
      "-c:v", "prores_ks",
      "-profile:v", String(profileIndex),
      "-vendor", "apl0",
      "-bits_per_mb", "8000",
      "-c:a", "pcm_s16le",  // uncompressed audio
      outPath,
    ]);
  } catch (e) {
    // Fallback: try prores (older, widely-compatible)
    try {
      await runFfmpeg([
        "-i", renderPath,
        "-c:v", "prores",
        "-profile:v", String(profileIndex),
        "-c:a", "pcm_s16le",
        outPath,
      ]);
    } catch (e2) {
      return void res.status(500).json({ error: "ProRes encode failed. FFmpeg may not support prores on this system.", detail: String(e2) });
    }
  }

  const sizeBytes = fs.existsSync(outPath) ? fs.statSync(outPath).size : 0;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(1);

  res.json({
    status: "ready",
    profile: body.profile,
    profileIndex,
    sizeBytes,
    sizeMB: `${sizeMB} MB`,
    downloadUrl: `/api/projects/${req.params.id}/mezzanine-export/download`,
    codec: "prores_ks",
    audioCodec: "pcm_s16le (uncompressed)",
    message: `ProRes 422 ${body.profile.toUpperCase()} archive ready — ${sizeMB} MB`,
  });
});

router.get("/projects/:id/mezzanine-export/download", (req, res) => {
  const mezzDir = path.join(RENDER_DIR, "mezzanine");
  const files = fs.existsSync(mezzDir)
    ? fs.readdirSync(mezzDir).filter(f => f.startsWith(req.params.id) && f.endsWith(".mov"))
    : [];
  if (!files.length) return void res.status(404).json({ error: "Mezzanine not found. Run mezzanine-export first." });
  const filePath = path.join(mezzDir, files[files.length - 1]!);
  res.setHeader("Content-Disposition", `attachment; filename="${req.params.id.slice(0, 8)}_prores.mov"`);
  res.setHeader("Content-Type", "video/quicktime");
  fs.createReadStream(filePath).pipe(res);
});

// ─────────────────────────────────────────────────────────────────────────────
// Export #20 — Auto-generate YouTube title + description from transcript
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/generate-youtube-metadata", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { id: true, name: true, description: true, genrePreset: true, platformPacingTarget: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { transcript: true, orderIndex: true },
  });

  const transcriptBlob = segments
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
    .map(s => s.transcript ?? "")
    .filter(Boolean)
    .join(" ")
    .slice(0, 3000);

  const prompt = `You are a YouTube SEO expert. Given this video info, write an optimized YouTube title and description.

Project name: "${project.name}"
Genre/style: ${project.genrePreset ?? "general"}
Platform: ${project.platformPacingTarget ?? "youtube"}
Transcript excerpt: "${transcriptBlob || "(no transcript available)"}"

Return ONLY valid JSON:
{
  "title": "compelling SEO-optimized title under 70 chars",
  "description": "3-4 paragraph YouTube description with timestamps section, relevant hashtags, and CTA. Under 500 words.",
  "tags": ["array", "of", "10", "relevant", "tags"],
  "categoryId": "22",
  "suggestedPrivacy": "public"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  let metadata: Record<string, unknown> = {};
  try {
    const raw = (msg.content[0] as { text: string }).text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) metadata = JSON.parse(jsonMatch[0]);
  } catch {
    metadata = {
      title: project.name,
      description: `${project.name}\n\nEdited with CutAI — AI-powered video editor.`,
      tags: ["video", "CutAI"],
      categoryId: "22",
      suggestedPrivacy: "unlisted",
    };
  }

  res.json({
    metadata,
    projectId: req.params.id,
    message: "YouTube metadata generated from transcript and project context",
    note: "Pass this as the body to POST /api/projects/:id/upload-to-youtube",
  });
});

export default router;
