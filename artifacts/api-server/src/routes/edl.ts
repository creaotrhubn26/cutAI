import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { segmentEditsTable, segmentsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router: IRouter = Router();

// #26 Edit decision log — full audit trail for a project
router.get("/projects/:id/edit-decision-log", async (req, res) => {
  const edits = await db.select().from(segmentEditsTable)
    .where(eq(segmentEditsTable.projectId, req.params.id))
    .orderBy(desc(segmentEditsTable.editedAt));
  const limit = parseInt(req.query.limit as string) || 200;
  res.json(edits.slice(0, limit).map(e => ({
    ...e,
    editedAt: e.editedAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
  })));
});

// #29 Clip version history — all edits for a specific segment
router.get("/segments/:id/version-history", async (req, res) => {
  const edits = await db.select().from(segmentEditsTable)
    .where(eq(segmentEditsTable.segmentId, req.params.id))
    .orderBy(desc(segmentEditsTable.editedAt));
  res.json(edits.map(e => ({
    ...e,
    editedAt: e.editedAt.toISOString(),
    createdAt: e.createdAt.toISOString(),
  })));
});

// #29 Revert clip to a historical state captured by an edit row
router.post("/segments/:id/revert-to/:editId", async (req, res) => {
  const [edit] = await db.select().from(segmentEditsTable)
    .where(eq(segmentEditsTable.id, req.params.editId));
  if (!edit) return res.status(404).json({ error: "Edit record not found" });
  if (edit.segmentId !== req.params.id) return res.status(400).json({ error: "Edit does not belong to this segment" });

  const updates: Record<string, unknown> = {};
  if (edit.field === "startTime" && edit.aiStartTime != null) updates.startTime = edit.aiStartTime;
  if (edit.field === "endTime" && edit.aiEndTime != null) updates.endTime = edit.aiEndTime;
  if (edit.field === "orderIndex" && edit.aiOrderIndex != null) updates.orderIndex = edit.aiOrderIndex;
  if (edit.field === "included" && edit.aiIncluded != null) updates.included = edit.aiIncluded;
  if (edit.field === "speedFactor" && edit.aiValue != null) updates.speedFactor = parseFloat(edit.aiValue);
  if (edit.field === "colorGrade" && edit.aiValue != null) updates.colorGrade = edit.aiValue;

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Cannot determine revert values from this edit record" });
  }

  const [reverted] = await db.update(segmentsTable).set(updates)
    .where(eq(segmentsTable.id, req.params.id)).returning();
  if (!reverted) return res.status(404).json({ error: "Segment not found" });

  res.json({ ...reverted, createdAt: reverted.createdAt.toISOString(), revertedField: edit.field });
});

export default router;
