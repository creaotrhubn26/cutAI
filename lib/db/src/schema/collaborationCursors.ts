import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const collaborationCursorsTable = pgTable("collaboration_cursors", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  sessionId: text("session_id").notNull(),
  displayName: text("display_name").notNull().default("Anonymous"),
  color: text("color").notNull().default("#a78bfa"),
  playhead: real("playhead").notNull().default(0),
  activeSegmentId: text("active_segment_id"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCollaborationCursorSchema = createInsertSchema(collaborationCursorsTable).omit({ updatedAt: true });
export type InsertCollaborationCursor = z.infer<typeof insertCollaborationCursorSchema>;
export type CollaborationCursor = typeof collaborationCursorsTable.$inferSelect;
