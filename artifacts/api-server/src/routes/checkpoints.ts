import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { namedCheckpointsTable, segmentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

function serialize(c: typeof namedCheckpointsTable.$inferSelect) {
  return { ...c, createdAt: c.createdAt.toISOString() };
}

router.get("/projects/:id/checkpoints", async (req, res) => {
  const checkpoints = await db.select().from(namedCheckpointsTable)
    .where(eq(namedCheckpointsTable.projectId, req.params.id))
    .orderBy(namedCheckpointsTable.createdAt);
  res.json(checkpoints.map(c => ({ ...serialize(c), segmentsSnapshot: undefined })));
});

router.post("/projects/:id/checkpoints", async (req, res) => {
  const body = z.object({ name: z.string().min(1), description: z.string().optional() }).parse(req.body);
  const segments = await db.select().from(segmentsTable)
    .where(eq(segmentsTable.projectId, req.params.id))
    .orderBy(segmentsTable.orderIndex);
  const snapshot = JSON.stringify(segments.map(s => ({
    id: s.id, orderIndex: s.orderIndex, startTime: s.startTime, endTime: s.endTime,
    included: s.included, speedFactor: s.speedFactor, colorGrade: s.colorGrade,
    label: s.label, segmentType: s.segmentType, videoId: s.videoId,
    reverse: s.reverse, freeze: s.freeze, freezeDuration: s.freezeDuration,
    opticalFlow: s.opticalFlow,
  })));
  const [checkpoint] = await db.insert(namedCheckpointsTable).values({
    id: randomUUID(),
    projectId: req.params.id,
    name: body.name,
    description: body.description ?? null,
    segmentsSnapshot: snapshot,
  }).returning();
  res.status(201).json({ ...serialize(checkpoint), segmentsSnapshot: undefined, segmentCount: segments.length });
});

router.post("/projects/:id/checkpoints/:checkId/restore", async (req, res) => {
  const [checkpoint] = await db.select().from(namedCheckpointsTable)
    .where(eq(namedCheckpointsTable.id, req.params.checkId));
  if (!checkpoint) return res.status(404).json({ error: "Checkpoint not found" });
  const snapSegments = JSON.parse(checkpoint.segmentsSnapshot) as Array<{
    id: string; orderIndex: number; startTime: number; endTime: number;
    included: boolean; speedFactor: number | null; colorGrade: string | null;
    label: string | null; segmentType: string; videoId: string;
    reverse: boolean | null; freeze: boolean | null; freezeDuration: number | null;
    opticalFlow: boolean | null;
  }>;
  let restored = 0;
  for (const snap of snapSegments) {
    const result = await db.update(segmentsTable).set({
      orderIndex: snap.orderIndex, startTime: snap.startTime, endTime: snap.endTime,
      included: snap.included, speedFactor: snap.speedFactor ?? 1,
      colorGrade: snap.colorGrade ?? "none", label: snap.label,
      reverse: snap.reverse ?? false, freeze: snap.freeze ?? false,
      freezeDuration: snap.freezeDuration ?? 2, opticalFlow: snap.opticalFlow ?? false,
    }).where(eq(segmentsTable.id, snap.id)).returning();
    if (result.length > 0) restored++;
  }
  res.json({ restored, checkpointName: checkpoint.name, segmentCount: snapSegments.length });
});

router.delete("/checkpoints/:id", async (req, res) => {
  await db.delete(namedCheckpointsTable).where(eq(namedCheckpointsTable.id, req.params.id));
  res.status(204).send();
});

export default router;
