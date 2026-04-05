import { pgTable, text, integer, real, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const trainingExamplesTable = pgTable("training_examples", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  projectName: text("project_name"),
  format: text("format"),
  rawClips: jsonb("raw_clips").notNull().default([]),
  finalTimeline: jsonb("final_timeline").notNull().default([]),
  clipSelectionSignals: jsonb("clip_selection_signals").default({}),
  totalClipsAvailable: integer("total_clips_available").default(0),
  totalClipsUsed: integer("total_clips_used").default(0),
  avgClipDuration: real("avg_clip_duration"),
  totalDuration: real("total_duration"),
  beatSyncRate: real("beat_sync_rate"),
  qualityScore: integer("quality_score"),
  humanApproved: boolean("human_approved").default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTrainingExampleSchema = createInsertSchema(trainingExamplesTable).omit({ createdAt: true });
export type InsertTrainingExample = z.infer<typeof insertTrainingExampleSchema>;
export type TrainingExample = typeof trainingExamplesTable.$inferSelect;
