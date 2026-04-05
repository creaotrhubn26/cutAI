import { pgTable, text, real, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// One row per clip per completed project.
// This is the supervised ML dataset:
//   input:  feature vector (hookScore, emotionScore, clarityScore, motionIntensity, ...)
//   output: wasSelected (bool) + projectRating (1-5)
// Used to learn which feature weights actually predict "good edit".
export const clipTrainingPairsTable = pgTable("clip_training_pairs", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  videoId: text("video_id").notNull(),
  format: text("format").notNull(),
  projectRating: integer("project_rating"),   // 1-5 from user, null if not rated
  wasSelected: boolean("was_selected").notNull().default(false),

  // Feature vector — the ML model input
  hookScore: real("hook_score"),
  emotionScore: real("emotion_score"),
  clarityScore: real("clarity_score"),
  motionIntensity: real("motion_intensity"),
  bRollValue: real("b_roll_value"),
  visualQuality: real("visual_quality"),
  speakerChanges: integer("speaker_changes"),
  pauseCount: integer("pause_count"),
  energyVariance: real("energy_variance"),
  repetitionPenalty: real("repetition_penalty"),
  compositeScore: real("composite_score"),    // score at time of decision

  // Derived target — for regression training
  // positiveLabel = 1 if wasSelected AND rating >= 4, -1 if NOT selected AND rating <= 2, else 0
  label: real("label"),

  // Clip metadata for grouping/filtering
  clipType: text("clip_type"),
  durationSeconds: real("duration_seconds"),
  clipIndex: integer("clip_index"),           // position in the original footage

  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertClipTrainingPairSchema = createInsertSchema(clipTrainingPairsTable).omit({ createdAt: true });
export type InsertClipTrainingPair = z.infer<typeof insertClipTrainingPairSchema>;
export type ClipTrainingPair = typeof clipTrainingPairsTable.$inferSelect;
