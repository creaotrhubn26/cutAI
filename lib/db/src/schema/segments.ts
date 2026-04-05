import { pgTable, text, integer, real, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const segmentsTable = pgTable("segments", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  videoId: text("video_id").notNull(),
  orderIndex: integer("order_index").notNull(),
  startTime: real("start_time").notNull(),
  endTime: real("end_time").notNull(),
  label: text("label"),
  segmentType: text("segment_type").notNull().default("action"),
  confidence: real("confidence"),
  aiReason: text("ai_reason"),
  included: boolean("included").notNull().default(true),
  speedFactor: real("speed_factor").default(1.0),
  speedRampStart: real("speed_ramp_start"),
  speedRampEnd: real("speed_ramp_end"),
  speedCurve: text("speed_curve").default("linear"),
  reverse: boolean("reverse").default(false),
  freeze: boolean("freeze").default(false),
  audioEnhancement: text("audio_enhancement"),
  colorGrade: text("color_grade").default("none"),
  transitionIn: text("transition_in").default("cut"),
  transitionInDuration: real("transition_in_duration").default(0.5),
  captionText: text("caption_text"),
  captionStyle: text("caption_style").default("none"),
  // Audio mixing — music ducking during speech, clip audio level
  audioMixLevel: real("audio_mix_level").default(1.0),   // 0-1: clip's own audio level
  musicDuckLevel: real("music_duck_level").default(1.0), // 0-1: background music level during this clip
  // AI graphic overlays — JSON array of GraphicOverlay objects (text, font, position, color, etc.)
  graphicOverlays: text("graphic_overlays"),
  // Silence trim history — JSON: {originalStart, originalEnd, startTrimmedSec, endTrimmedSec, trimmedAt}
  silenceTrimInfo: text("silence_trim_info"),
  // Slip edit — source media in/out crop points (independent of timeline startTime/endTime)
  inPoint: real("in_point"),   // source media start offset (seconds); null = same as startTime
  outPoint: real("out_point"), // source media end offset (seconds); null = same as endTime
  // Lift delete — leaves a gap placeholder instead of ripple-shifting
  isGap: boolean("is_gap").default(false),
  // Nested sequences — segments inside a compound clip reference the compound's segment id
  compoundClipId: text("compound_clip_id"),
  // Three-point editing — source video reference and marks
  sourceVideoId: text("source_video_id"),
  // #14 Optical-flow slow-motion (minterpolate in FFmpeg for smooth slo-mo)
  opticalFlow: boolean("optical_flow").default(false),
  // #15 Freeze frame — holds last frame for freezeDuration seconds after clip
  freezeDuration: real("freeze_duration").default(2.0),
  // #13 Speed ramp bezier curve control points (JSON: [{t,v},...])
  speedCurvePoints: text("speed_curve_points"),
  // #4 Story arc bucket (hook | buildup | conflict | climax | resolution | cta)
  storyArcBucket: text("story_arc_bucket"),
  // Cut type used in the final edit (hard-cut | j-cut | l-cut | match-cut | dissolve | wipe)
  cutTypeFinal: text("cut_type_final"),
  // Stem classification (dialogue | music | sfx | ambience | mixed)
  stemType: text("stem_type"),
  // Color pipeline additions
  lutFile: text("lut_file"),           // Applied LUT filename (references project lutLibrary)
  wbCorrection: text("wb_correction"), // JSON: {r,g,b} colorbalance offsets from auto-WB
  exposureNorm: text("exposure_norm"), // JSON: {brightness,contrast} eq filter params from exposure normalization
  horizonAngle: real("horizon_angle"), // Degrees to rotate for horizon leveling (negative=CCW)
  frameInterpFps: integer("frame_interp_fps"), // Target FPS for frame interpolation (null=disabled)
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSegmentSchema = createInsertSchema(segmentsTable).omit({ createdAt: true });
export type InsertSegment = z.infer<typeof insertSegmentSchema>;
export type Segment = typeof segmentsTable.$inferSelect;
