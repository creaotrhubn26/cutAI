import { pgTable, text, real, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const editStylesTable = pgTable("edit_styles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),       // wedding | corporate | commercial | documentary | sports | music_video | travel | social_media
  subcategory: text("subcategory"),            // highlight | ceremony | testimonial | ad_spot | etc.
  description: text("description"),

  // Source — "builtin" = shipped with CutAI, "user" = learned from uploaded FCPXML
  source: text("source").notNull().default("builtin"),
  sourceFile: text("source_file"),             // original FCPXML filename if user-uploaded
  rawFcpxml: text("raw_fcpxml"),               // full FCPXML content (user-uploaded)

  // ── PACING DNA ──────────────────────────────────────────────
  avgClipDuration: real("avg_clip_duration"),  // seconds — average time per cut
  minClipDuration: real("min_clip_duration"),
  maxClipDuration: real("max_clip_duration"),
  cutsPerMinute: real("cuts_per_minute"),
  totalDuration: real("total_duration"),       // reference project total duration (s)
  clipCount: integer("clip_count"),

  // ── TRANSITION DNA ───────────────────────────────────────────
  transitionCutPct: real("transition_cut_pct"),       // 0-1 — fraction of cuts that are hard cuts
  transitionDissolvePct: real("transition_dissolve_pct"),
  transitionFadePct: real("transition_fade_pct"),
  transitionWipePct: real("transition_wipe_pct"),
  transitionZoomPct: real("transition_zoom_pct"),
  avgTransitionDuration: real("avg_transition_duration"), // seconds

  // ── COLOR GRADE DNA ──────────────────────────────────────────
  colorWarmPct: real("color_warm_pct"),
  colorCoolPct: real("color_cool_pct"),
  colorCinematicPct: real("color_cinematic_pct"),
  colorVividPct: real("color_vivid_pct"),
  colorMutedPct: real("color_muted_pct"),
  colorBwPct: real("color_bw_pct"),
  colorSunsetPct: real("color_sunset_pct"),
  colorTealOrangePct: real("color_teal_orange_pct"),
  colorDesaturatedPct: real("color_desaturated_pct"),
  colorNonePct: real("color_none_pct"),
  primaryColorGrade: text("primary_color_grade"),  // dominant grade name

  // ── SPEED DNA ────────────────────────────────────────────────
  avgSpeedFactor: real("avg_speed_factor"),    // 1.0 = normal, <1 = slow mo, >1 = fast
  slowMotionPct: real("slow_motion_pct"),      // fraction of clips in slow motion
  speedRampPct: real("speed_ramp_pct"),        // fraction of clips with speed ramps
  fastCutPct: real("fast_cut_pct"),            // fraction > 1.5x speed

  // ── AUDIO DNA ────────────────────────────────────────────────
  beatSyncStrength: real("beat_sync_strength"),     // 0-1: how tightly cuts snap to beats
  musicDuckOnSpeech: boolean("music_duck_on_speech").default(true), // duck music for speech
  musicDuckLevel: real("music_duck_level"),          // 0-1: music level during speech
  speechMixLevel: real("speech_mix_level"),          // 0-1: clip audio level during speech
  musicOnlyPct: real("music_only_pct"),              // fraction of clips with music only (no clip audio)

  // ── CAPTION DNA ──────────────────────────────────────────────
  captionFrequency: real("caption_frequency"),       // captions per minute
  captionStyle: text("caption_style"),               // subtitle | lower_third | title | kinetic | none
  captionOnSpeechPct: real("caption_on_speech_pct"), // fraction of speech clips with captions

  // ── EMOTIONAL ARC (JSON) ─────────────────────────────────────
  // Array of {beat: 0.0-1.0, emotion: "calm"|"build"|"peak"|"release"|"close"}
  emotionalArc: text("emotional_arc"),

  // ── METADATA ─────────────────────────────────────────────────
  verified: boolean("verified").default(false),      // human-verified professional style
  usageCount: integer("usage_count").default(0),     // how many times applied
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertEditStyleSchema = createInsertSchema(editStylesTable).omit({ createdAt: true, updatedAt: true });
export type InsertEditStyle = z.infer<typeof insertEditStyleSchema>;
export type EditStyle = typeof editStylesTable.$inferSelect;
