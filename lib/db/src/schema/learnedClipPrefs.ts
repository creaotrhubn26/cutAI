import { pgTable, text, real, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const learnedClipPrefsTable = pgTable("learned_clip_prefs", {
  id: text("id").primaryKey(),
  format: text("format").notNull(),
  clipType: text("clip_type"),
  tag: text("tag"),
  dimension: text("dimension"),
  avgPosition: real("avg_position").default(0.5),
  avgDuration: real("avg_duration").default(4.0),
  selectionRate: real("selection_rate").default(0.5),
  usageCount: integer("usage_count").default(0),
  lastUpdated: timestamp("last_updated").notNull().defaultNow(),
});

export const insertLearnedClipPrefSchema = createInsertSchema(learnedClipPrefsTable).omit({ lastUpdated: true });
export type InsertLearnedClipPref = z.infer<typeof insertLearnedClipPrefSchema>;
export type LearnedClipPref = typeof learnedClipPrefsTable.$inferSelect;
