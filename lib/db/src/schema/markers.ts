import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const markersTable = pgTable("markers", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  timestamp: real("timestamp").notNull(),         // seconds from timeline start
  label: text("label").notNull().default(""),
  color: text("color").notNull().default("yellow"), // "red"|"yellow"|"green"|"blue"|"orange"
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertMarkerSchema = createInsertSchema(markersTable).omit({ createdAt: true });
export type InsertMarker = z.infer<typeof insertMarkerSchema>;
export type Marker = typeof markersTable.$inferSelect;
