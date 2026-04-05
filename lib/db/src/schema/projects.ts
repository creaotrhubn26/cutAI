import { pgTable, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const projectsTable = pgTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  targetFormat: text("target_format").notNull(),
  status: text("status").notNull().default("draft"),
  thumbnailUrl: text("thumbnail_url"),
  durationSeconds: real("duration_seconds"),
  audioPreset: text("audio_preset"),
  audioEnhancementPlan: text("audio_enhancement_plan"),
  musicBpm: real("music_bpm"),
  musicMood: text("music_mood"),
  manuscript: text("manuscript"),
  manuscriptAnalysis: text("manuscript_analysis"),
  qualityRating: integer("quality_rating"),
  styleProfileId: text("style_profile_id"),
  cutRhythmData: text("cut_rhythm_data"),
  musicSuggestions: text("music_suggestions"),
  pacingSuggestions: text("pacing_suggestions"),
  customVocabulary: text("custom_vocabulary"),
  // ── #2 Pacing envelope — JSON: [{start, end, pace: "fast"|"slow"|"normal", targetCutSec?}]
  pacingEnvelope: text("pacing_envelope"),
  // ── #3 Genre preset (documentary|tutorial|vlog|ad|short_film|social_media|music_video)
  genrePreset: text("genre_preset"),
  // ── #6 Rejected cut point heat map — JSON: [{ts, reason, confidence, considered}[]]
  rejectedCutPoints: text("rejected_cut_points"),
  // ── #8 Edit diversity guard — prevents same cut type appearing 3+ times in a row
  editDiversityGuard: boolean("edit_diversity_guard").default(true),
  // ── #9 Platform pacing target (tiktok|youtube|linkedin|instagram|custom)
  platformPacingTarget: text("platform_pacing_target"),
  // ── Audio processing suite — JSON config for de-esser, voice isolation, wind noise, ducking
  audioProcessingConfig: text("audio_processing_config"),
  // ── SFX markers — JSON: [{ts, type, segmentId, label}[]]
  sfxMarkers: text("sfx_markers"),
  // ── LUT library — JSON: [{id, name, path, sizeBytes, uploadedAt}[]]
  lutLibrary: text("lut_library"),
  // ── Batch export config — JSON: {aspectRatios: string[], outputDir: string}
  batchExportConfig: text("batch_export_config"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projectsTable).omit({ createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projectsTable.$inferSelect;
