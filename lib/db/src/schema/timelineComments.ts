import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const timelineCommentsTable = pgTable("timeline_comments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  timecode: real("timecode").notNull(),
  segmentId: text("segment_id"),
  authorName: text("author_name").notNull().default("Editor"),
  text: text("text").notNull(),
  parentId: text("parent_id"),
  resolved: text("resolved").default("false"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertTimelineCommentSchema = createInsertSchema(timelineCommentsTable).omit({ createdAt: true, updatedAt: true });
export type InsertTimelineComment = z.infer<typeof insertTimelineCommentSchema>;
export type TimelineComment = typeof timelineCommentsTable.$inferSelect;
