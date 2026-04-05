/**
 * Social Intelligence — viral analysis & content optimization
 *
 * Social #1  Hook analyzer         POST /projects/:id/analyze-hook
 * Social #3  Optimal length calc   POST /projects/:id/optimal-length
 * Social #5  Caption hook gen      POST /projects/:id/caption-hooks
 * Social #6  Post timing           GET  /projects/:id/post-timing
 */

import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { projectsTable, segmentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { anthropic } from "@workspace/integrations-anthropic-ai";

const router: IRouter = Router();

// ─────────────────────────────────────────────────────────────────────────────
// Social #1 — Hook Analyzer
// Score the first 3 seconds against viral hook patterns
// ─────────────────────────────────────────────────────────────────────────────

const VIRAL_HOOK_PATTERNS = [
  { id: "question",      label: "Question hook",        weight: 0.9, examples: ["What if I told you…", "Did you know…", "Why does…"] },
  { id: "shock",         label: "Shock/controversy",    weight: 0.95, examples: ["This is wrong", "Stop doing this", "Nobody talks about…"] },
  { id: "value_promise", label: "Value promise",        weight: 0.85, examples: ["Here's exactly how to…", "In 60 seconds you'll learn…"] },
  { id: "story_open",    label: "Story opening",        weight: 0.8, examples: ["Last week I lost everything", "3 years ago I was…"] },
  { id: "pattern_break", label: "Pattern interrupt",    weight: 0.9, examples: ["Wait—", "Actually—", "[sudden cut/zoom]"] },
  { id: "credibility",   label: "Credibility instant",  weight: 0.75, examples: ["After 10 years doing this…", "I tested 100…"] },
  { id: "number",        label: "Number/list hook",     weight: 0.85, examples: ["5 things…", "The #1 reason…", "3 mistakes…"] },
  { id: "curiosity_gap", label: "Curiosity gap",        weight: 0.92, examples: ["The answer might surprise you", "Most people miss this…"] },
];

router.post("/projects/:id/analyze-hook", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { name: true, genrePreset: true, platformPacingTarget: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  // Get first 3 seconds of transcript
  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { transcript: true, orderIndex: true, startTime: true, endTime: true, inPoint: true, outPoint: true },
  });

  const sorted = segments.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  let hookTranscript = "";
  let elapsed = 0;

  for (const seg of sorted) {
    const dur = (seg.outPoint ?? seg.endTime ?? 0) - (seg.inPoint ?? seg.startTime ?? 0);
    if (elapsed >= 3) break;
    hookTranscript += (seg.transcript ?? "") + " ";
    elapsed += dur;
  }
  hookTranscript = hookTranscript.trim().slice(0, 500);

  const fullTranscript = sorted.map(s => s.transcript ?? "").filter(Boolean).join(" ").slice(0, 2000);

  const prompt = `You are a viral content expert who has analyzed 10M+ TikToks and YouTube Shorts.
Analyze this video's hook (first ~3 seconds) and score it.

Project name: "${project.name}"
Platform: ${project.platformPacingTarget ?? "unknown"}
Genre: ${project.genrePreset ?? "unknown"}
First 3 seconds transcript: "${hookTranscript || "(no transcript - visual-only hook)"}"
Full transcript excerpt: "${fullTranscript || "(unavailable)"}"

Viral hook patterns to score against:
${VIRAL_HOOK_PATTERNS.map(p => `- ${p.id}: ${p.label} (examples: ${p.examples.join(", ")})`).join("\n")}

Return ONLY valid JSON:
{
  "overallScore": 0-100,
  "grade": "S/A/B/C/D",
  "detectedPatterns": [{"id": "pattern_id", "confidence": 0.0-1.0, "evidence": "what in the transcript matches"}],
  "strengths": ["what works"],
  "improvements": ["specific suggestions to strengthen the hook"],
  "rewrittenHook": "rewritten version of the opening line that would score higher",
  "retentionPrediction": "estimated % of viewers who would keep watching past 3s based on this hook",
  "viralPotentialNote": "1-2 sentence assessment"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });

  let analysis: Record<string, unknown> = {};
  try {
    const raw = (msg.content[0] as { text: string }).text;
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) analysis = JSON.parse(m[0]);
  } catch { analysis = { overallScore: 50, grade: "C", error: "Could not parse analysis" }; }

  res.json({
    hookTranscript,
    elapsedSeconds: parseFloat(elapsed.toFixed(2)),
    analysis,
    hookPatterns: VIRAL_HOOK_PATTERNS.map(p => ({ id: p.id, label: p.label, weight: p.weight })),
    message: `Hook analyzed — score: ${analysis.overallScore ?? "?"}/100 (${analysis.grade ?? "?"})`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Social #3 — Optimal Video Length Calculator
// ─────────────────────────────────────────────────────────────────────────────

const PLATFORM_OPTIMAL_RANGES: Record<string, { min: number; max: number; sweet: number; unit: string }> = {
  tiktok:     { min: 21,  max: 34,   sweet: 27,  unit: "seconds" },
  instagram:  { min: 26,  max: 90,   sweet: 44,  unit: "seconds" },
  youtube:    { min: 420, max: 1200, sweet: 600, unit: "seconds" },
  youtube_shorts: { min: 15, max: 60, sweet: 30, unit: "seconds" },
  linkedin:   { min: 30,  max: 180,  sweet: 90,  unit: "seconds" },
  twitter:    { min: 15,  max: 140,  sweet: 60,  unit: "seconds" },
  facebook:   { min: 60,  max: 180,  sweet: 90,  unit: "seconds" },
};

router.post("/projects/:id/optimal-length", async (req, res) => {
  const body = z.object({
    platform: z.string().default("youtube"),
  }).parse(req.body ?? {});

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { name: true, genrePreset: true, platformPacingTarget: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  const platform = body.platform || project.platformPacingTarget || "youtube";
  const platformData = PLATFORM_OPTIMAL_RANGES[platform.toLowerCase()] ?? PLATFORM_OPTIMAL_RANGES["youtube"]!;

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { transcript: true, orderIndex: true, inPoint: true, outPoint: true, startTime: true, endTime: true },
  });

  const sorted = segments.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
  const totalDuration = sorted.reduce((acc, s) => {
    return acc + ((s.outPoint ?? s.endTime ?? 0) - (s.inPoint ?? s.startTime ?? 0));
  }, 0);
  const transcript = sorted.map(s => s.transcript ?? "").filter(Boolean).join(" ").slice(0, 2000);

  const prompt = `You are a YouTube/TikTok optimization expert.

Video info:
- Current duration: ${totalDuration.toFixed(1)} seconds
- Platform: ${platform}
- Genre: ${project.genrePreset ?? "general"}
- Platform sweet spot: ${platformData.sweet}s (range: ${platformData.min}–${platformData.max}s)
- Transcript: "${transcript || "(unavailable)"}"

Calculate optimal duration and provide editing guidance. Return ONLY JSON:
{
  "currentDuration": ${totalDuration.toFixed(1)},
  "optimalDuration": <number in seconds>,
  "platformSweetSpot": ${platformData.sweet},
  "platformRange": {"min": ${platformData.min}, "max": ${platformData.max}},
  "assessment": "too long|too short|optimal|slightly long|slightly short",
  "deltaSeconds": <how many seconds to cut or add>,
  "cuttingAdvice": "which sections to trim if too long",
  "recommendation": "2-3 sentence explanation",
  "engagementPrediction": "low|medium|high|very high"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  let result: Record<string, unknown> = {
    currentDuration: totalDuration,
    optimalDuration: platformData.sweet,
    platformSweetSpot: platformData.sweet,
    platformRange: { min: platformData.min, max: platformData.max },
    assessment: totalDuration <= platformData.max && totalDuration >= platformData.min ? "optimal" : totalDuration > platformData.max ? "too long" : "too short",
  };

  try {
    const raw = (msg.content[0] as { text: string }).text;
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) result = { ...result, ...JSON.parse(m[0]) };
  } catch { /* use defaults */ }

  res.json({
    platform,
    currentDuration: parseFloat(totalDuration.toFixed(2)),
    result,
    allPlatforms: Object.entries(PLATFORM_OPTIMAL_RANGES).map(([k, v]) => ({
      platform: k,
      sweetSpot: v.sweet,
      range: `${v.min}–${v.max}s`,
      status: totalDuration <= v.max && totalDuration >= v.min ? "✓ optimal" : totalDuration > v.max ? "too long" : "too short",
    })),
    message: `Current: ${totalDuration.toFixed(1)}s | ${platform} optimal: ${platformData.sweet}s`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Social #5 — Caption Hook Generator (EN + Norwegian)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/projects/:id/caption-hooks", async (req, res) => {
  const body = z.object({
    platform: z.string().default("instagram"),
    count: z.number().min(3).max(10).default(5),
    includeNorwegian: z.boolean().default(true),
    tone: z.enum(["casual", "professional", "humorous", "inspirational", "educational"]).default("casual"),
  }).parse(req.body ?? {});

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { name: true, genrePreset: true, platformPacingTarget: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { transcript: true, orderIndex: true },
  });
  const transcript = segments
    .sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0))
    .map(s => s.transcript ?? "").filter(Boolean).join(" ").slice(0, 2000);

  const prompt = `You are an expert social media copywriter specializing in viral content.

Video info:
- Project: "${project.name}"
- Genre: ${project.genrePreset ?? "general"}
- Platform: ${body.platform}
- Tone: ${body.tone}
- Transcript: "${transcript || "(no transcript)"}"

Generate ${body.count} alternative FIRST LINES (hooks) for a social media caption for this video.
Each hook should be max 125 characters, compelling, and designed to stop the scroll.
${body.includeNorwegian ? "For EACH English hook, also provide a Norwegian (Bokmål) translation." : ""}

Use different hook strategies for each variant:
1. Question hook
2. Bold statement / controversy
3. Value/benefit promise
4. Story teaser
5. Number/fact hook
${body.count > 5 ? `6. Curiosity gap\n7. Humor/relatable\n8. Challenge/dare\n9. Behind-the-scenes\n10. Trend reference` : ""}

Return ONLY valid JSON:
{
  "hooks": [
    {
      "id": 1,
      "strategy": "strategy name",
      "english": "hook text",
      "norwegian": "norsk tekst"${body.includeNorwegian ? "" : " (omit if not needed)"},
      "characterCount": 42,
      "emojiSuggestion": "🔥"
    }
  ],
  "recommendedIndex": 0,
  "platformTip": "platform-specific formatting tip"
}`;

  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  let result: Record<string, unknown> = { hooks: [], recommendedIndex: 0 };
  try {
    const raw = (msg.content[0] as { text: string }).text;
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) result = JSON.parse(m[0]);
  } catch { /* fallback */ }

  res.json({
    platform: body.platform,
    tone: body.tone,
    count: body.count,
    includeNorwegian: body.includeNorwegian,
    result,
    message: `Generated ${(result.hooks as unknown[]).length ?? 0} caption hooks (EN${body.includeNorwegian ? " + NO" : ""})`,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Social #6 — Post Timing Recommender
// ─────────────────────────────────────────────────────────────────────────────

// Data sourced from major social analytics studies (Hootsuite, Sprout Social 2024)
const POSTING_SCHEDULE: Record<string, { best: string[]; good: string[]; avoid: string[]; timezone: string; note: string }> = {
  tiktok: {
    best:  ["Tue 07:00", "Thu 10:00", "Fri 05:00", "Fri 09:00", "Fri 23:00"],
    good:  ["Mon 06:00", "Wed 08:00", "Sat 11:00"],
    avoid: ["Mon-Sun 02:00-05:00", "Sun 17:00-19:00"],
    timezone: "EST (UTC-5)",
    note: "TikTok's algorithm distributes globally; EST gives widest initial exposure",
  },
  instagram: {
    best:  ["Mon 11:00", "Tue 14:00", "Wed 11:00", "Thu 14:00", "Fri 11:00"],
    good:  ["Sat 10:00", "Sun 10:00"],
    avoid: ["Mon-Sun 00:00-06:00", "Sun 14:00-17:00"],
    timezone: "EST (UTC-5) / CET (UTC+1) for European audience",
    note: "Reels get 3× more reach than static posts; Tue/Wed evenings also strong",
  },
  youtube: {
    best:  ["Thu 15:00", "Fri 15:00", "Sat 09:00", "Sun 09:00"],
    good:  ["Tue 15:00", "Wed 15:00"],
    avoid: ["Mon-Sun 00:00-08:00", "Mon-Tue mornings"],
    timezone: "EST/PST — publish 2-3h before peak viewing (17:00-21:00 local)",
    note: "Publish before peak hours so algorithm has time to index and surface content",
  },
  youtube_shorts: {
    best:  ["Daily 18:00-20:00 local audience time"],
    good:  ["Weekdays 12:00-14:00"],
    avoid: ["Early mornings"],
    timezone: "Match your primary audience timezone",
    note: "Shorts distribution is less time-sensitive; consistency matters more",
  },
  linkedin: {
    best:  ["Tue 08:00", "Wed 09:00", "Thu 10:00"],
    good:  ["Mon 09:00", "Fri 08:00"],
    avoid: ["Weekends", "After 18:00 weekdays"],
    timezone: "Your primary market timezone",
    note: "B2B content: Tuesday–Thursday peak; Tuesday 10am has highest engagement",
  },
  twitter: {
    best:  ["Wed 09:00", "Thu 09:00", "Fri 09:00"],
    good:  ["Mon-Fri 12:00-15:00"],
    avoid: ["Weekends", "After 21:00"],
    timezone: "EST (UTC-5)",
    note: "News/real-time platform — trending topics override timing",
  },
};

router.get("/projects/:id/post-timing", async (req, res) => {
  const platform = (req.query["platform"] as string ?? "all").toLowerCase();
  const audienceTimezone = req.query["timezone"] as string ?? "EST";

  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { platformPacingTarget: true, genrePreset: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  const targetPlatform = platform === "all" ? (project.platformPacingTarget ?? "youtube") : platform;
  const schedule = POSTING_SCHEDULE[targetPlatform] ?? POSTING_SCHEDULE["youtube"]!;

  // Build a full week schedule table
  const weekSchedule = [
    { day: "Monday",    slots: platform === "tiktok" ? ["06:00", "18:00"] : ["09:00", "17:00"] },
    { day: "Tuesday",   slots: ["08:00", "10:00", "14:00"] },
    { day: "Wednesday", slots: ["09:00", "11:00", "15:00"] },
    { day: "Thursday",  slots: ["10:00", "14:00", "15:00"] },
    { day: "Friday",    slots: ["09:00", "11:00", "15:00"] },
    { day: "Saturday",  slots: ["09:00", "10:00", "11:00"] },
    { day: "Sunday",    slots: ["09:00", "10:00"] },
  ].map(day => ({
    ...day,
    quality: schedule.best.some(b => b.startsWith(day.day.slice(0, 3))) ? "🟢 peak"
      : schedule.good.some(g => g.startsWith(day.day.slice(0, 3))) ? "🟡 good"
      : "🔴 avoid",
  }));

  res.json({
    platform: targetPlatform,
    audienceTimezone,
    schedule,
    weekSchedule,
    allPlatforms: Object.entries(POSTING_SCHEDULE).map(([k, v]) => ({
      platform: k,
      bestSlots: v.best.slice(0, 3),
      timezone: v.timezone,
      note: v.note,
    })),
    nextBestSlot: schedule.best[0],
    message: `Best time to post on ${targetPlatform}: ${schedule.best.slice(0, 2).join(" or ")} (${schedule.timezone})`,
  });
});

export default router;
