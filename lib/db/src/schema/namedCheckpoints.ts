import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const namedCheckpointsTable = pgTable("named_checkpoints", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  segmentsSnapshot: text("segments_snapshot").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertNamedCheckpointSchema = createInsertSchema(namedCheckpointsTable).omit({ createdAt: true });
export type InsertNamedCheckpoint = z.infer<typeof insertNamedCheckpointSchema>;
export type NamedCheckpoint = typeof namedCheckpointsTable.$inferSelect;
