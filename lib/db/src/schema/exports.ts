import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const exportsTable = pgTable("exports", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  format: text("format").notNull().default("mp4"),
  resolution: text("resolution").notNull().default("1080p"),
  status: text("status").notNull().default("pending"),
  progress: integer("progress").notNull().default(0),
  filePath: text("file_path"),
  fileSize: integer("file_size"),
  downloadUrl: text("download_url"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
});

export const insertExportSchema = createInsertSchema(exportsTable).omit({ createdAt: true });
export type InsertExport = z.infer<typeof insertExportSchema>;
export type Export = typeof exportsTable.$inferSelect;
