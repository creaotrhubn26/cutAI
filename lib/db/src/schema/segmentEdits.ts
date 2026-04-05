import { pgTable, text, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const segmentEditsTable = pgTable("segment_edits", {
  id: text("id").primaryKey(),
  segmentId: text("segment_id").notNull(),
  projectId: text("project_id").notNull(),
  videoId: text("video_id"),
  editType: text("edit_type").notNull(),
  // Canonical per-field diff contract:
  //   field     = name of the changed field (startTime, endTime, orderIndex, included, …)
  //   aiValue   = the AI-proposed value (serialized to text)
  //   humanValue = the human-corrected value (serialized to text)
  //   editedAt  = when the human made the change (matches createdAt; explicit per spec)
  field: text("field"),
  aiValue: text("ai_value"),
  humanValue: text("human_value"),
  editedAt: timestamp("edited_at").notNull().defaultNow(),
  // Rich numeric columns for convenient UI rendering
  aiStartTime: real("ai_start_time"),
  humanStartTime: real("human_start_time"),
  aiEndTime: real("ai_end_time"),
  humanEndTime: real("human_end_time"),
  aiOrderIndex: real("ai_order_index"),
  humanOrderIndex: real("human_order_index"),
  aiIncluded: boolean("ai_included"),
  humanIncluded: boolean("human_included"),
  deltaStartSeconds: real("delta_start_seconds"),
  deltaEndSeconds: real("delta_end_seconds"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSegmentEditSchema = createInsertSchema(segmentEditsTable).omit({ createdAt: true, editedAt: true });
export type InsertSegmentEdit = z.infer<typeof insertSegmentEditSchema>;
export type SegmentEdit = typeof segmentEditsTable.$inferSelect;
