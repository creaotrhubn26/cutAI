/**
 * AI Edit Intelligence routes — features #1–#10
 *
 * #1  Edit style cloning       POST /style-profiles/:id/clone-from-project
 * #2  Pacing envelope          POST/GET /projects/:id/pacing-envelope
 * #3  Genre preset             POST /projects/:id/genre-preset
 * #4  Story arc enforcement    POST /projects/:id/assign-story-arc
 * #5  Re-edit from feedback    POST /projects/:id/redit-from-feedback
 * #6  Cut point heat map       GET  /projects/:id/cut-heatmap
 * #7  Confidence visualization GET  /projects/:id/confidence-report
 * #8  Edit diversity guard     POST /projects/:id/diversity-check
 * #9  Platform-optimized pacing POST /projects/:id/platform-pace
 * #10 Dialogue-driven B-roll   POST /projects/:id/dialogue-broll
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  projectsTable, segmentsTable, videosTable,
  styleProfilesTable, jobsTable,
} from "@workspace/db";
import { eq, and, asc, desc, inArray } from "drizzle-orm";
import { z } from "zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

// ── Genre preset pacing rules ─────────────────────────────────────────────
const GENRE_PRESETS: Record<string, {
  label: string;
  description: string;
  targetCutSec: number;
  minClipSec: number;
  maxClipSec: number;
  hookDuration: number;
  preferredCutType: string;
  transitionStyle: string;
  pacingEnvelope: Array<{ zone: string; fraction: number; pace: string; targetCutSec: number }>;
}> = {
  documentary: {
    label: "Documentary",
    description: "Slow, interview-led, natural pacing. Let subjects breathe. Wide establishing shots.",
    targetCutSec: 12,
    minClipSec: 4,
    maxClipSec: 30,
    hookDuration: 8,
    preferredCutType: "hard-cut",
    transitionStyle: "cut",
    pacingEnvelope: [
      { zone: "open",    fraction: 0.10, pace: "slow",   targetCutSec: 15 },
      { zone: "body",    fraction: 0.80, pace: "normal", targetCutSec: 12 },
      { zone: "close",   fraction: 0.10, pace: "slow",   targetCutSec: 14 },
    ],
  },
  tutorial: {
    label: "Tutorial",
    description: "Clear, step-by-step, medium pacing. Each step gets its own clip. J-cuts for narration.",
    targetCutSec: 7,
    minClipSec: 2,
    maxClipSec: 20,
    hookDuration: 5,
    preferredCutType: "j-cut",
    transitionStyle: "cut",
    pacingEnvelope: [
      { zone: "hook",    fraction: 0.05, pace: "fast",   targetCutSec: 3  },
      { zone: "intro",   fraction: 0.10, pace: "normal", targetCutSec: 6  },
      { zone: "steps",   fraction: 0.75, pace: "normal", targetCutSec: 7  },
      { zone: "outro",   fraction: 0.10, pace: "slow",   targetCutSec: 10 },
    ],
  },
  vlog: {
    label: "Vlog",
    description: "Casual, conversational, fast-paced. Tight cuts on speech. B-roll heavy.",
    targetCutSec: 4,
    minClipSec: 1.5,
    maxClipSec: 10,
    hookDuration: 3,
    preferredCutType: "hard-cut",
    transitionStyle: "cut",
    pacingEnvelope: [
      { zone: "hook",    fraction: 0.08, pace: "fast",   targetCutSec: 2  },
      { zone: "content", fraction: 0.82, pace: "fast",   targetCutSec: 4  },
      { zone: "outro",   fraction: 0.10, pace: "normal", targetCutSec: 5  },
    ],
  },
  ad: {
    label: "Ad Spot",
    description: "Punchy, emotional pull, strong CTA. Fast-cut with deliberate slow moments for impact.",
    targetCutSec: 2.5,
    minClipSec: 0.5,
    maxClipSec: 6,
    hookDuration: 1.5,
    preferredCutType: "match-cut",
    transitionStyle: "cut",
    pacingEnvelope: [
      { zone: "hook",    fraction: 0.10, pace: "fast",   targetCutSec: 1.5 },
      { zone: "problem", fraction: 0.30, pace: "normal", targetCutSec: 3   },
      { zone: "solution",fraction: 0.40, pace: "fast",   targetCutSec: 2   },
      { zone: "cta",     fraction: 0.20, pace: "slow",   targetCutSec: 4   },
    ],
  },
  short_film: {
    label: "Short Film",
    description: "Cinematic, story-driven. Slow establishing shots. Music-driven emotional beats.",
    targetCutSec: 8,
    minClipSec: 2,
    maxClipSec: 25,
    hookDuration: 6,
    preferredCutType: "l-cut",
    transitionStyle: "dissolve",
    pacingEnvelope: [
      { zone: "act1",    fraction: 0.25, pace: "slow",   targetCutSec: 12 },
      { zone: "act2a",   fraction: 0.25, pace: "normal", targetCutSec: 8  },
      { zone: "act2b",   fraction: 0.30, pace: "fast",   targetCutSec: 5  },
      { zone: "act3",    fraction: 0.20, pace: "slow",   targetCutSec: 10 },
    ],
  },
  social_media: {
    label: "Social Media",
    description: "Ultra-fast, hook in first second. Designed for 15-60s scroll-stopping content.",
    targetCutSec: 2.3,
    minClipSec: 0.5,
    maxClipSec: 4,
    hookDuration: 1,
    preferredCutType: "hard-cut",
    transitionStyle: "cut",
    pacingEnvelope: [
      { zone: "hook",    fraction: 0.05, pace: "fast",   targetCutSec: 1  },
      { zone: "content", fraction: 0.80, pace: "fast",   targetCutSec: 2.3 },
      { zone: "cta",     fraction: 0.15, pace: "normal", targetCutSec: 3  },
    ],
  },
  music_video: {
    label: "Music Video",
    description: "Beat-synced cuts, visually dynamic, emotion-driven. Every cut on the beat.",
    targetCutSec: 2,
    minClipSec: 0.5,
    maxClipSec: 6,
    hookDuration: 2,
    preferredCutType: "hard-cut",
    transitionStyle: "cut",
    pacingEnvelope: [
      { zone: "intro",   fraction: 0.10, pace: "normal", targetCutSec: 3  },
      { zone: "verse",   fraction: 0.40, pace: "normal", targetCutSec: 2  },
      { zone: "chorus",  fraction: 0.35, pace: "fast",   targetCutSec: 1.5 },
      { zone: "outro",   fraction: 0.15, pace: "slow",   targetCutSec: 4  },
    ],
  },
};

// ── Platform pacing targets ───────────────────────────────────────────────
const PLATFORM_PACE: Record<string, { label: string; targetCutSec: number; maxDurationSec: number }> = {
  tiktok:    { label: "TikTok",     targetCutSec: 2.3, maxDurationSec: 60  },
  youtube:   { label: "YouTube",    targetCutSec: 8,   maxDurationSec: 1200 },
  linkedin:  { label: "LinkedIn",   targetCutSec: 12,  maxDurationSec: 600  },
  instagram: { label: "Instagram",  targetCutSec: 3.5, maxDurationSec: 90   },
  custom:    { label: "Custom",     targetCutSec: 5,   maxDurationSec: 300  },
};

// ── Story arc bucket definitions ──────────────────────────────────────────
const ARC_BUCKETS = ["hook", "buildup", "conflict", "climax", "resolution", "cta"] as const;

/* ─────────────────────────────────────────────────────────────────────────
 * #1 EDIT STYLE CLONING
 * Analyze an existing project's segments to extract edit rhythm DNA and
 * store it back on the style profile.
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/style-profiles/:id/clone-from-project", async (req, res) => {
  const { projectId } = z.object({ projectId: z.string() }).parse(req.body);
  const [profile] = await db.select().from(styleProfilesTable).where(eq(styleProfilesTable.id, req.params.id));
  if (!profile) return res.status(404).json({ error: "Style profile not found" });

  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  if (segs.length < 2) return res.status(400).json({ error: "Need at least 2 included segments to analyze edit rhythm" });

  const durations = segs.map(s => Math.max(0, s.endTime - s.startTime)).filter(d => d > 0);
  const avgSegDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
  const totalDur = segs[segs.length - 1]!.endTime - segs[0]!.startTime;
  const avgCutFrequency = segs.length / Math.max(1, totalDur); // cuts per second

  // Cut type distribution
  const cutTypeCounts: Record<string, number> = {};
  for (const s of segs) {
    const t = (s as any).cutTypeFinal ?? s.transitionIn ?? "hard-cut";
    cutTypeCounts[t] = (cutTypeCounts[t] ?? 0) + 1;
  }
  const total = segs.length;
  const cutTypeDistribution: Record<string, number> = {};
  for (const [k, v] of Object.entries(cutTypeCounts)) {
    cutTypeDistribution[k] = parseFloat((v / total).toFixed(3));
  }

  // Learn the existing projects list
  let learnedProjects: string[] = [];
  try { learnedProjects = JSON.parse(profile.learnedFromProjects ?? "[]"); } catch {}
  if (!learnedProjects.includes(projectId)) learnedProjects.push(projectId);

  const [updated] = await db.update(styleProfilesTable)
    .set({
      avgCutFrequency,
      avgSegDuration,
      cutTypeDistribution: JSON.stringify(cutTypeDistribution),
      learnedFromProjects: JSON.stringify(learnedProjects),
      updatedAt: new Date(),
    })
    .where(eq(styleProfilesTable.id, req.params.id))
    .returning();

  res.json({
    cloned: true,
    projectId,
    segmentsAnalyzed: segs.length,
    avgCutFrequency: parseFloat(avgCutFrequency.toFixed(4)),
    cutsPerMinute: parseFloat((avgCutFrequency * 60).toFixed(2)),
    avgSegDuration: parseFloat(avgSegDuration.toFixed(3)),
    cutTypeDistribution,
    profile: { ...updated, createdAt: updated.createdAt.toISOString(), updatedAt: updated.updatedAt.toISOString() },
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #2 PACING ENVELOPE
 * ───────────────────────────────────────────────────────────────────────── */
const PacingZoneSchema = z.array(z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  pace: z.enum(["fast", "slow", "normal"]),
  targetCutSec: z.number().min(0.5).max(120).optional(),
  label: z.string().optional(),
}));

router.post("/projects/:id/pacing-envelope", async (req, res) => {
  const zones = PacingZoneSchema.parse(req.body.zones);
  // Validate: zones shouldn't overlap
  const sorted = [...zones].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.start < sorted[i - 1]!.end) {
      return res.status(400).json({ error: `Zones overlap: zone ${i - 1} ends at ${sorted[i - 1]!.end}s, zone ${i} starts at ${sorted[i]!.start}s` });
    }
  }

  const [project] = await db.update(projectsTable)
    .set({ pacingEnvelope: JSON.stringify(sorted), updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id))
    .returning();
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({ saved: true, zones: sorted, projectId: req.params.id });
});

router.get("/projects/:id/pacing-envelope", async (req, res) => {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project) return res.status(404).json({ error: "Project not found" });

  let zones: unknown[] = [];
  try { zones = JSON.parse(project.pacingEnvelope ?? "[]"); } catch {}

  res.json({ zones, genrePreset: project.genrePreset, platformPacingTarget: project.platformPacingTarget });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #3 GENRE PRESET
 * Apply a genre preset's pacing rules to the project (and optionally re-pace clips).
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/genre-preset", async (req, res) => {
  const { genre, applyPacing } = z.object({
    genre: z.enum(["documentary", "tutorial", "vlog", "ad", "short_film", "social_media", "music_video"]),
    applyPacing: z.boolean().default(false),
  }).parse(req.body);

  const preset = GENRE_PRESETS[genre]!;

  // Always save the genre preset on the project
  await db.update(projectsTable)
    .set({ genrePreset: genre, updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id));

  if (!applyPacing) {
    return res.json({ preset: { genre, ...preset }, appliedToClips: false });
  }

  // Retrieve included segments and calculate total duration
  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  if (segs.length === 0) return res.json({ preset: { genre, ...preset }, appliedToClips: false, reason: "No segments" });

  const totalDur = segs.reduce((s, sg) => s + Math.max(0, sg.endTime - sg.startTime), 0);
  let modified = 0;

  // Apply per-zone pacing: adjust each clip toward targetCutSec for its zone
  for (const seg of segs) {
    const segStart = seg.startTime;
    const dur = Math.max(0, seg.endTime - seg.startTime);
    // Find which zone fraction this segment falls in
    const globalFrac = totalDur > 0 ? segStart / totalDur : 0;
    let cumFrac = 0;
    let targetCutSec = preset.targetCutSec;
    for (const zone of preset.pacingEnvelope) {
      cumFrac += zone.fraction;
      if (globalFrac <= cumFrac) { targetCutSec = zone.targetCutSec; break; }
    }
    // Only adjust if current duration differs by >30% from target
    const newDur = Math.min(
      Math.max(preset.minClipSec, targetCutSec),
      preset.maxClipSec
    );
    if (Math.abs(dur - newDur) > newDur * 0.3) {
      const newEnd = Math.min(seg.startTime + newDur, seg.endTime + 2); // don't extend beyond source by > 2s
      await db.update(segmentsTable)
        .set({ endTime: newEnd })
        .where(eq(segmentsTable.id, seg.id));
      modified++;
    }
  }

  res.json({ preset: { genre, ...preset }, appliedToClips: true, segmentsAdjusted: modified, total: segs.length });
});

router.get("/genres", async (_req, res) => {
  res.json(Object.entries(GENRE_PRESETS).map(([key, v]) => ({
    id: key,
    label: v.label,
    description: v.description,
    targetCutSec: v.targetCutSec,
    preferredCutType: v.preferredCutType,
  })));
});

/* ─────────────────────────────────────────────────────────────────────────
 * #4 STORY ARC ENFORCEMENT
 * Claude assigns hook/buildup/conflict/climax/resolution/cta buckets
 * to each segment, then orders them according to the target arc.
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/assign-story-arc", async (req, res) => {
  const projectId = req.params.id;
  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  if (segs.length === 0) return res.status(400).json({ error: "No included segments" });

  // Build a summary of each segment for Claude
  const segSummaries = segs.map((s, i) =>
    `${i + 1}. id=${s.id} label="${s.label ?? s.segmentType}" type=${s.segmentType} dur=${(s.endTime - s.startTime).toFixed(1)}s conf=${(s.confidence ?? 0).toFixed(2)}`
  ).join("\n");

  const prompt = `You are an expert video editor specializing in story structure. 
Assign each clip to a story arc bucket: hook | buildup | conflict | climax | resolution | cta

Rules:
- "hook" = opening 5-10% — grabbing attention, best moment first
- "buildup" = building context, showing process, narrative setup
- "conflict" = tension, challenge, contrast, stakes
- "climax" = the peak emotional/visual moment(s)
- "resolution" = payoff, conclusion, transformation, result
- "cta" = call-to-action, outro, brand/subscribe moment

CLIPS:
${segSummaries}

Respond ONLY with a JSON array:
[{"id": "<segmentId>", "bucket": "<hook|buildup|conflict|climax|resolution|cta>", "reason": "<1 sentence>"}]

Assign exactly one bucket per clip. Ensure at least 1 clip in each of hook, resolution. Use your judgment about climax placement.`;

  let assignments: Array<{ id: string; bucket: string; reason: string }> = [];
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.content[0];
    if (content?.type === "text") {
      const match = content.text.match(/\[[\s\S]*\]/);
      if (match) assignments = JSON.parse(match[0]);
    }
  } catch (err) {
    return res.status(500).json({ error: "AI call failed", details: String(err) });
  }

  // Apply assignments to DB
  let updated = 0;
  for (const a of assignments) {
    if (!ARC_BUCKETS.includes(a.bucket as typeof ARC_BUCKETS[number])) continue;
    await db.update(segmentsTable)
      .set({ storyArcBucket: a.bucket } as any)
      .where(and(eq(segmentsTable.id, a.id), eq(segmentsTable.projectId, projectId)));
    updated++;
  }

  res.json({ assigned: updated, total: segs.length, assignments });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #5 RE-EDIT FROM FEEDBACK
 * User says "too slow in the middle" → Claude parses which segments to
 * adjust and what kind of adjustment to make.
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/redit-from-feedback", async (req, res) => {
  const { feedback } = z.object({ feedback: z.string().min(5).max(1000) }).parse(req.body);
  const projectId = req.params.id;

  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  if (segs.length === 0) return res.status(400).json({ error: "No segments to adjust" });

  const totalDur = segs.reduce((s, sg) => s + (sg.endTime - sg.startTime), 0);
  const segSummaries = segs.map((s, i) => {
    const dur = (s.endTime - s.startTime).toFixed(1);
    const pos = totalDur > 0 ? ((segs.slice(0, i).reduce((acc, x) => acc + (x.endTime - x.startTime), 0) / totalDur) * 100).toFixed(0) : 0;
    return `${i + 1}. id=${s.id} label="${s.label ?? s.segmentType}" pos=${pos}% dur=${dur}s arc=${s.storyArcBucket ?? "?"}`;
  }).join("\n");

  const prompt = `You are a video editor responding to this feedback: "${feedback}"

The current edit has ${segs.length} clips, total duration ${totalDur.toFixed(1)}s.

CLIPS:
${segSummaries}

Based on the feedback, produce a JSON array of adjustments to fix ONLY the affected section.
Each adjustment:
{
  "id": "<segmentId>",
  "action": "trim_head" | "trim_tail" | "trim_both" | "exclude" | "include" | "set_arc",
  "value": <seconds to trim or arc bucket name>,
  "reason": "<why this change addresses the feedback>"
}

Important:
- "too slow in the middle" → trim clips in the 30-70% zone by 0.3-1.5s each
- "too fast at the start" → extend (negative trim) clips in first 20% 
- "weak ending" → exclude low-confidence clips in last 20%, set resolution/cta arc
- Only touch the section mentioned. Don't change clips outside the affected zone.
- Max trim: 40% of clip duration. Don't make clips shorter than 1.2s.

Respond ONLY with the JSON array.`;

  let adjustments: Array<{ id: string; action: string; value: number | string; reason: string }> = [];
  try {
    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });
    const content = response.content[0];
    if (content?.type === "text") {
      const match = content.text.match(/\[[\s\S]*\]/);
      if (match) adjustments = JSON.parse(match[0]);
    }
  } catch (err) {
    return res.status(500).json({ error: "AI call failed", details: String(err) });
  }

  // Apply adjustments
  const applied: typeof adjustments = [];
  for (const adj of adjustments) {
    const seg = segs.find(s => s.id === adj.id);
    if (!seg) continue;
    const dur = seg.endTime - seg.startTime;

    if (adj.action === "trim_head" && typeof adj.value === "number") {
      const trim = Math.min(adj.value, dur * 0.4);
      if (dur - trim >= 1.2) {
        await db.update(segmentsTable).set({ startTime: seg.startTime + trim }).where(eq(segmentsTable.id, seg.id));
        applied.push(adj);
      }
    } else if (adj.action === "trim_tail" && typeof adj.value === "number") {
      const trim = Math.min(adj.value, dur * 0.4);
      if (dur - trim >= 1.2) {
        await db.update(segmentsTable).set({ endTime: seg.endTime - trim }).where(eq(segmentsTable.id, seg.id));
        applied.push(adj);
      }
    } else if (adj.action === "trim_both" && typeof adj.value === "number") {
      const trim = Math.min(adj.value / 2, dur * 0.2);
      if (dur - trim * 2 >= 1.2) {
        await db.update(segmentsTable).set({ startTime: seg.startTime + trim, endTime: seg.endTime - trim }).where(eq(segmentsTable.id, seg.id));
        applied.push(adj);
      }
    } else if (adj.action === "exclude") {
      await db.update(segmentsTable).set({ included: false }).where(eq(segmentsTable.id, seg.id));
      applied.push(adj);
    } else if (adj.action === "include") {
      await db.update(segmentsTable).set({ included: true }).where(eq(segmentsTable.id, seg.id));
      applied.push(adj);
    } else if (adj.action === "set_arc" && typeof adj.value === "string" && ARC_BUCKETS.includes(adj.value as typeof ARC_BUCKETS[number])) {
      await db.update(segmentsTable).set({ storyArcBucket: adj.value } as any).where(eq(segmentsTable.id, seg.id));
      applied.push(adj);
    }
  }

  res.json({
    feedback,
    adjustmentsProposed: adjustments.length,
    adjustmentsApplied: applied.length,
    applied,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #6 CUT POINT HEAT MAP
 * Returns where AI considered cut points during the last edit plan generation,
 * annotated with why each was accepted or rejected.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/projects/:id/cut-heatmap", async (req, res) => {
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segs = await db.select().from(segmentsTable)
    .where(eq(segmentsTable.projectId, req.params.id))
    .orderBy(asc(segmentsTable.orderIndex));

  // Accepted cut points (the actual segments)
  const accepted = segs.map(s => ({
    timestamp: s.startTime,
    type: "accepted",
    label: s.label ?? s.segmentType,
    confidence: s.confidence ?? null,
    segmentId: s.id,
    cutType: (s as any).cutTypeFinal ?? s.transitionIn ?? "hard-cut",
    included: s.included,
    storyArcBucket: (s as any).storyArcBucket ?? null,
  }));

  // Rejected cut points (stored from generate_edit_plan if available)
  let rejected: unknown[] = [];
  try { rejected = JSON.parse(project.rejectedCutPoints ?? "[]"); } catch {}

  // Cut rhythm data (from score_cut_points job)
  let cutRhythmPoints: unknown[] = [];
  if (project.cutRhythmData) {
    try {
      const crd = JSON.parse(project.cutRhythmData);
      cutRhythmPoints = (crd.topCuts ?? []).slice(0, 50);
    } catch {}
  }

  res.json({
    accepted,
    rejected,
    cutRhythmPoints,
    totalAccepted: accepted.length,
    totalRejected: rejected.length,
    projectDuration: segs.length > 0 ? segs[segs.length - 1]!.endTime : 0,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #7 CONFIDENCE REPORT
 * Returns per-segment confidence with distribution + weak-segment warnings
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/projects/:id/confidence-report", async (req, res) => {
  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  const withConf = segs.map(s => ({
    id: s.id,
    label: s.label ?? s.segmentType,
    confidence: s.confidence ?? 0.5,
    duration: s.endTime - s.startTime,
    storyArcBucket: (s as any).storyArcBucket ?? null,
  }));

  const high    = withConf.filter(s => s.confidence >= 0.85);
  const medium  = withConf.filter(s => s.confidence >= 0.65 && s.confidence < 0.85);
  const low     = withConf.filter(s => s.confidence < 0.65);
  const avgConf = withConf.length > 0 ? withConf.reduce((a, b) => a + b.confidence, 0) / withConf.length : 0;

  res.json({
    segments: withConf,
    distribution: { high: high.length, medium: medium.length, low: low.length },
    avgConfidence: parseFloat(avgConf.toFixed(3)),
    weakSegments: low.map(s => ({ id: s.id, label: s.label, confidence: s.confidence })),
    recommendation: low.length > segs.length * 0.3
      ? "More than 30% of clips have low AI confidence — consider re-running highlight scoring or manually reviewing these clips."
      : avgConf >= 0.7
      ? "Edit confidence is strong — AI is high confidence on the majority of selections."
      : "Moderate confidence — a second AI analysis pass may improve selections.",
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #8 EDIT DIVERSITY CHECK
 * Scan the current timeline for repeated cut types or segment types
 * and flag sections that violate the diversity guard.
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/projects/:id/diversity-check", async (req, res) => {
  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  const violations: Array<{ indices: number[]; type: string; value: string; suggestion: string }> = [];

  // Check for 3+ consecutive same cut type
  for (let i = 0; i <= segs.length - 3; i++) {
    const window = segs.slice(i, i + 3);
    const cutTypes = window.map(s => (s as any).cutTypeFinal ?? s.transitionIn ?? "hard-cut");
    if (new Set(cutTypes).size === 1) {
      violations.push({
        indices: [i, i + 1, i + 2],
        type: "cut_type_repetition",
        value: cutTypes[0] as string,
        suggestion: `3 consecutive "${cutTypes[0]}" cuts at positions ${i + 1}–${i + 3}. Consider varying with a ${cutTypes[0] === "hard-cut" ? "j-cut or dissolve" : "hard-cut"}.`,
      });
    }
  }

  // Check for 4+ consecutive same segment type
  for (let i = 0; i <= segs.length - 4; i++) {
    const window = segs.slice(i, i + 4);
    const segTypes = window.map(s => s.segmentType);
    if (new Set(segTypes).size === 1) {
      violations.push({
        indices: [i, i + 1, i + 2, i + 3],
        type: "segment_type_repetition",
        value: segTypes[0] as string,
        suggestion: `4 consecutive "${segTypes[0]}" clips at positions ${i + 1}–${i + 4}. Insert a B-roll or different shot type.`,
      });
    }
  }

  // Cut type distribution
  const cutDist: Record<string, number> = {};
  for (const s of segs) {
    const ct = (s as any).cutTypeFinal ?? s.transitionIn ?? "hard-cut";
    cutDist[ct] = (cutDist[ct] ?? 0) + 1;
  }
  const totalSegs = segs.length;
  const cutDistPct: Record<string, string> = {};
  for (const [k, v] of Object.entries(cutDist)) {
    cutDistPct[k] = `${Math.round((v / totalSegs) * 100)}%`;
  }

  res.json({
    totalSegments: totalSegs,
    violations,
    violationCount: violations.length,
    cutTypeDistribution: cutDistPct,
    isHealthy: violations.length === 0,
    summary: violations.length === 0
      ? "Edit diversity looks good — no repeated patterns detected."
      : `${violations.length} diversity ${violations.length === 1 ? "violation" : "violations"} detected. Review suggestions to improve visual variety.`,
  });
});

router.post("/projects/:id/diversity-guard", async (req, res) => {
  const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
  const [project] = await db.update(projectsTable)
    .set({ editDiversityGuard: enabled, updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id))
    .returning();
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json({ editDiversityGuard: enabled });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #9 PLATFORM-OPTIMIZED PACING
 * Adjusts all included segment durations to hit the platform's target
 * cuts-per-second. Uses a proportional trim (no clip goes below 1.2s).
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/platform-pace", async (req, res) => {
  const { platform, dryRun } = z.object({
    platform: z.enum(["tiktok", "youtube", "linkedin", "instagram", "custom"]),
    dryRun: z.boolean().default(false),
  }).parse(req.body);

  const paceSpec = PLATFORM_PACE[platform]!;
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, req.params.id));
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  if (segs.length === 0) return res.status(400).json({ error: "No included segments" });

  const results: Array<{
    segmentId: string;
    label: string | null;
    before: number;
    after: number;
    trimmedSec: number;
  }> = [];

  for (const seg of segs) {
    const dur = seg.endTime - seg.startTime;
    const targetDur = paceSpec.targetCutSec;
    let newDur = dur;

    if (dur > targetDur * 1.5) {
      // Trim proportionally — remove excess beyond 110% of target, but not below 1.2s
      newDur = Math.max(1.2, targetDur * 1.1);
    } else if (dur < targetDur * 0.4) {
      // Extend short clips toward target (won't extend beyond source unless source allows)
      newDur = Math.min(seg.endTime - seg.startTime + 1, targetDur * 0.6);
    }

    const trimmed = parseFloat((dur - newDur).toFixed(3));
    results.push({ segmentId: seg.id, label: seg.label, before: dur, after: newDur, trimmedSec: trimmed });

    if (!dryRun && Math.abs(trimmed) > 0.05) {
      await db.update(segmentsTable)
        .set({ endTime: seg.startTime + newDur })
        .where(eq(segmentsTable.id, seg.id));
    }
  }

  if (!dryRun) {
    await db.update(projectsTable)
      .set({ platformPacingTarget: platform, updatedAt: new Date() })
      .where(eq(projectsTable.id, req.params.id));
  }

  const currentAvgSec = segs.reduce((s, sg) => s + (sg.endTime - sg.startTime), 0) / segs.length;
  const newAvgSec = results.reduce((s, r) => s + r.after, 0) / results.length;
  const modified = results.filter(r => Math.abs(r.trimmedSec) > 0.05).length;

  res.json({
    platform,
    dryRun,
    target: paceSpec,
    currentAvgClipSec: parseFloat(currentAvgSec.toFixed(2)),
    newAvgClipSec: parseFloat(newAvgSec.toFixed(2)),
    modifiedCount: modified,
    totalSegments: segs.length,
    results,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #10 DIALOGUE-DRIVEN B-ROLL TIMING
 * Parses the project's transcript, finds keywords that match B-roll clips,
 * then inserts B-roll at those exact word-level timestamps.
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/dialogue-broll", async (req, res) => {
  const { keywords, dryRun } = z.object({
    keywords: z.array(z.string()).min(1).max(30).optional(),
    dryRun: z.boolean().default(true),
  }).parse(req.body);

  const projectId = req.params.id;
  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));
  const segs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  if (segs.length === 0) return res.status(400).json({ error: "No included segments" });

  // Collect all transcripts with word-level timing
  const allWords: Array<{ word: string; start: number; end: number; videoId: string }> = [];
  for (const vid of videos) {
    if (!vid.transcript) continue;
    try {
      const tr = JSON.parse(vid.transcript);
      const words = (tr.words ?? tr.segments?.flatMap((s: any) => s.words ?? []) ?? []) as any[];
      for (const w of words) {
        if (w.word && typeof w.start === "number") {
          allWords.push({ word: w.word.toLowerCase().trim(), start: w.start, end: w.end ?? w.start + 0.5, videoId: vid.id });
        }
      }
    } catch { /* transcript not word-level */ }
  }

  if (allWords.length === 0) {
    return res.status(400).json({
      error: "No word-level transcript data found. Run Transcribe first, then ensure word timestamps are available.",
    });
  }

  // Find B-roll-eligible segments (excluded clips, secondary videos)
  const brollCandidates = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, false)))
    .orderBy(asc(segmentsTable.orderIndex));

  // Use Claude to match keywords to transcript moments if no keywords provided
  let targetKeywords = keywords ?? [];
  if (targetKeywords.length === 0 && videos[0]?.transcript) {
    const transcriptSample = allWords.slice(0, 200).map(w => w.word).join(" ");
    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 300,
        messages: [{
          role: "user",
          content: `From this transcript excerpt, extract 5-10 key concrete nouns and verbs that would make great B-roll trigger points (things that can be visually illustrated).
Transcript: "${transcriptSample}"
Respond ONLY with a JSON array of strings: ["word1","word2",...]`,
        }],
      });
      const content = response.content[0];
      if (content?.type === "text") {
        const match = content.text.match(/\[[\s\S]*\]/);
        if (match) targetKeywords = JSON.parse(match[0]);
      }
    } catch { /* fall through */ }
  }

  // Find timestamp matches for each keyword
  const matches: Array<{
    keyword: string;
    timestamp: number;
    videoId: string;
    word: string;
    context: string;
  }> = [];

  for (const kw of targetKeywords) {
    const kwLower = kw.toLowerCase();
    const found = allWords.filter(w => w.word.includes(kwLower) || kwLower.includes(w.word));
    for (const f of found.slice(0, 3)) {
      const contextWords = allWords
        .filter(w => w.start >= f.start - 2 && w.start <= f.end + 2)
        .map(w => w.word).join(" ");
      matches.push({ keyword: kw, timestamp: f.start, videoId: f.videoId, word: f.word, context: contextWords });
    }
  }

  if (matches.length === 0) {
    return res.json({
      dryRun, keywordsUsed: targetKeywords, matchesFound: 0,
      message: "No keyword matches found in transcript. Try different keywords.",
    });
  }

  // In dry run, return what would be inserted
  if (dryRun) {
    return res.json({
      dryRun: true,
      keywordsUsed: targetKeywords,
      matchesFound: matches.length,
      matches: matches.map(m => ({
        keyword: m.keyword,
        timestamp: m.timestamp,
        context: m.context,
        brollAvailable: brollCandidates.length > 0,
      })),
      message: `Found ${matches.length} B-roll insertion points. Set dryRun: false to apply.`,
    });
  }

  // Apply: set b-roll flag on existing segments at those timestamps, or insert new b-roll markers
  let inserted = 0;
  for (const match of matches.slice(0, 5)) { // limit to 5 insertions
    // Find the segment that's playing at this timestamp
    const targetSeg = segs.find(s => s.startTime <= match.timestamp && s.endTime >= match.timestamp);
    if (targetSeg && brollCandidates.length > 0) {
      const brollToInsert = brollCandidates[inserted % brollCandidates.length];
      if (!brollToInsert) continue;
      // Mark the candidate as b-roll and insert it adjacent to the target segment
      await db.update(segmentsTable)
        .set({ included: true, segmentType: "b-roll", audioMixLevel: 0.0 } as any)
        .where(eq(segmentsTable.id, brollToInsert.id));
      inserted++;
    }
  }

  res.json({
    dryRun: false,
    keywordsUsed: targetKeywords,
    matchesFound: matches.length,
    insertedCount: inserted,
    matches,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * AI Settings — save genre, platform, diversity guard in one call
 * ───────────────────────────────────────────────────────────────────────── */
router.patch("/projects/:id/ai-settings", async (req, res) => {
  const body = z.object({
    genrePreset:          z.string().optional(),
    platformPacingTarget: z.string().optional(),
    editDiversityGuard:   z.boolean().optional(),
  }).parse(req.body);

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.genrePreset !== undefined)          updates.genrePreset          = body.genrePreset;
  if (body.platformPacingTarget !== undefined) updates.platformPacingTarget = body.platformPacingTarget;
  if (body.editDiversityGuard !== undefined)   updates.editDiversityGuard   = body.editDiversityGuard;

  const [project] = await db.update(projectsTable)
    .set(updates as any)
    .where(eq(projectsTable.id, req.params.id))
    .returning();
  if (!project) return res.status(404).json({ error: "Project not found" });

  res.json({
    genrePreset: project.genrePreset,
    platformPacingTarget: project.platformPacingTarget,
    editDiversityGuard: project.editDiversityGuard,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * Shared helpers for intro/outro detection
 * ───────────────────────────────────────────────────────────────────────── */
const INTRO_PATTERNS = [
  "hey guys", "hey everyone", "hey what's up", "what's up everyone", "what's up guys",
  "welcome back", "welcome to my channel", "welcome to the channel", "welcome back to",
  "in today's video", "in this video", "today i'm going to", "today we're going to",
  "today we'll be", "in this tutorial", "let's get started", "let's get into it",
  "if you're new here", "if you're new to", "don't forget to subscribe",
  "my name is", "i'm your host", "you're watching", "this is",
  "before we start", "before we begin", "before we get into it",
  "first things first", "without further ado",
];

const OUTRO_PATTERNS = [
  "thanks for watching", "thank you for watching", "thank you so much for watching",
  "if you enjoyed this video", "if you liked this video", "if you enjoyed",
  "don't forget to like", "smash the like button", "hit the like button",
  "make sure you subscribe", "hit subscribe", "don't forget to subscribe",
  "click the bell", "hit the bell", "turn on notifications", "bell icon",
  "see you in the next", "see you next time", "see you in the next video",
  "until next time", "that's it for today", "that's all for today",
  "that's all i have", "i'll see you", "catch you in the next", "peace out",
  "drop a comment", "comment below", "let me know in the comments",
  "link in the description", "link in bio", "check out the description",
  "i'll leave a link", "outro", "subscribe button",
];

function buildWordTimeline(videos: { transcript: string | null }[]) {
  const words: { word: string; start: number; end: number }[] = [];
  for (const vid of videos) {
    if (!vid.transcript) continue;
    try {
      const tr = JSON.parse(vid.transcript);
      const ws = (tr.words ?? tr.segments?.flatMap((s: any) => s.words ?? []) ?? []) as any[];
      for (const w of ws) {
        if (typeof w.start === "number" && typeof w.end === "number") {
          words.push({ word: String(w.word ?? "").toLowerCase(), start: w.start, end: w.end });
        }
      }
    } catch { /* skip */ }
  }
  return words;
}

function findPhraseInWords(
  words: { word: string; start: number; end: number }[],
  patterns: string[],
  searchWindow: { start: number; end: number },
): { phrase: string; matchStart: number; matchEnd: number } | null {
  const windowWords = words.filter(w => w.start >= searchWindow.start && w.end <= searchWindow.end);
  const text = windowWords.map(w => w.word).join(" ");
  for (const pat of patterns) {
    const idx = text.indexOf(pat);
    if (idx !== -1) {
      const wordsBefore = text.slice(0, idx).split(" ").filter(Boolean).length;
      const phraseWordCount = pat.split(" ").length;
      const firstWord = windowWords[wordsBefore];
      const lastWord  = windowWords[Math.min(wordsBefore + phraseWordCount - 1, windowWords.length - 1)];
      if (firstWord && lastWord) {
        return { phrase: pat, matchStart: firstWord.start, matchEnd: lastWord.end };
      }
    }
  }
  return null;
}

/* ─────────────────────────────────────────────────────────────────────────
 * #14 Intro Auto-Trimmer   POST /projects/:id/detect-intro
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/detect-intro", async (req, res) => {
  const { action } = z.object({
    action: z.enum(["scan", "cut", "keep"]).default("scan"),
  }).parse(req.body);

  const videos = await db.query.videosTable.findMany({
    where: eq(videosTable.projectId, req.params.id),
    columns: { id: true, transcript: true, duration: true },
  });
  if (!videos.length) return res.status(400).json({ error: "No videos in project" });

  const words = buildWordTimeline(videos);
  if (words.length === 0) return res.status(400).json({ error: "No word-level transcript found. Run Transcribe first." });

  const totalDuration = Math.max(...words.map(w => w.end));
  const searchWindowEnd = Math.min(totalDuration * 0.25, 60); // first 25% or 60s
  const match = findPhraseInWords(words, INTRO_PATTERNS, { start: 0, end: searchWindowEnd });

  if (!match) {
    return res.json({ found: false, message: "No common intro phrases detected in the opening section." });
  }

  // Find where the intro section ends: look for a natural pause after the matched phrase
  // We define intro end as: matchEnd + up to 8s for "first line of content" after greeting
  const introEndSec = Math.min(match.matchEnd + 8, searchWindowEnd);
  const introSnippet = words
    .filter(w => w.start <= introEndSec + 2)
    .slice(0, 25)
    .map(w => w.word)
    .join(" ");

  // Find segments that fall entirely within the intro window
  const segments = await db.query.segmentsTable.findMany({
    where: eq(segmentsTable.projectId, req.params.id),
    columns: { id: true, inPoint: true, outPoint: true, included: true, label: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex)],
  });

  const introSegmentIds = segments
    .filter(s => (s.outPoint ?? 0) <= introEndSec + 1)
    .map(s => s.id);

  if (action === "cut" && introSegmentIds.length > 0) {
    await db.update(segmentsTable)
      .set({ included: false })
      .where(inArray(segmentsTable.id, introSegmentIds));
  }

  res.json({
    found: true,
    phrase: match.phrase,
    introEndSec: Math.round(introEndSec * 10) / 10,
    snippet: introSnippet,
    segmentIds: introSegmentIds,
    segmentCount: introSegmentIds.length,
    action,
    cut: action === "cut",
    message: action === "cut"
      ? `Intro cut: ${introSegmentIds.length} clip${introSegmentIds.length !== 1 ? "s" : ""} excluded (≤${introEndSec.toFixed(1)}s).`
      : `Detected intro phrase "${match.phrase}" ending ~${introEndSec.toFixed(1)}s. ${introSegmentIds.length} clip${introSegmentIds.length !== 1 ? "s" : ""} in intro window.`,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #13 Outro Auto-Trimmer   POST /projects/:id/detect-outro
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/detect-outro", async (req, res) => {
  const { action } = z.object({
    action: z.enum(["scan", "cut", "keep"]).default("scan"),
  }).parse(req.body);

  const videos = await db.query.videosTable.findMany({
    where: eq(videosTable.projectId, req.params.id),
    columns: { id: true, transcript: true, duration: true },
  });
  if (!videos.length) return res.status(400).json({ error: "No videos in project" });

  const words = buildWordTimeline(videos);
  if (words.length === 0) return res.status(400).json({ error: "No word-level transcript found. Run Transcribe first." });

  const totalDuration = Math.max(...words.map(w => w.end));
  const searchWindowStart = Math.max(totalDuration * 0.75, totalDuration - 60); // last 25% or 60s
  const match = findPhraseInWords(words, OUTRO_PATTERNS, { start: searchWindowStart, end: totalDuration });

  if (!match) {
    return res.json({ found: false, message: "No common outro phrases detected in the closing section." });
  }

  // Outro starts at the phrase match, padded back 3s for natural transition
  const outroStartSec = Math.max(match.matchStart - 3, searchWindowStart);
  const outroSnippet = words
    .filter(w => w.start >= outroStartSec - 2 && w.start <= totalDuration)
    .slice(-25)
    .map(w => w.word)
    .join(" ");

  const segments = await db.query.segmentsTable.findMany({
    where: eq(segmentsTable.projectId, req.params.id),
    columns: { id: true, inPoint: true, outPoint: true, included: true, label: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex)],
  });

  const outroSegmentIds = segments
    .filter(s => (s.inPoint ?? 0) >= outroStartSec - 1)
    .map(s => s.id);

  if (action === "cut" && outroSegmentIds.length > 0) {
    await db.update(segmentsTable)
      .set({ included: false })
      .where(inArray(segmentsTable.id, outroSegmentIds));
  }

  res.json({
    found: true,
    phrase: match.phrase,
    outroStartSec: Math.round(outroStartSec * 10) / 10,
    snippet: outroSnippet,
    segmentIds: outroSegmentIds,
    segmentCount: outroSegmentIds.length,
    action,
    cut: action === "cut",
    message: action === "cut"
      ? `Outro cut: ${outroSegmentIds.length} clip${outroSegmentIds.length !== 1 ? "s" : ""} excluded (≥${outroStartSec.toFixed(1)}s).`
      : `Detected outro phrase "${match.phrase}" starting ~${outroStartSec.toFixed(1)}s. ${outroSegmentIds.length} clip${outroSegmentIds.length !== 1 ? "s" : ""} in outro window.`,
  });
});

export default router;
