import { pgTable, text, real, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const audioTracksTable = pgTable("audio_tracks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  trackType: text("track_type").notNull().default("dialogue"), // "dialogue"|"music"|"sfx"|"ambient"
  volume: real("volume").notNull().default(1.0),    // 0.0–2.0
  pan: real("pan").notNull().default(0.0),          // -1.0 (L) to 1.0 (R)
  mute: boolean("mute").notNull().default(false),
  solo: boolean("solo").notNull().default(false),
  color: text("color").notNull().default("blue"),   // track accent color
  orderIndex: integer("order_index").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const audioKeyframesTable = pgTable("audio_keyframes", {
  id: text("id").primaryKey(),
  trackId: text("track_id").notNull(),
  timestamp: real("timestamp").notNull(),  // seconds from timeline start
  volume: real("volume").notNull(),        // 0.0–2.0 rubber-band value
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertAudioTrackSchema = createInsertSchema(audioTracksTable).omit({ createdAt: true });
export const insertAudioKeyframeSchema = createInsertSchema(audioKeyframesTable).omit({ createdAt: true });
export type InsertAudioTrack = z.infer<typeof insertAudioTrackSchema>;
export type InsertAudioKeyframe = z.infer<typeof insertAudioKeyframeSchema>;
export type AudioTrack = typeof audioTracksTable.$inferSelect;
export type AudioKeyframe = typeof audioKeyframesTable.$inferSelect;
