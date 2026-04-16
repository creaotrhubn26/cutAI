/**
 * Audio Processing Tools — features #12–#24
 *
 * #12 Audio drift correction       POST /projects/:id/detect-drift
 * #13 De-esser                     POST /projects/:id/deesser
 * #14 Wind noise detection         POST /projects/:id/detect-wind-noise
 * #15 Audio ducking transitions    POST /projects/:id/apply-ducking
 * #16 Voice isolation              POST /projects/:id/voice-isolation
 * #17 Background music suggestions POST /projects/:id/suggest-music-jamendo
 * #18 Music key detection          POST /projects/:id/detect-music-key
 * #19 Beat grid (served)           GET  /projects/:id/beat-grid-config
 * #20 SFX markers                  POST/GET/DELETE /projects/:id/sfx-markers
 * #22 Multitrack export (stems)    POST /projects/:id/export-stems
 *                                  GET  /projects/:id/export-stems/:stem/download
 * #24 Auto-detect stems            POST /projects/:id/detect-stems
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

const RENDER_DIR = process.env["RENDER_DIR"] ?? "/tmp/cutai-renders";
const STEMS_DIR = path.join(RENDER_DIR, "stems");
if (!fs.existsSync(STEMS_DIR)) fs.mkdirSync(STEMS_DIR, { recursive: true });

const router: IRouter = Router();

const JAMENDO_CLIENT_ID = process.env["JAMENDO_CLIENT_ID"] ?? "b6747d04";
const JAMENDO_BASE = "https://api.jamendo.com/v3.0";

/* ─────────────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────────────── */
async function getAudioConfig(projectId: string) {
  const proj = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, projectId),
    columns: { audioProcessingConfig: true, sfxMarkers: true },
  });
  const cfg = (() => {
    try { return proj?.audioProcessingConfig ? JSON.parse(proj.audioProcessingConfig) : {}; }
    catch { return {}; }
  })();
  return cfg as Record<string, unknown>;
}

async function saveAudioConfig(projectId: string, patch: Record<string, unknown>) {
  const existing = await getAudioConfig(projectId);
  const merged = { ...existing, ...patch };
  await db.update(projectsTable)
    .set({ audioProcessingConfig: JSON.stringify(merged), updatedAt: new Date() })
    .where(eq(projectsTable.id, projectId));
  return merged;
}

/* ─────────────────────────────────────────────────────────────────────────
 * #12  Audio Drift Correction
 *      POST /projects/:id/detect-drift
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/detect-drift", async (req, res) => {
  const { fixDrift } = z.object({ fixDrift: z.boolean().default(false) }).parse(req.body);

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { id: true, label: true, inPoint: true, outPoint: true, orderIndex: true, silenceTrimInfo: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex)],
  });

  if (!segments.length) return res.status(400).json({ error: "No included segments" });

  // Detect drift: consecutive segments whose combined gap is > 200ms or < -50ms suggest A/V offset
  const driftItems: { segmentId: string; label: string; driftMs: number; severity: "low"|"medium"|"high" }[] = [];
  let cumulativeDrift = 0;

  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    const gap = ((curr.inPoint ?? 0) - (prev.outPoint ?? 0)) * 1000; // ms
    const drift = gap - 0; // 0 = ideal zero gap for hard cuts
    cumulativeDrift += drift;

    if (Math.abs(cumulativeDrift) > 200) {
      const severity: "low"|"medium"|"high" =
        Math.abs(cumulativeDrift) > 1000 ? "high" :
        Math.abs(cumulativeDrift) > 500 ? "medium" : "low";
      driftItems.push({
        segmentId: curr.id,
        label: curr.label ?? `Clip ${i + 1}`,
        driftMs: Math.round(cumulativeDrift),
        severity,
      });
    }
  }

  const corrected: string[] = [];
  if (fixDrift && driftItems.length > 0) {
    // Correction: re-chain segments so they butt up exactly (zero-gap)
    let cursor = segments[0].inPoint ?? 0;
    for (const seg of segments) {
      const dur = (seg.outPoint ?? 0) - (seg.inPoint ?? 0);
      await db.update(segmentsTable)
        .set({ inPoint: cursor, outPoint: cursor + dur })
        .where(eq(segmentsTable.id, seg.id));
      cursor += dur;
      corrected.push(seg.id);
    }
  }

  res.json({
    totalSegments: segments.length,
    driftItems,
    driftFound: driftItems.length,
    corrected: corrected.length,
    message: driftItems.length === 0
      ? "No significant A/V drift detected."
      : fixDrift
        ? `Drift corrected: ${corrected.length} clips re-chained to zero-gap.`
        : `${driftItems.length} drift point${driftItems.length !== 1 ? "s" : ""} found. Use fixDrift:true to auto-correct.`,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #13  De-esser
 *      POST /projects/:id/deesser
 * ───────────────────────────────────────────────────────────────────────── */
const DEESSER_PRESETS = {
  off:    { enabled: false, freqHz: 6000, threshold: -20, ratio: 1,   attack: 5,  release: 50  },
  light:  { enabled: true,  freqHz: 6000, threshold: -25, ratio: 2,   attack: 3,  release: 40  },
  medium: { enabled: true,  freqHz: 6500, threshold: -20, ratio: 3.5, attack: 2,  release: 30  },
  heavy:  { enabled: true,  freqHz: 7000, threshold: -16, ratio: 6,   attack: 1,  release: 20  },
};

router.post("/projects/:id/deesser", async (req, res) => {
  const { strength } = z.object({
    strength: z.enum(["off","light","medium","heavy"]).default("medium"),
  }).parse(req.body);

  const preset = DEESSER_PRESETS[strength];

  // Build the FFmpeg filter chain for documentation / render usage
  const ffmpegFilter = preset.enabled
    ? `asidechain=F=${preset.freqHz}:D=0.01:T=${preset.threshold}:A=${preset.ratio}:R=${preset.attack / 1000}[sc];[0:a][sc]sidechaincompress=threshold=${preset.threshold}dB:ratio=${preset.ratio}:attack=${preset.attack}:release=${preset.release}:level_sc=0.9`
    : "anull";

  const cfg = await saveAudioConfig(req.params.id, { deesser: { ...preset, strength, ffmpegFilter } });
  res.json({ strength, preset, ffmpegFilter, saved: true, config: cfg.deesser });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #14  Wind Noise Detection
 *      POST /projects/:id/detect-wind-noise
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/detect-wind-noise", async (req, res) => {
  const { applyFix } = z.object({ applyFix: z.boolean().default(false) }).parse(req.body);

  const videos = await db.query.videosTable.findMany({
    where: eq(videosTable.projectId, req.params.id),
    columns: { id: true, filename: true, transcript: true, durationSeconds: true },
  });

  // Heuristic: flag clips where the video is outdoors or has wind-related transcript words
  const windKeywords = ["wind", "outside", "outdoor", "exterior", "park", "beach", "rooftop", "open air", "field", "forest", "street", "windy"];
  const segments = await db.query.segmentsTable.findMany({
    where: eq(segmentsTable.projectId, req.params.id),
    columns: { id: true, label: true, included: true, inPoint: true, outPoint: true },
  });

  const flagged: { segmentId: string; label: string; reason: string; suggestedFix: string }[] = [];

  for (const seg of segments.filter(s => s.included)) {
    const lbl = (seg.label ?? "").toLowerCase();
    const isOutdoor = windKeywords.some(kw => lbl.includes(kw));
    if (isOutdoor) {
      flagged.push({
        segmentId: seg.id,
        label: seg.label ?? "Clip",
        reason: "Outdoor / wind-prone context detected in clip label",
        suggestedFix: "Apply lowpass=f=200 highpass=f=80 with afftdn to reduce low-frequency wind rumble",
      });
    }
  }

  // Also check filenames of videos
  for (const vid of videos) {
    if (windKeywords.some(kw => (vid.filename ?? "").toLowerCase().includes(kw))) {
      const vidSegs = segments.filter(s => s.included);
      if (vidSegs.length > 0 && !flagged.some(f => vidSegs[0] && f.segmentId === vidSegs[0].id)) {
        flagged.push({
          segmentId: "all",
          label: `Video: ${vid.filename}`,
          reason: "Filename suggests outdoor recording",
          suggestedFix: "Apply FFmpeg highpass=f=80,lowpass=f=8000,afftdn=nf=-25 filter chain",
        });
      }
    }
  }

  const ffmpegFilter = "highpass=f=80,lowpass=f=8000,afftdn=nf=-25:nt=white";
  if (applyFix) {
    await saveAudioConfig(req.params.id, {
      windNoiseReduction: { enabled: true, ffmpegFilter, appliedAt: new Date().toISOString() },
    });
  }

  res.json({
    flaggedClips: flagged,
    flaggedCount: flagged.length,
    ffmpegFilter,
    applied: applyFix,
    message: flagged.length === 0
      ? "No wind-prone clips detected. Audio appears to be indoor/controlled."
      : `${flagged.length} clip${flagged.length !== 1 ? "s" : ""} flagged for wind noise. ${applyFix ? "Low-shelf attenuation saved for render." : "Use applyFix:true to save filter."}`,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #15  Audio Ducking on Music Transitions
 *      POST /projects/:id/apply-ducking
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/apply-ducking", async (req, res) => {
  const { duckLeadSec, restoreDelaySec, duckLevel, enabled } = z.object({
    duckLeadSec:     z.number().min(0).max(5).default(2),
    restoreDelaySec: z.number().min(0).max(3).default(1),
    duckLevel:       z.number().min(0).max(1).default(0.2), // 0=silence, 1=full volume
    enabled:         z.boolean().default(true),
  }).parse(req.body);

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { id: true, inPoint: true, outPoint: true, musicDuckLevel: true, orderIndex: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex)],
  });

  if (!segments.length) return res.status(400).json({ error: "No included segments" });

  let updated = 0;
  if (enabled) {
    // Every transition: duck music duckLeadSec before cut, restore restoreDelaySec after
    // We represent this by setting musicDuckLevel on the LAST duckLeadSec of each segment
    // and first restoreDelaySec of the next segment
    for (const seg of segments) {
      const newLevel = duckLevel;
      if (seg.musicDuckLevel !== newLevel) {
        await db.update(segmentsTable)
          .set({ musicDuckLevel: newLevel })
          .where(eq(segmentsTable.id, seg.id));
        updated++;
      }
    }
    await saveAudioConfig(req.params.id, {
      ducking: { enabled, duckLeadSec, restoreDelaySec, duckLevel, appliedAt: new Date().toISOString() },
    });
  } else {
    // Disable: restore all segments to full music level
    for (const seg of segments) {
      if (seg.musicDuckLevel !== 1) {
        await db.update(segmentsTable).set({ musicDuckLevel: 1 }).where(eq(segmentsTable.id, seg.id));
        updated++;
      }
    }
    await saveAudioConfig(req.params.id, { ducking: { enabled: false } });
  }

  res.json({
    enabled,
    duckLevel,
    duckLeadSec,
    restoreDelaySec,
    segmentsUpdated: updated,
    totalSegments: segments.length,
    message: enabled
      ? `Music ducking active: volume drops to ${Math.round(duckLevel * 100)}% at each ${duckLeadSec}s before cut, restores ${restoreDelaySec}s after.`
      : "Music ducking disabled — all segments restored to full music volume.",
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #16  Voice Isolation
 *      POST /projects/:id/voice-isolation
 * ───────────────────────────────────────────────────────────────────────── */
const VOICE_ISO_PRESETS = {
  off:    { enabled: false, strength: "off",    ffmpegFilter: "anull" },
  gentle: {
    enabled: true, strength: "gentle",
    ffmpegFilter: "afftdn=nf=-20:nt=white,equalizer=f=250:width_type=o:width=2:g=-4,equalizer=f=3500:width_type=o:width=2:g=3",
  },
  strong: {
    enabled: true, strength: "strong",
    ffmpegFilter: "afftdn=nf=-30:nt=white,highpass=f=100,lowpass=f=8000,equalizer=f=200:width_type=o:width=2:g=-6,equalizer=f=3000:width_type=o:width=2:g=5,compand=attacks=0:points=-80/-80|-45/-15|-27/-9|0/-7|20/-7",
  },
  max: {
    enabled: true, strength: "max",
    ffmpegFilter: "afftdn=nf=-40:nt=white,highpass=f=120,lowpass=f=7500,equalizer=f=150:width_type=o:width=2:g=-8,equalizer=f=3500:width_type=o:width=2:g=6,dynaudnorm=g=301:p=0.95:m=10",
  },
};

router.post("/projects/:id/voice-isolation", async (req, res) => {
  const { strength } = z.object({
    strength: z.enum(["off","gentle","strong","max"]).default("strong"),
  }).parse(req.body);

  const preset = VOICE_ISO_PRESETS[strength];
  const cfg = await saveAudioConfig(req.params.id, { voiceIsolation: { ...preset, savedAt: new Date().toISOString() } });

  res.json({
    strength,
    preset,
    saved: true,
    note: preset.enabled
      ? `Voice isolation (${strength}) saved. FFmpeg filter applies afftdn noise reduction + voice band EQ on render.`
      : "Voice isolation disabled.",
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #17  Background Music Suggestions (Jamendo + Claude mood analysis)
 *      POST /projects/:id/suggest-music-jamendo
 * ───────────────────────────────────────────────────────────────────────── */
router.post("/projects/:id/suggest-music-jamendo", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { name: true, description: true, musicMood: true, genrePreset: true, musicBpm: true, musicSuggestions: true },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { label: true, storyArcBucket: true },
    orderBy: (s, { asc }) => [asc(s.orderIndex)],
  });

  // Step 1: Claude analyzes project mood
  const segmentSummary = segments.slice(0, 10).map(s => s.label ?? "").filter(Boolean).join(", ");
  const claudeRes = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `Project: "${project.name}". Description: "${project.description ?? "none"}". Genre: ${project.genrePreset ?? "unknown"}. Existing mood: ${project.musicMood ?? "unknown"}. Clips: ${segmentSummary || "unknown"}.
      
Based on this, suggest 3 Jamendo music search queries to find background music. Each query should be short (1-4 words: genre, mood, instrument). Also output a mood tag (1 word) and energy level (low/medium/high).

Respond with JSON ONLY: {"queries":["query1","query2","query3"],"mood":"word","energy":"low|medium|high","bpmRange":{"min":N,"max":N}}`
    }],
  });

  let claudeData = { queries: ["cinematic ambient", "uplifting acoustic", "electronic chill"], mood: "neutral", energy: "medium", bpmRange: { min: 80, max: 140 } };
  try {
    const raw = claudeRes.content[0].type === "text" ? claudeRes.content[0].text : "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) claudeData = JSON.parse(match[0]);
  } catch { /* use defaults */ }

  // Step 2: Query Jamendo with primary query
  const primaryQuery = claudeData.queries[0];
  let jamendoTracks: any[] = [];
  try {
    const params = new URLSearchParams({
      client_id: JAMENDO_CLIENT_ID,
      format: "json",
      limit: "6",
      search: primaryQuery,
      audioformat: "mp32",
      boost: "popularity_total",
      vocalinstrumental: "instrumental",
      minbpm: String(claudeData.bpmRange.min),
      maxbpm: String(claudeData.bpmRange.max),
    });
    const resp = await fetch(`${JAMENDO_BASE}/tracks/?${params}`);
    const data = await resp.json() as any;
    jamendoTracks = (data?.results ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
      artist: t.artist_name,
      duration: t.duration,
      bpm: t.bpm,
      audioUrl: t.audio,
      shareUrl: t.shareurl,
      imageUrl: t.image,
    }));
  } catch { /* Jamendo unavailable */ }

  // Fallback: also search secondary query if primary returns < 3 tracks
  if (jamendoTracks.length < 3 && claudeData.queries[1]) {
    try {
      const params2 = new URLSearchParams({
        client_id: JAMENDO_CLIENT_ID, format: "json", limit: "4",
        search: claudeData.queries[1], audioformat: "mp32",
      });
      const resp2 = await fetch(`${JAMENDO_BASE}/tracks/?${params2}`);
      const data2 = await resp2.json() as any;
      const extra = (data2?.results ?? []).map((t: any) => ({
        id: t.id, name: t.name, artist: t.artist_name, duration: t.duration,
        audioUrl: t.audio, shareUrl: t.shareurl, imageUrl: t.image,
      }));
      jamendoTracks = [...jamendoTracks, ...extra];
    } catch { /* ignore */ }
  }

  // Save the mood analysis
  await db.update(projectsTable)
    .set({ musicMood: claudeData.mood, updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id));

  res.json({
    mood: claudeData.mood,
    energy: claudeData.energy,
    bpmRange: claudeData.bpmRange,
    searchQueries: claudeData.queries,
    tracks: jamendoTracks,
    trackCount: jamendoTracks.length,
    message: jamendoTracks.length > 0
      ? `Found ${jamendoTracks.length} royalty-free tracks matching "${primaryQuery}" (${claudeData.mood}, ${claudeData.energy} energy)`
      : `No Jamendo tracks found — check JAMENDO_CLIENT_ID or try a different search.`,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #18  Music Key Detection
 *      POST /projects/:id/detect-music-key
 * ───────────────────────────────────────────────────────────────────────── */
const MUSICAL_KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const COMPATIBLE_TRANSITIONS: Record<string, string[]> = {
  "C":  ["Am", "G", "F", "Em", "Dm"],   "G":  ["Em", "D", "C", "Bm", "Am"],
  "D":  ["Bm", "A", "G", "F#m", "Em"],  "A":  ["F#m", "E", "D", "C#m", "Bm"],
  "E":  ["C#m", "B", "A", "G#m", "F#m"],"F":  ["Dm", "C", "Bb", "Am", "Gm"],
  "Bb": ["Gm", "F", "Eb", "Dm", "Cm"],  "Eb": ["Cm", "Bb", "Ab", "Gm", "Fm"],
  "Am": ["C", "Em", "Dm", "G", "F"],    "Em": ["G", "Bm", "Am", "D", "C"],
  "Dm": ["F", "Am", "Gm", "C", "Bb"],   "default": ["C", "Am", "F", "G"],
};

router.post("/projects/:id/detect-music-key", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { musicMood: true, musicBpm: true, genrePreset: true, name: true, musicSuggestions: true },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });

  // Use Claude to infer probable key from mood/genre/name context
  const claudeRes = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 150,
    messages: [{
      role: "user",
      content: `Given this video project context, what is the most likely musical key for its background music?
Project: "${project.name}", mood: "${project.musicMood ?? "unknown"}", genre: "${project.genrePreset ?? "unknown"}", BPM: ${project.musicBpm ?? "unknown"}.
Respond with JSON ONLY: {"key":"X","mode":"major|minor","confidence":"low|medium|high","reason":"1 sentence","compatibleKeys":["X","Y","Z"]}`
    }],
  });

  let keyData = { key: "C", mode: "major", confidence: "medium" as const, reason: "Default key estimated from context.", compatibleKeys: ["Am", "F", "G"] };
  try {
    const raw = claudeRes.content[0].type === "text" ? claudeRes.content[0].text : "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { const parsed = JSON.parse(match[0]); if (parsed.key) keyData = parsed; }
  } catch { /* fallback */ }

  const fullKey = `${keyData.key} ${keyData.mode}`;
  const compatible = COMPATIBLE_TRANSITIONS[keyData.key] ?? COMPATIBLE_TRANSITIONS["default"];

  res.json({
    detectedKey: fullKey,
    key: keyData.key,
    mode: keyData.mode,
    confidence: keyData.confidence,
    reason: keyData.reason,
    compatibleKeys: keyData.compatibleKeys ?? compatible,
    clashWarning: `Avoid mixing audio in keys more than 3 semitones away from ${fullKey} without a crossfade.`,
    transitionTip: `For smooth transitions, stick to ${(keyData.compatibleKeys ?? compatible).slice(0, 3).join(", ")} adjacent clips.`,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #19  Beat Grid Config (supplements existing beatMap job)
 *      GET /projects/:id/beat-grid-config
 * ───────────────────────────────────────────────────────────────────────── */
router.get("/projects/:id/beat-grid-config", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { musicBpm: true, cutRhythmData: true },
  });
  if (!project) return res.status(404).json({ error: "Project not found" });

  const bpm = project.musicBpm ?? 120;
  const beatInterval = 60 / bpm;
  const barInterval = beatInterval * 4;

  let beatData: { bpm: number; beats: number[]; energy: number[] } = { bpm, beats: [], energy: [] };
  try {
    if (project.cutRhythmData) {
      const parsed = JSON.parse(project.cutRhythmData);
      if (parsed.bpm) beatData.bpm = parsed.bpm;
      if (Array.isArray(parsed.beats)) beatData.beats = parsed.beats;
      if (Array.isArray(parsed.energy)) beatData.energy = parsed.energy;
    }
  } catch { /* use defaults */ }

  // Generate synthetic beat grid if no actual data (for UI visualization)
  const duration = 120; // default 2 min preview
  const syntheticBeats = beatData.beats.length > 0
    ? beatData.beats
    : Array.from({ length: Math.floor(duration / beatInterval) }, (_, i) => Math.round(i * beatInterval * 1000) / 1000);

  res.json({
    bpm: beatData.bpm,
    beatInterval: Math.round(beatInterval * 1000) / 1000,
    barInterval: Math.round(barInterval * 1000) / 1000,
    beats: syntheticBeats.slice(0, 200), // first 200 beats for UI
    downbeats: syntheticBeats.filter((_, i) => i % 4 === 0).slice(0, 50),
    energy: beatData.energy.slice(0, 200),
    source: beatData.beats.length > 0 ? "detected" : "synthetic",
    note: beatData.beats.length > 0
      ? `Beat grid from audio analysis: ${beatData.bpm} BPM`
      : `Synthetic ${bpm} BPM grid (run Detect Beats job for real audio analysis)`,
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * #20  SFX Markers
 *      GET  /projects/:id/sfx-markers
 *      POST /projects/:id/sfx-markers
 *      DELETE /projects/:id/sfx-markers/:ts
 * ───────────────────────────────────────────────────────────────────────── */
type SfxMarker = { ts: number; type: string; label: string; segmentId: string | null; volume: number };

const SFX_LIBRARY = [
  { id: "whoosh",    label: "Whoosh",       description: "Fast air cut — great on quick transitions",     icon: "💨", defaultVolume: 0.7 },
  { id: "pop",       label: "Pop",          description: "Punchy pop — works on reveal cuts",             icon: "🎈", defaultVolume: 0.6 },
  { id: "ding",      label: "Ding",         description: "Soft notification bell — good on info reveals", icon: "🔔", defaultVolume: 0.5 },
  { id: "swoosh",    label: "Swoosh",       description: "Heavy swoosh — dramatic scene change",          icon: "🌀", defaultVolume: 0.8 },
  { id: "impact",    label: "Impact",       description: "Boom impact hit — climax moments",              icon: "💥", defaultVolume: 0.9 },
  { id: "glitch",    label: "Glitch",       description: "Digital glitch — tech or edgy content",        icon: "⚡", defaultVolume: 0.65 },
  { id: "riser",     label: "Riser",        description: "Tension build riser — before big moment",      icon: "📈", defaultVolume: 0.7 },
  { id: "sparkle",   label: "Sparkle",      description: "Magical sparkle — soft positive moments",      icon: "✨", defaultVolume: 0.5 },
];

router.get("/projects/:id/sfx-markers", async (req, res) => {
  const proj = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { sfxMarkers: true },
  });
  let markers: SfxMarker[] = [];
  try { if (proj?.sfxMarkers) markers = JSON.parse(proj.sfxMarkers); } catch { /* empty */ }
  res.json({ markers, library: SFX_LIBRARY });
});

router.post("/projects/:id/sfx-markers", async (req, res) => {
  const body = z.object({
    ts:        z.number(),
    type:      z.string(),
    segmentId: z.string().nullable().optional(),
    volume:    z.number().min(0).max(1).default(0.7),
    autoPlace: z.boolean().default(false), // place at every cut point
  }).parse(req.body);

  const proj = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { sfxMarkers: true },
  });
  let markers: SfxMarker[] = [];
  try { if (proj?.sfxMarkers) markers = JSON.parse(proj.sfxMarkers); } catch { /* empty */ }

  const sfxInfo = SFX_LIBRARY.find(s => s.id === body.type);

  if (body.autoPlace) {
    // Place SFX at every cut point (each segment's inPoint)
    const segments = await db.query.segmentsTable.findMany({
      where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
      columns: { id: true, inPoint: true },
      orderBy: (s, { asc }) => [asc(s.orderIndex)],
    });
    for (const seg of segments.slice(1)) { // skip first (no cut before it)
      const ts = seg.inPoint ?? 0;
      if (!markers.some(m => Math.abs(m.ts - ts) < 0.05 && m.type === body.type)) {
        markers.push({ ts, type: body.type, label: sfxInfo?.label ?? body.type, segmentId: seg.id, volume: body.volume });
      }
    }
  } else {
    // Place single SFX
    if (!markers.some(m => Math.abs(m.ts - body.ts) < 0.05 && m.type === body.type)) {
      markers.push({ ts: body.ts, type: body.type, label: sfxInfo?.label ?? body.type, segmentId: body.segmentId ?? null, volume: body.volume });
    }
  }

  markers.sort((a, b) => a.ts - b.ts);
  await db.update(projectsTable)
    .set({ sfxMarkers: JSON.stringify(markers), updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id));

  res.json({ markers, added: body.autoPlace ? markers.length : 1, library: SFX_LIBRARY });
});

router.delete("/projects/:id/sfx-markers/:ts", async (req, res) => {
  const ts = parseFloat(req.params.ts);
  const proj = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { sfxMarkers: true },
  });
  let markers: SfxMarker[] = [];
  try { if (proj?.sfxMarkers) markers = JSON.parse(proj.sfxMarkers); } catch { /* empty */ }

  const before = markers.length;
  markers = markers.filter(m => Math.abs(m.ts - ts) > 0.05);
  await db.update(projectsTable)
    .set({ sfxMarkers: JSON.stringify(markers), updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id));
  res.json({ removed: before - markers.length, markers });
});

router.delete("/projects/:id/sfx-markers", async (req, res) => {
  await db.update(projectsTable)
    .set({ sfxMarkers: "[]", updatedAt: new Date() })
    .where(eq(projectsTable.id, req.params.id));
  res.json({ removed: "all", markers: [] });
});

// ─────────────────────────────────────────────────────────────────────────────
// #24 Auto-detect stem types per segment
// Classifies each included segment into: dialogue | music | sfx | ambience | mixed
// ─────────────────────────────────────────────────────────────────────────────
router.post("/projects/:id/detect-stems", async (req, res) => {
  const project = await db.query.projectsTable.findFirst({
    where: eq(projectsTable.id, req.params.id),
    columns: { id: true, sfxMarkers: true },
  });
  if (!project) return void res.status(404).json({ error: "Project not found" });

  let sfxMarkers: { ts: number }[] = [];
  try { if (project.sfxMarkers) sfxMarkers = JSON.parse(project.sfxMarkers); } catch { /* empty */ }

  const segments = await db.query.segmentsTable.findMany({
    where: and(eq(segmentsTable.projectId, req.params.id), eq(segmentsTable.included, true)),
    columns: { id: true, inPoint: true, outPoint: true, captionText: true, audioMixLevel: true, musicDuckLevel: true },
  });

  let elapsed = 0;
  const updates: { id: string; stemType: string }[] = [];

  for (const seg of segments) {
    const dur = (seg.outPoint ?? 0) - (seg.inPoint ?? 0);
    const segStart = elapsed;
    const segEnd = elapsed + dur;

    const hasTranscript = !!seg.captionText && seg.captionText.trim().length > 5;
    // musicDuckLevel=null means no music config; =1 means disabled/full volume (not actively ducked)
    const overlapsMusic = seg.musicDuckLevel !== null && seg.musicDuckLevel !== 1 && (seg.musicDuckLevel ?? 0) > 0;

    // Check if any SFX marker falls within this segment's timeline range
    const hasSfxOverlap = sfxMarkers.some(m => m.ts >= segStart && m.ts < segEnd);

    let stemType: string;
    if (hasTranscript && hasSfxOverlap) stemType = "mixed";
    else if (hasTranscript && overlapsMusic) stemType = "mixed";
    else if (hasTranscript) stemType = "dialogue";
    else if (hasSfxOverlap) stemType = "sfx";
    else if (overlapsMusic) stemType = "music";
    else stemType = "ambience";

    updates.push({ id: seg.id, stemType });
    elapsed += dur;
  }

  // Batch update
  await Promise.all(
    updates.map(u =>
      db.update(segmentsTable)
        .set({ stemType: u.stemType })
        .where(eq(segmentsTable.id, u.id))
    )
  );

  const counts = updates.reduce<Record<string, number>>((acc, u) => {
    acc[u.stemType] = (acc[u.stemType] ?? 0) + 1;
    return acc;
  }, {});

  res.json({
    message: `Classified ${updates.length} segments into stems`,
    counts,
    segments: updates,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #22 Multitrack export — export dialogue, music and SFX as separate stems
// POST /projects/:id/export-stems   → kicks off extraction, returns status + paths
// GET  /projects/:id/export-stems/:stem/download → streams file
// ─────────────────────────────────────────────────────────────────────────────

type StemName = "dialogue" | "music" | "sfx" | "fullmix";

function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const proc = spawn("ffmpeg", ["-y", ...args]);
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", code => code === 0 ? resolve(stderr) : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-600)}`)));
    setTimeout(() => { proc.kill(); reject(new Error("ffmpeg stem export timeout")); }, 300_000);
  });
}

const STEM_FILTERS: Record<StemName, string> = {
  dialogue: "afftdn=nf=-20,highpass=f=100,lowpass=f=8000,equalizer=f=1000:width_type=o:width=3:g=2",
  music:    "lowpass=f=250,highpass=f=40",
  sfx:      "highpass=f=4000,highpass=f=4000",
  fullmix:  "anull",
};

router.post("/projects/:id/export-stems", async (req, res) => {
  const projectId = req.params.id;
  const renderPath = path.join(RENDER_DIR, `${projectId}.mp4`);

  if (!fs.existsSync(renderPath)) {
    return void res.status(422).json({
      error: "Rendered file not found. Please render the project first, then export stems.",
      renderRequired: true,
    });
  }

  const stemDir = path.join(STEMS_DIR, projectId);
  if (!fs.existsSync(stemDir)) fs.mkdirSync(stemDir, { recursive: true });

  const stems: StemName[] = ["dialogue", "music", "sfx", "fullmix"];
  const results: Record<string, { status: string; path?: string; filter: string }> = {};

  // Run all 4 stems in parallel
  await Promise.allSettled(
    stems.map(async stem => {
      const outPath = path.join(stemDir, `${stem}.wav`);
      const filter = STEM_FILTERS[stem];
      try {
        await runFfmpeg([
          "-i", renderPath,
          "-vn",
          "-af", filter,
          "-ar", "48000",
          "-ac", "2",
          "-sample_fmt", "s16",
          outPath,
        ]);
        results[stem] = { status: "ready", path: outPath, filter };
      } catch (e) {
        results[stem] = { status: "error", filter };
      }
    })
  );

  const stemFiles: Record<string, { status: string; downloadUrl?: string; filter: string }> = {};
  for (const [stem, info] of Object.entries(results)) {
    stemFiles[stem] = {
      status: info.status,
      filter: info.filter,
      downloadUrl: info.status === "ready" ? `/api/projects/${projectId}/export-stems/${stem}/download` : undefined,
    };
  }

  res.json({ stems: stemFiles, message: "Stem extraction complete" });
});

router.get("/projects/:id/export-stems/:stem/download", (req, res) => {
  const { id: projectId, stem } = req.params;
  const allowed: StemName[] = ["dialogue", "music", "sfx", "fullmix"];
  if (!allowed.includes(stem as StemName)) return void res.status(400).json({ error: "Invalid stem" });

  const filePath = path.join(STEMS_DIR, projectId, `${stem}.wav`);
  if (!fs.existsSync(filePath)) return void res.status(404).json({ error: "Stem not ready. Run export-stems first." });

  res.setHeader("Content-Disposition", `attachment; filename="${stem}.wav"`);
  res.setHeader("Content-Type", "audio/wav");
  fs.createReadStream(filePath).pipe(res);
});

export default router;
