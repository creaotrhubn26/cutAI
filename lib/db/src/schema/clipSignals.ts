import { pgTable, text, integer, real, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clipSignalsTable = pgTable("clip_signals", {
  id: text("id").primaryKey(),
  videoId: text("video_id").notNull(),
  projectId: text("project_id").notNull(),
  signalType: text("signal_type").notNull(),
  severity: real("severity").notNull().default(0),
  timeStart: real("time_start"),
  timeEnd: real("time_end"),
  frameCount: integer("frame_count"),
  details: jsonb("details").default({}),
  detectedBy: text("detected_by"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertClipSignalSchema = createInsertSchema(clipSignalsTable).omit({ createdAt: true });
export type InsertClipSignal = z.infer<typeof insertClipSignalSchema>;
export type ClipSignal = typeof clipSignalsTable.$inferSelect;
