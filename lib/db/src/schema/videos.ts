import { pgTable, text, integer, bigint, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const videosTable = pgTable("videos", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  filename: text("filename").notNull(),
  originalName: text("original_name").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  durationSeconds: real("duration_seconds"),
  width: integer("width"),
  height: integer("height"),
  fps: real("fps"),
  filePath: text("file_path").notNull(),
  status: text("status").notNull().default("uploading"),
  transcript: text("transcript"),
  sceneAnalysis: text("scene_analysis"),
  beatData: text("beat_data"),
  clipAnalysis: text("clip_analysis"),
  proxyPath: text("proxy_path"),
  driveFileId: text("drive_file_id"),
  driveProxyFileId: text("drive_proxy_file_id"),
  driveSource: text("drive_source"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertVideoSchema = createInsertSchema(videosTable).omit({ createdAt: true });
export type InsertVideo = z.infer<typeof insertVideoSchema>;
export type Video = typeof videosTable.$inferSelect;
