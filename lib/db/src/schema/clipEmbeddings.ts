import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const clipEmbeddingsTable = pgTable("clip_embeddings", {
  id: text("id").primaryKey(),
  videoId: text("video_id").notNull(),
  projectId: text("project_id").notNull(),
  model: text("model").notNull().default("text-embedding-3-small"),
  embedding: text("embedding").notNull(),
  inputText: text("input_text"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertClipEmbeddingSchema = createInsertSchema(clipEmbeddingsTable).omit({ createdAt: true });
export type InsertClipEmbedding = z.infer<typeof insertClipEmbeddingSchema>;
export type ClipEmbedding = typeof clipEmbeddingsTable.$inferSelect;
