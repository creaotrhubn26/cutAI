import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { collaborationCursorsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

function serialize(c: typeof collaborationCursorsTable.$inferSelect) {
  return { ...c, updatedAt: c.updatedAt.toISOString() };
}

// Get all active cursors for a project (active = updated within last 30s)
router.get("/projects/:id/collaboration/cursors", async (req, res) => {
  const cursors = await db.select().from(collaborationCursorsTable)
    .where(eq(collaborationCursorsTable.projectId, req.params.id));
  const cutoff = Date.now() - 30_000;
  const active = cursors.filter(c => c.updatedAt.getTime() > cutoff);
  res.json(active.map(serialize));
});

// Upsert my cursor position
router.put("/projects/:id/collaboration/cursor", async (req, res) => {
  const body = z.object({
    sessionId: z.string(),
    displayName: z.string().optional(),
    color: z.string().optional(),
    playhead: z.number(),
    activeSegmentId: z.string().optional(),
  }).parse(req.body);

  const existing = await db.select().from(collaborationCursorsTable)
    .where(and(
      eq(collaborationCursorsTable.projectId, req.params.id),
      eq(collaborationCursorsTable.sessionId, body.sessionId),
    ));

  if (existing.length > 0) {
    const [updated] = await db.update(collaborationCursorsTable).set({
      playhead: body.playhead,
      activeSegmentId: body.activeSegmentId ?? null,
      displayName: body.displayName ?? existing[0].displayName,
      color: body.color ?? existing[0].color,
      updatedAt: new Date(),
    }).where(eq(collaborationCursorsTable.id, existing[0].id)).returning();
    res.json(serialize(updated));
  } else {
    const [created] = await db.insert(collaborationCursorsTable).values({
      id: randomUUID(),
      projectId: req.params.id,
      sessionId: body.sessionId,
      displayName: body.displayName ?? "Editor",
      color: body.color ?? "#a78bfa",
      playhead: body.playhead,
      activeSegmentId: body.activeSegmentId ?? null,
      updatedAt: new Date(),
    }).returning();
    res.status(201).json(serialize(created));
  }
});

export default router;
