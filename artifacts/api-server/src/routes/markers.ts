import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { markersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

const MarkerBody = z.object({
  timestamp: z.number(),
  label: z.string().optional().default(""),
  color: z.enum(["red", "yellow", "green", "blue", "orange"]).optional().default("yellow"),
  notes: z.string().optional(),
});

const MarkerPatch = z.object({
  timestamp: z.number().optional(),
  label: z.string().optional(),
  color: z.enum(["red", "yellow", "green", "blue", "orange"]).optional(),
  notes: z.string().optional(),
});

function ser(m: typeof markersTable.$inferSelect) {
  return { ...m, createdAt: m.createdAt.toISOString() };
}

router.get("/projects/:id/markers", async (req, res) => {
  const { id } = req.params;
  const markers = await db
    .select()
    .from(markersTable)
    .where(eq(markersTable.projectId, id))
    .orderBy(markersTable.timestamp);
  res.json(markers.map(ser));
});

router.post("/projects/:id/markers", async (req, res) => {
  const { id } = req.params;
  const body = MarkerBody.parse(req.body);
  const [marker] = await db.insert(markersTable).values({ id: randomUUID(), projectId: id, ...body }).returning();
  res.status(201).json(ser(marker));
});

router.patch("/markers/:id", async (req, res) => {
  const { id } = req.params;
  const body = MarkerPatch.parse(req.body);
  const updates: Partial<typeof markersTable.$inferInsert> = {};
  if (body.timestamp != null) updates.timestamp = body.timestamp;
  if (body.label != null) updates.label = body.label;
  if (body.color != null) updates.color = body.color;
  if (body.notes != null) updates.notes = body.notes;
  const [marker] = await db.update(markersTable).set(updates).where(eq(markersTable.id, id)).returning();
  if (!marker) return res.status(404).json({ error: "Marker not found" });
  res.json(ser(marker));
});

router.delete("/markers/:id", async (req, res) => {
  const { id } = req.params;
  await db.delete(markersTable).where(eq(markersTable.id, id));
  res.status(204).send();
});

export default router;
