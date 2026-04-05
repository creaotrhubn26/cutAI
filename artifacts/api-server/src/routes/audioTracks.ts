import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { audioTracksTable, audioKeyframesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

const TrackBody = z.object({
  name: z.string(),
  trackType: z.enum(["dialogue", "music", "sfx", "ambient"]).optional().default("dialogue"),
  volume: z.number().min(0).max(2).optional().default(1.0),
  pan: z.number().min(-1).max(1).optional().default(0),
  mute: z.boolean().optional().default(false),
  solo: z.boolean().optional().default(false),
  color: z.string().optional().default("blue"),
  orderIndex: z.number().int().optional().default(0),
});

const TrackPatch = z.object({
  name: z.string().optional(),
  trackType: z.enum(["dialogue", "music", "sfx", "ambient"]).optional(),
  volume: z.number().min(0).max(2).optional(),
  pan: z.number().min(-1).max(1).optional(),
  mute: z.boolean().optional(),
  solo: z.boolean().optional(),
  color: z.string().optional(),
  orderIndex: z.number().int().optional(),
});

const KeyframeBody = z.object({
  timestamp: z.number(),
  volume: z.number().min(0).max(2),
});

const KeyframePatch = z.object({
  timestamp: z.number().optional(),
  volume: z.number().min(0).max(2).optional(),
});

function serTrack(t: typeof audioTracksTable.$inferSelect) {
  return { ...t, createdAt: t.createdAt.toISOString() };
}
function serKf(k: typeof audioKeyframesTable.$inferSelect) {
  return { ...k, createdAt: k.createdAt.toISOString() };
}

router.get("/projects/:id/audio-tracks", async (req, res) => {
  const { id } = req.params;
  const tracks = await db
    .select()
    .from(audioTracksTable)
    .where(eq(audioTracksTable.projectId, id))
    .orderBy(audioTracksTable.orderIndex);
  const kfs = await db.select().from(audioKeyframesTable);
  const kfsByTrack: Record<string, typeof audioKeyframesTable.$inferSelect[]> = {};
  for (const kf of kfs) {
    if (!kfsByTrack[kf.trackId]) kfsByTrack[kf.trackId] = [];
    kfsByTrack[kf.trackId].push(kf);
  }
  res.json(tracks.map(t => ({ ...serTrack(t), keyframes: (kfsByTrack[t.id] ?? []).map(serKf).sort((a, b) => a.timestamp - b.timestamp) })));
});

router.post("/projects/:id/audio-tracks", async (req, res) => {
  const { id } = req.params;
  const body = TrackBody.parse(req.body);
  const [track] = await db.insert(audioTracksTable).values({ id: randomUUID(), projectId: id, ...body }).returning();
  res.status(201).json({ ...serTrack(track), keyframes: [] });
});

router.patch("/audio-tracks/:id", async (req, res) => {
  const { id } = req.params;
  const body = TrackPatch.parse(req.body);
  const updates: Partial<typeof audioTracksTable.$inferInsert> = {};
  if (body.name != null) updates.name = body.name;
  if (body.trackType != null) updates.trackType = body.trackType;
  if (body.volume != null) updates.volume = body.volume;
  if (body.pan != null) updates.pan = body.pan;
  if (body.mute != null) updates.mute = body.mute;
  if (body.solo != null) updates.solo = body.solo;
  if (body.color != null) updates.color = body.color;
  if (body.orderIndex != null) updates.orderIndex = body.orderIndex;
  const [track] = await db.update(audioTracksTable).set(updates).where(eq(audioTracksTable.id, id)).returning();
  if (!track) return res.status(404).json({ error: "Track not found" });
  res.json(serTrack(track));
});

router.delete("/audio-tracks/:id", async (req, res) => {
  const { id } = req.params;
  await db.delete(audioKeyframesTable).where(eq(audioKeyframesTable.trackId, id));
  await db.delete(audioTracksTable).where(eq(audioTracksTable.id, id));
  res.status(204).send();
});

router.get("/audio-tracks/:id/keyframes", async (req, res) => {
  const { id } = req.params;
  const kfs = await db.select().from(audioKeyframesTable).where(eq(audioKeyframesTable.trackId, id)).orderBy(audioKeyframesTable.timestamp);
  res.json(kfs.map(serKf));
});

router.post("/audio-tracks/:id/keyframes", async (req, res) => {
  const { id } = req.params;
  const body = KeyframeBody.parse(req.body);
  const [kf] = await db.insert(audioKeyframesTable).values({ id: randomUUID(), trackId: id, ...body }).returning();
  res.status(201).json(serKf(kf));
});

router.patch("/keyframes/:id", async (req, res) => {
  const { id } = req.params;
  const body = KeyframePatch.parse(req.body);
  const updates: Partial<typeof audioKeyframesTable.$inferInsert> = {};
  if (body.timestamp != null) updates.timestamp = body.timestamp;
  if (body.volume != null) updates.volume = body.volume;
  const [kf] = await db.update(audioKeyframesTable).set(updates).where(eq(audioKeyframesTable.id, id)).returning();
  if (!kf) return res.status(404).json({ error: "Keyframe not found" });
  res.json(serKf(kf));
});

router.delete("/keyframes/:id", async (req, res) => {
  const { id } = req.params;
  await db.delete(audioKeyframesTable).where(eq(audioKeyframesTable.id, id));
  res.status(204).send();
});

export default router;
