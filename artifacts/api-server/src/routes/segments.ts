import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { segmentsTable, segmentEditsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";
import {
  CreateSegmentBody,
  GetSegmentParams,
  UpdateSegmentParams,
  UpdateSegmentBody,
  DeleteSegmentParams,
  ListProjectSegmentsParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeSegment(s: typeof segmentsTable.$inferSelect) {
  return { ...s, createdAt: s.createdAt.toISOString() };
}

router.post("/segments", async (req, res) => {
  const body = CreateSegmentBody.parse(req.body);
  const id = randomUUID();
  const [seg] = await db.insert(segmentsTable).values({ id, ...body }).returning();
  res.status(201).json(serializeSegment(seg));
});

router.get("/segments/:id", async (req, res) => {
  const { id } = GetSegmentParams.parse(req.params);
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Not found" });
  res.json(serializeSegment(seg));
});

router.patch("/segments/:id", async (req, res) => {
  const { id } = UpdateSegmentParams.parse(req.params);
  const body = UpdateSegmentBody.parse(req.body);

  // Load the current state before patching so we can compute the delta
  const [before] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!before) return res.status(404).json({ error: "Not found" });

  const updates: Record<string, unknown> = {};
  if (body.startTime != null) updates.startTime = body.startTime;
  if (body.endTime != null) updates.endTime = body.endTime;
  if (body.label !== undefined) updates.label = body.label;
  if (body.orderIndex != null) updates.orderIndex = body.orderIndex;
  if (body.included != null) updates.included = body.included;
  if (body.segmentType != null) updates.segmentType = body.segmentType;
  if (body.speedFactor != null) updates.speedFactor = body.speedFactor;
  if (body.speedRampStart !== undefined) updates.speedRampStart = body.speedRampStart;
  if (body.speedRampEnd !== undefined) updates.speedRampEnd = body.speedRampEnd;
  if (body.speedCurve !== undefined) updates.speedCurve = body.speedCurve;
  if (body.reverse != null) updates.reverse = body.reverse;
  if (body.freeze != null) updates.freeze = body.freeze;
  if (body.audioEnhancement !== undefined) updates.audioEnhancement = body.audioEnhancement;
  if (body.colorGrade !== undefined) updates.colorGrade = body.colorGrade;
  if (body.transitionIn !== undefined) updates.transitionIn = body.transitionIn;
  if (body.transitionInDuration != null) updates.transitionInDuration = body.transitionInDuration;
  if (body.captionText !== undefined) updates.captionText = body.captionText;
  if (body.captionStyle !== undefined) updates.captionStyle = body.captionStyle;
  if (body.graphicOverlays !== undefined) updates.graphicOverlays = body.graphicOverlays;

  const [seg] = await db.update(segmentsTable).set(updates).where(eq(segmentsTable.id, id)).returning();
  if (!seg) return res.status(404).json({ error: "Not found" });

  // ── Record the human edit for training ──────────────────────────────────
  // Write one row per changed field following the canonical diff contract:
  // {field, aiValue, humanValue, editedAt} so training consumers can read
  // per-field diffs without interpreting aggregated wide columns.
  const changedFields: Array<{
    field: string;
    aiValue: string;
    humanValue: string;
    editType: string;
    aiStartTime?: number | null;
    humanStartTime?: number | null;
    aiEndTime?: number | null;
    humanEndTime?: number | null;
    aiOrderIndex?: number | null;
    humanOrderIndex?: number | null;
    aiIncluded?: boolean | null;
    humanIncluded?: boolean | null;
    deltaStartSeconds?: number | null;
    deltaEndSeconds?: number | null;
  }> = [];

  if (body.startTime != null && body.startTime !== before.startTime) {
    changedFields.push({
      field: "startTime",
      aiValue: String(before.startTime),
      humanValue: String(body.startTime),
      editType: "trim_start",
      aiStartTime: before.startTime,
      humanStartTime: body.startTime,
      deltaStartSeconds: body.startTime - before.startTime,
    });
  }
  if (body.endTime != null && body.endTime !== before.endTime) {
    changedFields.push({
      field: "endTime",
      aiValue: String(before.endTime),
      humanValue: String(body.endTime),
      editType: "trim_end",
      aiEndTime: before.endTime,
      humanEndTime: body.endTime,
      deltaEndSeconds: body.endTime - before.endTime,
    });
  }
  if (body.orderIndex != null && body.orderIndex !== before.orderIndex) {
    changedFields.push({
      field: "orderIndex",
      aiValue: String(before.orderIndex),
      humanValue: String(body.orderIndex),
      editType: "reorder",
      aiOrderIndex: before.orderIndex,
      humanOrderIndex: body.orderIndex,
    });
  }
  if (body.included != null && body.included !== before.included) {
    changedFields.push({
      field: "included",
      aiValue: String(before.included),
      humanValue: String(body.included),
      editType: "toggle_include",
      aiIncluded: before.included,
      humanIncluded: body.included,
    });
  }
  if (body.speedFactor != null && body.speedFactor !== before.speedFactor) {
    changedFields.push({
      field: "speedFactor",
      aiValue: String(before.speedFactor ?? 1),
      humanValue: String(body.speedFactor),
      editType: "speed_change",
    });
  }
  if (body.colorGrade !== undefined && body.colorGrade !== before.colorGrade) {
    changedFields.push({
      field: "colorGrade",
      aiValue: String(before.colorGrade ?? "none"),
      humanValue: String(body.colorGrade ?? "none"),
      editType: "color_grade",
    });
  }

  if (changedFields.length > 0) {
    const now = new Date();
    // Enforce canonical diff contract: every row MUST have field/aiValue/humanValue populated.
    // Log and skip any entry that would violate the schema contract.
    const validInserts = changedFields.filter((cf) => {
      if (!cf.field || cf.aiValue === undefined || cf.humanValue === undefined) {
        console.error("[training] Skipping segment edit row with missing canonical diff fields:", cf);
        return false;
      }
      return true;
    });
    if (validInserts.length === 0) {
      console.warn("[training] No valid segment edit rows to insert after validation");
    }
    const inserts = validInserts.map((cf) => ({
      id: randomUUID(),
      segmentId: id,
      projectId: before.projectId,
      videoId: before.videoId,
      editType: cf.editType,
      field: cf.field,
      aiValue: cf.aiValue,
      humanValue: cf.humanValue,
      editedAt: now,
      aiStartTime: cf.aiStartTime ?? null,
      humanStartTime: cf.humanStartTime ?? null,
      aiEndTime: cf.aiEndTime ?? null,
      humanEndTime: cf.humanEndTime ?? null,
      aiOrderIndex: cf.aiOrderIndex ?? null,
      humanOrderIndex: cf.humanOrderIndex ?? null,
      aiIncluded: cf.aiIncluded ?? null,
      humanIncluded: cf.humanIncluded ?? null,
      deltaStartSeconds: cf.deltaStartSeconds ?? null,
      deltaEndSeconds: cf.deltaEndSeconds ?? null,
    }));
    try {
      await db.insert(segmentEditsTable).values(inserts);
    } catch (editErr) {
      console.error("[training] Failed to record segment edits:", editErr);
    }
  }

  res.json(serializeSegment(seg));
});

router.post("/segments/:id/split", async (req, res) => {
  const { id } = req.params;
  const { at } = req.body;
  if (typeof at !== "number") return res.status(400).json({ error: "at must be a number" });
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Not found" });
  if (at <= seg.startTime || at >= seg.endTime) {
    return res.status(400).json({ error: "Split point must be strictly within segment bounds" });
  }
  const [segA] = await db.update(segmentsTable).set({ endTime: at }).where(eq(segmentsTable.id, id)).returning();
  const { id: _id, createdAt: _c, ...segFields } = seg;
  const [segB] = await db.insert(segmentsTable).values({
    ...segFields,
    id: randomUUID(),
    startTime: at,
    endTime: seg.endTime,
    orderIndex: seg.orderIndex + 0.5,
    createdAt: new Date(),
  }).returning();

  // Record split as a training signal: one per-field row for startTime and endTime
  const splitNow = new Date();
  try {
    await db.insert(segmentEditsTable).values([
      {
        id: randomUUID(),
        segmentId: id,
        projectId: seg.projectId,
        videoId: seg.videoId,
        editType: "split",
        field: "startTime",
        aiValue: String(seg.startTime),
        humanValue: String(at),
        editedAt: splitNow,
        aiStartTime: seg.startTime,
        humanStartTime: at,
        aiEndTime: seg.endTime,
        humanEndTime: at,
        aiOrderIndex: seg.orderIndex,
        humanOrderIndex: seg.orderIndex,
        deltaStartSeconds: at - seg.startTime,
        deltaEndSeconds: seg.endTime - at,
      },
      {
        id: randomUUID(),
        segmentId: id,
        projectId: seg.projectId,
        videoId: seg.videoId,
        editType: "split",
        field: "endTime",
        aiValue: String(seg.endTime),
        humanValue: String(at),
        editedAt: splitNow,
        aiStartTime: seg.startTime,
        humanStartTime: at,
        aiEndTime: seg.endTime,
        humanEndTime: at,
        aiOrderIndex: seg.orderIndex,
        humanOrderIndex: seg.orderIndex,
        deltaStartSeconds: at - seg.startTime,
        deltaEndSeconds: seg.endTime - at,
      },
    ]);
  } catch (splitErr) {
    console.error("[training] Failed to record split edit:", splitErr);
  }

  res.json({ segmentA: serializeSegment(segA), segmentB: serializeSegment(segB) });
});

router.delete("/segments/:id", async (req, res) => {
  const { id } = DeleteSegmentParams.parse(req.params);

  // Load the segment before deleting so we can record the training signal
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  await db.delete(segmentsTable).where(eq(segmentsTable.id, id));

  // Record delete as a per-field training signal on `included` field.
  // aiValue = what AI decided (was segment included?), humanValue = "false" (removed).
  if (seg) {
    try {
      await db.insert(segmentEditsTable).values({
        id: randomUUID(),
        segmentId: id,
        projectId: seg.projectId,
        videoId: seg.videoId,
        editType: "delete",
        field: "included",
        aiValue: String(seg.included),
        humanValue: "false",
        editedAt: new Date(),
        aiStartTime: seg.startTime,
        humanStartTime: null,
        aiEndTime: seg.endTime,
        humanEndTime: null,
        aiOrderIndex: seg.orderIndex,
        humanOrderIndex: null,
        aiIncluded: seg.included,
        humanIncluded: false,
        deltaStartSeconds: null,
        deltaEndSeconds: null,
      });
    } catch (deleteErr) {
      console.error("[training] Failed to record delete edit:", deleteErr);
    }
  }

  res.status(204).send();
});

router.get("/projects/:id/segments", async (req, res) => {
  const { id } = ListProjectSegmentsParams.parse(req.params);
  const segs = await db
    .select()
    .from(segmentsTable)
    .where(eq(segmentsTable.projectId, id))
    .orderBy(segmentsTable.orderIndex);
  res.json(segs.map(serializeSegment));
});

// ── #1 Ripple delete — remove segment and shift downstream orderIndex ────────
router.delete("/segments/:id/ripple", async (req, res) => {
  const { id } = req.params;
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });

  // Delete the segment
  await db.delete(segmentsTable).where(eq(segmentsTable.id, id));

  // Shift all downstream segments in the same project
  const downstream = await db
    .select()
    .from(segmentsTable)
    .where(eq(segmentsTable.projectId, seg.projectId));

  for (const s of downstream) {
    if (s.orderIndex > seg.orderIndex) {
      await db.update(segmentsTable)
        .set({ orderIndex: s.orderIndex - 1 })
        .where(eq(segmentsTable.id, s.id));
    }
  }

  // Record training signal
  try {
    await db.insert(segmentEditsTable).values({
      id: randomUUID(), segmentId: id, projectId: seg.projectId, videoId: seg.videoId,
      editType: "ripple_delete", field: "included",
      aiValue: String(seg.included), humanValue: "false",
      editedAt: new Date(),
      aiStartTime: seg.startTime, humanStartTime: null,
      aiEndTime: seg.endTime, humanEndTime: null,
      aiOrderIndex: seg.orderIndex, humanOrderIndex: null,
      aiIncluded: seg.included, humanIncluded: false,
      deltaStartSeconds: null, deltaEndSeconds: null,
    });
  } catch {}

  res.status(204).send();
});

// ── #5 Lift delete — exclude segment but leave a gap in timeline ─────────────
router.post("/segments/:id/lift", async (req, res) => {
  const { id } = req.params;
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });
  const [updated] = await db.update(segmentsTable)
    .set({ included: false, isGap: true })
    .where(eq(segmentsTable.id, id))
    .returning();
  res.json(serializeSegment(updated));
});

// ── #2 Slip edit — shift in/out points without moving timeline position ──────
router.patch("/segments/:id/slip", async (req, res) => {
  const { id } = req.params;
  const { delta } = z.object({ delta: z.number() }).parse(req.body);
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });

  const dur = seg.endTime - seg.startTime;
  const curIn  = seg.inPoint  ?? seg.startTime;
  const curOut = seg.outPoint ?? seg.endTime;
  const newIn  = Math.max(0, curIn + delta);
  const newOut = newIn + (curOut - curIn); // preserve clip duration in source

  const [updated] = await db.update(segmentsTable)
    .set({ inPoint: newIn, outPoint: newOut })
    .where(eq(segmentsTable.id, id))
    .returning();
  res.json(serializeSegment(updated));
});

// ── #3 Roll edit — adjust boundary between two adjacent clips ────────────────
router.post("/projects/:id/roll-edit", async (req, res) => {
  const { id } = req.params;
  const { leftId, rightId, delta } = z.object({
    leftId: z.string(), rightId: z.string(), delta: z.number()
  }).parse(req.body);

  const [left] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, leftId));
  const [right] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, rightId));
  if (!left || !right) return res.status(404).json({ error: "Segment not found" });

  // Clamp: left must keep min 0.1s; right must keep min 0.1s
  const clampedDelta = Math.max(
    -(left.endTime - left.startTime - 0.1),
    Math.min(delta, right.endTime - right.startTime - 0.1)
  );

  const [updatedLeft] = await db.update(segmentsTable)
    .set({ endTime: left.endTime + clampedDelta })
    .where(eq(segmentsTable.id, leftId))
    .returning();
  const [updatedRight] = await db.update(segmentsTable)
    .set({ startTime: right.startTime + clampedDelta })
    .where(eq(segmentsTable.id, rightId))
    .returning();

  res.json({ left: serializeSegment(updatedLeft), right: serializeSegment(updatedRight) });
});

// ── #4 Three-point insert — mark in/out on source, insert at orderIndex ──────
router.post("/projects/:id/three-point-insert", async (req, res) => {
  const { id } = req.params;
  const { videoId, sourceIn, sourceOut, atOrderIndex } = z.object({
    videoId: z.string(),
    sourceIn: z.number(),
    sourceOut: z.number(),
    atOrderIndex: z.number().int(),
  }).parse(req.body);

  // Shift existing segments at or after atOrderIndex
  const existing = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, id));
  for (const s of existing) {
    if (s.orderIndex >= atOrderIndex) {
      await db.update(segmentsTable).set({ orderIndex: s.orderIndex + 1 }).where(eq(segmentsTable.id, s.id));
    }
  }

  const [seg] = await db.insert(segmentsTable).values({
    id: randomUUID(),
    projectId: id,
    videoId,
    orderIndex: atOrderIndex,
    startTime: sourceIn,
    endTime: sourceOut,
    inPoint: sourceIn,
    outPoint: sourceOut,
    segmentType: "insert",
    label: "3-point insert",
    included: true,
  }).returning();

  res.status(201).json(serializeSegment(seg));
});

// ── #9 Nest segments — collapse selection into a compound clip ───────────────
router.post("/projects/:id/nest-segments", async (req, res) => {
  const { id } = req.params;
  const { segmentIds, name } = z.object({
    segmentIds: z.array(z.string()).min(2),
    name: z.string().optional().default("Compound Clip"),
  }).parse(req.body);

  const segs = await db.select().from(segmentsTable)
    .where(eq(segmentsTable.projectId, id));
  const selected = segs.filter(s => segmentIds.includes(s.id)).sort((a, b) => a.orderIndex - b.orderIndex);
  if (selected.length < 2) return res.status(400).json({ error: "Need at least 2 segments" });

  const compoundId = randomUUID();
  const minOrder = selected[0].orderIndex;
  const firstVideoId = selected[0].videoId;
  const totalDur = selected.reduce((acc, s) => acc + (s.endTime - s.startTime), 0);

  // Create the compound placeholder segment
  const [compound] = await db.insert(segmentsTable).values({
    id: compoundId,
    projectId: id,
    videoId: firstVideoId,
    orderIndex: minOrder,
    startTime: selected[0].startTime,
    endTime: selected[0].startTime + totalDur,
    segmentType: "compound",
    label: name,
    included: true,
  }).returning();

  // Tag all selected segments with the compound id and move them after compound's virtual slot
  for (let i = 0; i < selected.length; i++) {
    await db.update(segmentsTable)
      .set({ compoundClipId: compoundId, orderIndex: 100000 + i, included: false })
      .where(eq(segmentsTable.id, selected[i].id));
  }

  res.status(201).json({ compound: serializeSegment(compound), childIds: segmentIds });
});

// ── #9 Unnest compound clip ───────────────────────────────────────────────────
router.delete("/segments/:compoundId/unnest", async (req, res) => {
  const { compoundId } = req.params;
  const [compound] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, compoundId));
  if (!compound) return res.status(404).json({ error: "Compound clip not found" });

  const children = await db.select().from(segmentsTable)
    .where(eq(segmentsTable.compoundClipId, compoundId))
    .orderBy(segmentsTable.orderIndex);

  // Restore children at compound's position
  for (let i = 0; i < children.length; i++) {
    await db.update(segmentsTable)
      .set({ compoundClipId: null, orderIndex: compound.orderIndex + i, included: true })
      .where(eq(segmentsTable.id, children[i].id));
  }

  // Shift everything after compound by (children.length - 1)
  const others = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, compound.projectId));
  for (const s of others) {
    if (s.orderIndex > compound.orderIndex && s.compoundClipId !== compoundId) {
      await db.update(segmentsTable)
        .set({ orderIndex: s.orderIndex + children.length - 1 })
        .where(eq(segmentsTable.id, s.id));
    }
  }

  // Remove compound placeholder
  await db.delete(segmentsTable).where(eq(segmentsTable.id, compoundId));

  res.json({ unnestedIds: children.map(c => c.id) });
});

// ── #15 Freeze frame — hold last frame for N seconds after clip ──────────────
router.post("/segments/:id/freeze-frame", async (req, res) => {
  const { id } = req.params;
  const { duration = 2.0 } = z.object({ duration: z.number().min(0.1).max(30).optional() }).parse(req.body);
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });
  const newFreeze = !seg.freeze;
  const [updated] = await db.update(segmentsTable)
    .set({ freeze: newFreeze, freezeDuration: newFreeze ? duration : 0 })
    .where(eq(segmentsTable.id, id)).returning();
  res.json(serializeSegment(updated));
});

// ── #14 Optical-flow slow-motion — 0.25x with frame interpolation ─────────────
router.post("/segments/:id/optical-flow", async (req, res) => {
  const { id } = req.params;
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });
  const newOptical = !seg.opticalFlow;
  const [updated] = await db.update(segmentsTable)
    .set({ opticalFlow: newOptical, speedFactor: newOptical ? 0.25 : 1.0 })
    .where(eq(segmentsTable.id, id)).returning();
  res.json(serializeSegment(updated));
});

// ── #16 Reverse clip — toggle playback direction non-destructively ────────────
router.post("/segments/:id/reverse", async (req, res) => {
  const { id } = req.params;
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });
  const [updated] = await db.update(segmentsTable)
    .set({ reverse: !seg.reverse })
    .where(eq(segmentsTable.id, id)).returning();
  try {
    await db.insert(segmentEditsTable).values({
      id: randomUUID(), segmentId: id, projectId: seg.projectId, videoId: seg.videoId,
      editType: "reverse", field: "reverse",
      aiValue: String(seg.reverse ?? false), humanValue: String(!seg.reverse),
      editedAt: new Date(),
    });
  } catch {}
  res.json(serializeSegment(updated));
});

// ── #12 Paste attributes — apply colorGrade (and other visual attrs) ──────────
router.post("/segments/:id/paste-attributes", async (req, res) => {
  const { id } = req.params;
  const { sourceSegmentId } = z.object({ sourceSegmentId: z.string() }).parse(req.body);
  const [src] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, sourceSegmentId));
  if (!src) return res.status(404).json({ error: "Source segment not found" });
  const [updated] = await db.update(segmentsTable)
    .set({ colorGrade: src.colorGrade, audioMixLevel: src.audioMixLevel, musicDuckLevel: src.musicDuckLevel })
    .where(eq(segmentsTable.id, id)).returning();
  if (!updated) return res.status(404).json({ error: "Target segment not found" });
  res.json(serializeSegment(updated));
});

// ── #13 Speed ramp bezier curve points ────────────────────────────────────────
router.patch("/segments/:id/speed-curve", async (req, res) => {
  const { id } = req.params;
  const { points, speedFactor, speedRampStart, speedRampEnd } = z.object({
    points: z.array(z.object({ t: z.number(), v: z.number() })).optional(),
    speedFactor: z.number().min(0.05).max(10).optional(),
    speedRampStart: z.number().optional(),
    speedRampEnd: z.number().optional(),
  }).parse(req.body);
  const [seg] = await db.select().from(segmentsTable).where(eq(segmentsTable.id, id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });
  const updates: Record<string, unknown> = {};
  if (points !== undefined) updates.speedCurvePoints = JSON.stringify(points);
  if (speedFactor !== undefined) updates.speedFactor = speedFactor;
  if (speedRampStart !== undefined) updates.speedRampStart = speedRampStart;
  if (speedRampEnd !== undefined) updates.speedRampEnd = speedRampEnd;
  const [updated] = await db.update(segmentsTable).set(updates).where(eq(segmentsTable.id, id)).returning();
  res.json(serializeSegment(updated));
});

// ── #11 Range delete — ripple-delete all segments overlapping [start,end] ─────
router.post("/projects/:id/range-delete", async (req, res) => {
  const { id } = req.params;
  const { start, end } = z.object({ start: z.number(), end: z.number() }).parse(req.body);
  if (end <= start) return res.status(400).json({ error: "end must be > start" });
  const all = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, id));
  const toDelete = all.filter(s => s.startTime < end && s.endTime > start);
  for (const s of toDelete) {
    await db.delete(segmentsTable).where(eq(segmentsTable.id, s.id));
  }
  // Re-index remaining by orderIndex
  const remaining = (await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, id)))
    .sort((a, b) => a.orderIndex - b.orderIndex);
  for (let i = 0; i < remaining.length; i++) {
    await db.update(segmentsTable).set({ orderIndex: i }).where(eq(segmentsTable.id, remaining[i].id));
  }
  res.json({ deleted: toDelete.length, range: { start, end } });
});

// ── #11 Range speed — apply speedFactor to all segments in time range ─────────
router.post("/projects/:id/range-speed", async (req, res) => {
  const { id } = req.params;
  const { start, end, speedFactor } = z.object({ start: z.number(), end: z.number(), speedFactor: z.number().min(0.05).max(10) }).parse(req.body);
  const all = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, id));
  const affected = all.filter(s => s.startTime < end && s.endTime > start);
  for (const s of affected) {
    await db.update(segmentsTable).set({ speedFactor }).where(eq(segmentsTable.id, s.id));
  }
  res.json({ updated: affected.length, speedFactor, range: { start, end } });
});

// ── #11 Range color — apply colorGrade to all segments in time range ──────────
router.post("/projects/:id/range-color", async (req, res) => {
  const { id } = req.params;
  const { start, end, colorGrade } = z.object({ start: z.number(), end: z.number(), colorGrade: z.string() }).parse(req.body);
  const all = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, id));
  const affected = all.filter(s => s.startTime < end && s.endTime > start);
  for (const s of affected) {
    await db.update(segmentsTable).set({ colorGrade }).where(eq(segmentsTable.id, s.id));
  }
  res.json({ updated: affected.length, colorGrade, range: { start, end } });
});

export default router;
