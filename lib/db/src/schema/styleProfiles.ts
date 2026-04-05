import { pgTable, text, real, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const styleProfilesTable = pgTable("style_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  targetAudience: text("target_audience"),
  pacing: text("pacing").notNull().default("medium"),
  cutStyle: text("cut_style").notNull().default("hard"),
  transitionStyle: text("transition_style").notNull().default("cut"),
  colorGrade: text("color_grade").notNull().default("none"),
  musicMood: text("music_mood"),
  hookStrategy: text("hook_strategy"),
  formatPreferences: text("format_preferences"),
  systemPromptOverride: text("system_prompt_override"),
  exampleProjectIds: text("example_project_ids"),
  // ── #1 Edit style cloning — reference video analysis results ────────────
  referenceVideoIds: text("reference_video_ids"),        // JSON: string[]
  avgCutFrequency: real("avg_cut_frequency"),            // cuts per second
  avgSegDuration: real("avg_seg_duration"),              // seconds
  genre: text("genre"),                                  // documentary|tutorial|vlog|ad|short_film
  cutTypeDistribution: text("cut_type_distribution"),   // JSON: {hard,j-cut,l-cut,match-cut,dissolve}
  learnedFromProjects: text("learned_from_projects"),   // JSON: string[]
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertStyleProfileSchema = createInsertSchema(styleProfilesTable).omit({ createdAt: true, updatedAt: true });
export type InsertStyleProfile = z.infer<typeof insertStyleProfileSchema>;
export type StyleProfile = typeof styleProfilesTable.$inferSelect;
