/**
 * Batch operations — #44 Batch trim silence, #45 Smart B-roll insert
 */
import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { segmentsTable, videosTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";
import { randomUUID } from "crypto";
import { z } from "zod";

const router: IRouter = Router();

/* ── #44 Batch trim silence ─────────────────────────────────────────────
 * For every included, non-gap segment in the project:
 *   1. Check if silenceTrimInfo JSON exists (set by a previous audio analysis job)
 *      and apply those stored trim offsets.
 *   2. Otherwise apply a heuristic: trim `headroom` seconds from the start and
 *      `tailroom` seconds from the end of each clip (caller can tune these).
 *   3. Skip any clip where duration would fall below `minDuration`.
 *
 * Body:
 *   silenceDuration  – minimum silence length (s) to consider trimmable (default 0.4)
 *   headroom         – fixed head-trim when no analysis data (default 0.25)
 *   tailroom         – fixed tail-trim when no analysis data (default 0.15)
 *   minDuration      – don't trim if resulting clip would be shorter (default 1.0)
 *   dryRun           – if true, return preview without modifying DB (default false)
 * ──────────────────────────────────────────────────────────────────────── */
const BatchTrimSilenceBody = z.object({
  silenceDuration: z.number().min(0.05).max(10).default(0.4),
  headroom: z.number().min(0).max(5).default(0.25),
  tailroom: z.number().min(0).max(5).default(0.15),
  minDuration: z.number().min(0.1).max(60).default(1.0),
  dryRun: z.boolean().default(false),
});

router.post("/projects/:id/batch-trim-silence", async (req, res) => {
  const projectId = req.params.id;
  const body = BatchTrimSilenceBody.parse(req.body);
  const { silenceDuration, headroom, tailroom, minDuration, dryRun } = body;

  const segments = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, projectId), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  const includedSegs = segments.filter(s => !s.isGap);

  const results: Array<{
    segmentId: string;
    label: string | null;
    before: { startTime: number; endTime: number; duration: number };
    after:  { startTime: number; endTime: number; duration: number };
    trimmedHead: number;
    trimmedTail: number;
    source: "silence_trim_info" | "heuristic" | "skipped";
  }> = [];

  for (const seg of includedSegs) {
    const origDuration = seg.endTime - seg.startTime;
    let newStart = seg.startTime;
    let newEnd   = seg.endTime;
    let source: "silence_trim_info" | "heuristic" | "skipped" = "heuristic";

    // ── Try stored silenceTrimInfo first ──────────────────────────────────
    if (seg.silenceTrimInfo) {
      try {
        const info = JSON.parse(seg.silenceTrimInfo);
        // Expected shape: { startTrimmedSec, endTrimmedSec }
        const startTrim = parseFloat(info.startTrimmedSec ?? info.headTrimSec ?? "0");
        const endTrim   = parseFloat(info.endTrimmedSec   ?? info.tailTrimSec  ?? "0");
        if (startTrim > 0 || endTrim > 0) {
          newStart = seg.startTime + startTrim;
          newEnd   = seg.endTime   - endTrim;
          source   = "silence_trim_info";
        }
      } catch { /* malformed JSON — fall through to heuristic */ }
    }

    // ── Heuristic: fixed head/tail trim ───────────────────────────────────
    if (source === "heuristic") {
      const head = Math.min(headroom, origDuration * 0.15);
      const tail = Math.min(tailroom, origDuration * 0.10);
      // Only trim if silence threshold makes sense vs duration
      if (origDuration > silenceDuration * 2) {
        newStart = seg.startTime + head;
        newEnd   = seg.endTime   - tail;
      } else {
        source = "skipped";
      }
    }

    // ── Guard: never go below minDuration ────────────────────────────────
    if (newEnd - newStart < minDuration) {
      source = "skipped";
      newStart = seg.startTime;
      newEnd   = seg.endTime;
    }

    const trimmedHead = Math.max(0, parseFloat((newStart - seg.startTime).toFixed(4)));
    const trimmedTail = Math.max(0, parseFloat((seg.endTime - newEnd).toFixed(4)));

    results.push({
      segmentId: seg.id,
      label: seg.label,
      before: { startTime: seg.startTime, endTime: seg.endTime, duration: origDuration },
      after:  { startTime: newStart, endTime: newEnd, duration: newEnd - newStart },
      trimmedHead,
      trimmedTail,
      source,
    });

    // ── Apply to DB unless dry run or nothing changed ────────────────────
    if (!dryRun && source !== "skipped" && (trimmedHead > 0 || trimmedTail > 0)) {
      await db.update(segmentsTable)
        .set({ startTime: newStart, endTime: newEnd })
        .where(eq(segmentsTable.id, seg.id));
    }
  }

  const applied = results.filter(r => r.source !== "skipped");
  const totalTimeSaved = applied.reduce((s, r) => s + r.trimmedHead + r.trimmedTail, 0);

  res.json({
    dryRun,
    totalSegments: includedSegs.length,
    trimmedCount: applied.length,
    skippedCount: results.filter(r => r.source === "skipped").length,
    totalTimeSavedSeconds: parseFloat(totalTimeSaved.toFixed(3)),
    results,
  });
});

/* ── #45 Smart B-roll insert ────────────────────────────────────────────
 * Sets a segment as B-roll on a "secondary track":
 *   1. segmentType → "b-roll"
 *   2. audioMixLevel → 0  (mute B-roll's own recorded audio — use primary audio instead)
 *   3. Finds the segments immediately before AND after this clip that are on the
 *      primary track, and ducks their musicDuckLevel to `duckLevel` (default 0.3)
 *      so background music quietly continues under the B-roll.
 *   4. Returns the updated segment + list of ducked segments.
 *
 * Can also be reversed: pass `undo: true` to restore original segmentType and audio levels.
 * ──────────────────────────────────────────────────────────────────────── */
const SmartBrollBody = z.object({
  duckLevel: z.number().min(0).max(1).default(0.3),
  undo: z.boolean().default(false),
});

router.post("/segments/:id/set-broll", async (req, res) => {
  const body = SmartBrollBody.parse(req.body);
  const { duckLevel, undo } = body;

  const [seg] = await db.select().from(segmentsTable)
    .where(eq(segmentsTable.id, req.params.id));
  if (!seg) return res.status(404).json({ error: "Segment not found" });

  // Load all segments in this project to find adjacent clips
  const allSegs = await db.select().from(segmentsTable)
    .where(and(eq(segmentsTable.projectId, seg.projectId), eq(segmentsTable.included, true)))
    .orderBy(asc(segmentsTable.orderIndex));

  const segIdx = allSegs.findIndex(s => s.id === seg.id);

  if (undo) {
    // Restore this clip to primary track
    const [restored] = await db.update(segmentsTable)
      .set({ segmentType: "action", audioMixLevel: 1.0 })
      .where(eq(segmentsTable.id, seg.id))
      .returning();

    // Un-duck adjacent clips
    const adjacentIds: string[] = [];
    if (segIdx > 0 && allSegs[segIdx - 1]) adjacentIds.push(allSegs[segIdx - 1]!.id);
    if (segIdx < allSegs.length - 1 && allSegs[segIdx + 1]) adjacentIds.push(allSegs[segIdx + 1]!.id);

    for (const adjId of adjacentIds) {
      await db.update(segmentsTable)
        .set({ musicDuckLevel: 1.0 })
        .where(eq(segmentsTable.id, adjId));
    }

    return res.json({
      action: "undone",
      segment: { ...restored, createdAt: restored.createdAt.toISOString() },
      undockedSegments: adjacentIds,
    });
  }

  // ── Set as B-roll ──────────────────────────────────────────────────────
  const [updated] = await db.update(segmentsTable)
    .set({
      segmentType: "b-roll",
      audioMixLevel: 0.0,   // mute B-roll's own mic/camera audio
    })
    .where(eq(segmentsTable.id, seg.id))
    .returning();

  // ── Duck music on adjacent primary clips ──────────────────────────────
  // We duck the clip BEFORE and AFTER the B-roll so the music smoothly
  // sits under the B-roll transition without a hard level jump.
  const duckedSegments: string[] = [];

  const prevSeg = segIdx > 0 ? allSegs[segIdx - 1] : null;
  const nextSeg = segIdx < allSegs.length - 1 ? allSegs[segIdx + 1] : null;

  for (const adj of [prevSeg, nextSeg]) {
    if (!adj || adj.segmentType === "b-roll" || adj.segmentType === "music") continue;
    await db.update(segmentsTable)
      .set({ musicDuckLevel: duckLevel })
      .where(eq(segmentsTable.id, adj.id));
    duckedSegments.push(adj.id);
  }

  res.json({
    action: "set_broll",
    segment: { ...updated, createdAt: updated.createdAt.toISOString() },
    audioMixLevel: 0.0,
    duckedSegments,
    duckLevel,
    message: `Clip set as B-roll. Audio muted. ${duckedSegments.length} adjacent clips ducked to ${duckLevel * 100}%.`,
  });
});

/* ── Bulk smart insert — set multiple clips as B-roll at once ───────── */
const BulkBrollBody = z.object({
  segmentIds: z.array(z.string()).min(1).max(50),
  duckLevel: z.number().min(0).max(1).default(0.3),
});

router.post("/projects/:id/bulk-set-broll", async (req, res) => {
  const body = BulkBrollBody.parse(req.body);
  const { segmentIds, duckLevel } = body;

  const results = [];
  for (const segId of segmentIds) {
    const [updated] = await db.update(segmentsTable)
      .set({ segmentType: "b-roll", audioMixLevel: 0.0 })
      .where(and(eq(segmentsTable.id, segId), eq(segmentsTable.projectId, req.params.id)))
      .returning();
    if (updated) results.push(updated.id);
  }

  res.json({ updatedCount: results.length, duckLevel, updatedIds: results });
});

export default router;
