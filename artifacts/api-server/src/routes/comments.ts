import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { timelineCommentsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

function serialize(c: typeof timelineCommentsTable.$inferSelect) {
  return { ...c, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() };
}

router.get("/projects/:id/comments", async (req, res) => {
  const comments = await db.select().from(timelineCommentsTable)
    .where(eq(timelineCommentsTable.projectId, req.params.id))
    .orderBy(timelineCommentsTable.timecode);
  res.json(comments.map(serialize));
});

router.post("/projects/:id/comments", async (req, res) => {
  const body = z.object({
    timecode: z.number(),
    text: z.string().min(1),
    authorName: z.string().optional(),
    segmentId: z.string().optional(),
    parentId: z.string().optional(),
  }).parse(req.body);
  const [comment] = await db.insert(timelineCommentsTable).values({
    id: randomUUID(),
    projectId: req.params.id,
    timecode: body.timecode,
    text: body.text,
    authorName: body.authorName ?? "Editor",
    segmentId: body.segmentId ?? null,
    parentId: body.parentId ?? null,
  }).returning();
  res.status(201).json(serialize(comment));
});

router.patch("/comments/:id", async (req, res) => {
  const body = z.object({ text: z.string().optional(), resolved: z.string().optional() }).parse(req.body);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.text !== undefined) updates.text = body.text;
  if (body.resolved !== undefined) updates.resolved = body.resolved;
  const [updated] = await db.update(timelineCommentsTable).set(updates)
    .where(eq(timelineCommentsTable.id, req.params.id)).returning();
  if (!updated) return res.status(404).json({ error: "Not found" });
  res.json(serialize(updated));
});

router.delete("/comments/:id", async (req, res) => {
  await db.delete(timelineCommentsTable).where(eq(timelineCommentsTable.id, req.params.id));
  res.status(204).send();
});

export default router;
