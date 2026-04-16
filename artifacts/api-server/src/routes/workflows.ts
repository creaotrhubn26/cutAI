/**
 * Dual End-to-End Video Workflows
 *
 * Two professional editing "personalities" the user can trigger with one
 * click after uploading footage. Claude reads the video visually (keyframes
 * sent to Claude Vision) AND reads the transcript, then produces a finished
 * MP4 in the preset's aspect ratio.
 *
 *   POST /projects/:id/workflows/run      start an E2E workflow
 *   GET  /projects/:id/workflows/status   latest run status + download URL
 *   GET  /workflows/presets               list of presets with descriptions
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { db } from "@workspace/db";
import { jobsTable, projectsTable, videosTable, activityTable } from "@workspace/db";
import { and, eq, desc } from "drizzle-orm";
import { runJobAsync } from "./jobs";

const RENDER_DIR = process.env.RENDER_DIR ?? "/tmp/cutai-renders";

type PresetKey = "fast_social_cut" | "cinematic_story";

interface PresetInfo {
  id: PresetKey;
  label: string;
  subtitle: string;
  targetFormat: string;
  renderFormat: "vertical" | "landscape";
  targetDurationSec: number;
  tone: string;
  pacing: string;
  editingConcept: string;
  whenToPick: string;
}

const PRESETS: Record<PresetKey, PresetInfo> = {
  fast_social_cut: {
    id: "fast_social_cut",
    label: "Fast Social Cut",
    subtitle: "Hook-first vertical short",
    targetFormat: "instagram_reel",
    renderFormat: "vertical",
    targetDurationSec: 45,
    tone: "dynamic",
    pacing: "fast",
    editingConcept:
      "Lead with the single strongest hook moment (0–3s). Tight, speech-driven " +
      "cuts with visual B-roll inserts. End on a clear payoff. Every cut earns " +
      "its place — if a shot doesn't advance attention or tension, it's gone.",
    whenToPick:
      "Reels, TikTok, YouTube Shorts, ads. Interviews, product demos, recaps.",
  },
  cinematic_story: {
    id: "cinematic_story",
    label: "Cinematic Story",
    subtitle: "Emotional highlight with arc",
    targetFormat: "wedding_highlight",
    renderFormat: "landscape",
    targetDurationSec: 180,
    tone: "emotional",
    pacing: "medium",
    editingConcept:
      "Tell a real story: hook → buildup → climax → resolution. Let moments " +
      "breathe, match-cut on motion, sync emotional peaks to music. Claude " +
      "protects the 2–3 most powerful shots and builds around them.",
    whenToPick:
      "Weddings, travel films, brand stories, recaps, YouTube long-form openers.",
  },
};

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────
// GET /workflows/presets
// ─────────────────────────────────────────────────────────────────────────
router.get("/workflows/presets", (_req, res) => {
  res.json({
    presets: Object.values(PRESETS),
    concept:
      "Upload your footage. Claude watches the video (Claude Vision on " +
      "sampled keyframes) AND reads the transcript, then edits end-to-end. " +
      "Pick one of two editing personalities — the rest is automatic.",
  });
});

// ─────────────────────────────────────────────────────────────────────────
// POST /projects/:id/workflows/run
//
// Body:
//   { preset: "fast_social_cut" | "cinematic_story",
//     storyPrefs?: { tone?, focus?, pacing?, targetDuration?, storyStyle? } }
//
// Creates a parent job of type `e2e_workflow` and starts it in the
// background. Returns the job id immediately so the UI can subscribe to
// /jobs/:id/stream.
// ─────────────────────────────────────────────────────────────────────────
router.post("/projects/:id/workflows/run", async (req, res) => {
  const body = z.object({
    preset: z.enum(["fast_social_cut", "cinematic_story"]),
    storyPrefs: z.object({
      tone: z.string().optional(),
      focus: z.string().optional(),
      pacing: z.string().optional(),
      targetDuration: z.number().positive().max(1800).optional(),
      storyStyle: z.string().max(500).optional(),
      speakerFocus: z.string().max(200).optional(),
    }).optional(),
  }).parse(req.body);

  const projectId = req.params.id;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const projectVideos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
  if (projectVideos.length === 0) {
    return res.status(400).json({
      error: "Upload at least one video before running a workflow.",
    });
  }

  // Prevent concurrent runs on the same project
  const inflight = await db.select().from(jobsTable)
    .where(and(
      eq(jobsTable.projectId, projectId),
      eq(jobsTable.type, "e2e_workflow"),
      eq(jobsTable.status, "running"),
    ));
  if (inflight.length > 0) {
    return res.status(409).json({
      error: "An E2E workflow is already running for this project.",
      jobId: inflight[0].id,
    });
  }

  const jobId = randomUUID();
  const opts = { preset: body.preset, storyPrefs: body.storyPrefs ?? null };
  const optsStr = JSON.stringify(opts);

  const [job] = await db.insert(jobsTable).values({
    id: jobId,
    projectId,
    videoId: null,
    type: "e2e_workflow",
    status: "pending",
    progress: 0,
    logLines: "[]",
    options: optsStr,
  }).returning();

  await db.insert(activityTable).values({
    id: randomUUID(),
    type: "ai_analysis_done",
    description: `Started ${PRESETS[body.preset].label} E2E workflow`,
    projectId,
    projectName: project.name,
  });

  // Run async — do not await
  runJobAsync(jobId, projectId, null, "e2e_workflow", optsStr).catch((err) => {
    console.error("[e2e_workflow] background error:", err);
  });

  res.status(201).json({
    jobId: job.id,
    preset: body.preset,
    presetInfo: PRESETS[body.preset],
    statusUrl: `/api/jobs/${job.id}`,
    streamUrl: `/api/jobs/${job.id}/stream`,
    willProduce: {
      renderFormat: PRESETS[body.preset].renderFormat,
      targetDurationSec: PRESETS[body.preset].targetDurationSec,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────
// GET /projects/:id/workflows/status
//
// Returns the most recent E2E workflow job for this project, plus a
// concise stage breakdown the UI can render as a timeline.
// ─────────────────────────────────────────────────────────────────────────
router.get("/projects/:id/workflows/status", async (req, res) => {
  const projectId = req.params.id;

  const [latest] = await db.select().from(jobsTable)
    .where(and(eq(jobsTable.projectId, projectId), eq(jobsTable.type, "e2e_workflow")))
    .orderBy(desc(jobsTable.createdAt))
    .limit(1);

  if (!latest) return res.json({ hasRun: false });

  const parsedOpts = (() => { try { return JSON.parse(latest.options ?? "{}"); } catch { return {}; } })();
  const preset = (parsedOpts.preset as PresetKey | undefined) ?? "fast_social_cut";
  const presetInfo = PRESETS[preset];

  // Derive per-step progress from the log lines to drive a pretty UI
  const logs: string[] = (() => { try { return JSON.parse(latest.logLines ?? "[]"); } catch { return []; } })();
  const stages = [
    { id: "transcribe",         label: "Transcribe",            match: /Step 1\/5/i,              pct: 20 },
    { id: "visual_scan",        label: "Visual Scan (Claude)",  match: /Step 2\/5/i,              pct: 45 },
    { id: "generate_edit_plan", label: "Edit Plan",             match: /Step 3\/5/i,              pct: 72 },
    { id: "apply_edit",         label: "Apply Edit",            match: /Step 4\/5/i,              pct: 80 },
    { id: "render",             label: "Render",                match: /Step 5\/5/i,              pct: 97 },
  ];
  const logJoined = logs.join("\n");
  const stagesWithStatus = stages.map((s, i) => {
    const seen = s.match.test(logJoined);
    const next = stages[i + 1];
    const done = next ? next.match.test(logJoined) : latest.status === "completed";
    const status =
      latest.status === "failed" && seen && !done ? "failed" :
      !seen ? "pending" :
      done ? "completed" :
      "running";
    return { ...s, status };
  });

  // Render status / download URL
  const renderPath = path.join(RENDER_DIR, `${projectId}.mp4`);
  const renderReady = fs.existsSync(renderPath);

  res.json({
    hasRun: true,
    preset,
    presetInfo,
    job: {
      id: latest.id,
      status: latest.status,
      progress: latest.progress,
      errorMessage: latest.errorMessage ?? null,
      createdAt: latest.createdAt.toISOString(),
      startedAt: latest.startedAt?.toISOString() ?? null,
      completedAt: latest.completedAt?.toISOString() ?? null,
      streamUrl: `/api/jobs/${latest.id}/stream`,
    },
    stages: stagesWithStatus,
    renderReady,
    downloadUrl: renderReady ? `/api/projects/${projectId}/render.mp4` : null,
  });
});

export default router;
