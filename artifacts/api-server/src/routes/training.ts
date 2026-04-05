import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  trainingExamplesTable,
  learnedClipPrefsTable,
  segmentEditsTable,
  modelConfigTable,
  clipTrainingPairsTable,
  segmentsTable,
  videosTable,
  projectsTable,
} from "@workspace/db";
import { eq, desc, sql, and } from "drizzle-orm";
import { randomUUID } from "crypto";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

// Helper: upsert a model_config row
async function upsertConfig(key: string, value: string, description?: string) {
  const existing = await db
    .select()
    .from(modelConfigTable)
    .where(eq(modelConfigTable.key, key))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(modelConfigTable)
      .set({ value, description: description ?? existing[0].description, updatedAt: new Date() })
      .where(eq(modelConfigTable.key, key));
  } else {
    await db.insert(modelConfigTable).values({ id: randomUUID(), key, value, description });
  }
}

// ── GET /api/projects/:id/training-signals ────────────────────────────────
// Per-project edit signals captured for the self-learning feedback loop
router.get("/projects/:id/training-signals", async (req, res) => {
  try {
    const projectId = req.params.id;

    const allEdits = await db
      .select()
      .from(segmentEditsTable)
      .where(eq(segmentEditsTable.projectId, projectId))
      .orderBy(desc(segmentEditsTable.createdAt));

    const totalEdits = allEdits.length;

    const byType: Record<string, number> = {};
    for (const e of allEdits) {
      byType[e.editType] = (byType[e.editType] ?? 0) + 1;
    }

    const recent = allEdits.slice(0, 5).map((e) => ({
      editType: e.editType,
      field: e.field,
      createdAt: e.createdAt,
    }));

    res.json({
      totalEdits,
      byType,
      recent,
      learningActive: totalEdits > 0,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── POST /api/projects/:id/auto-learn ────────────────────────────────────────
// Lightweight, no-LLM learn from current session edits.
// Called automatically by the frontend when edit count crosses 3 / 10 / 25.
// Updates learnedClipPrefsTable + correction_signal in modelConfigTable.
// Returns plain-English changedRules for the UI panel.
router.post("/projects/:id/auto-learn", async (req, res) => {
  try {
    const projectId = req.params.id;

    // 1. Load project to get format
    const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const format: string = (project as any).targetFormat ?? (project as any).format ?? "instagram_reel";

    // 2. Load all segments + their clip analysis from the video table
    const segments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, projectId));
    const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, projectId));

    const videoById = Object.fromEntries(videos.map(v => [v.id, v]));

    // 3. Build clip type / tag selection signals from current included/excluded state
    const signals: Record<string, { used: number; total: number }> = {};
    const accumulate = (key: string, included: boolean) => {
      if (!signals[key]) signals[key] = { used: 0, total: 0 };
      signals[key].total++;
      if (included) signals[key].used++;
    };

    for (const seg of segments) {
      const vid = seg.videoId ? videoById[seg.videoId] : null;
      if (!vid) continue;
      let analysis: any = {};
      try { analysis = JSON.parse(vid.clipAnalysis ?? "{}"); } catch {}
      const clipType: string | null = analysis.clipType ?? null;
      const tags: string[] = Array.isArray(analysis.tags) ? analysis.tags : [];
      const included = seg.included ?? true;
      if (clipType) accumulate(clipType, included);
      for (const tag of tags) accumulate(`tag:${tag}`, included);
    }

    // 4. Update learnedClipPrefsTable for each signal
    const changedRules: Array<{ label: string; selectionRate: number; direction: "prefer" | "avoid" | "neutral"; delta: number }> = [];
    const learningRate = 0.35; // faster than the full learn_from_edit to respond quickly

    for (const [key, sig] of Object.entries(signals)) {
      if (sig.total < 1) continue;
      const rawRate = sig.used / sig.total;
      const isTag = key.startsWith("tag:");
      const clipType = isTag ? null : key;
      const tag = isTag ? key.slice(4) : null;
      const displayLabel = isTag ? `clips tagged "${tag}"` : `clip type "${clipType}"`;

      const existing = await db.select().from(learnedClipPrefsTable).where(
        and(
          eq(learnedClipPrefsTable.format, format),
          clipType ? eq(learnedClipPrefsTable.clipType, clipType) : eq(learnedClipPrefsTable.clipType, ""),
          tag ? eq(learnedClipPrefsTable.tag, tag) : eq(learnedClipPrefsTable.tag, ""),
        )
      );

      let prevRate = 0.5;
      if (existing.length > 0) {
        prevRate = existing[0].selectionRate ?? 0.5;
        const newRate = Math.max(0, Math.min(1, prevRate * (1 - learningRate) + rawRate * learningRate));
        const delta = newRate - prevRate;
        await db.update(learnedClipPrefsTable)
          .set({ selectionRate: newRate, usageCount: (existing[0].usageCount ?? 0) + sig.total, lastUpdated: new Date() })
          .where(eq(learnedClipPrefsTable.id, existing[0].id));
        if (Math.abs(delta) > 0.03) {
          changedRules.push({ label: displayLabel, selectionRate: newRate, direction: newRate >= 0.70 ? "prefer" : newRate <= 0.35 ? "avoid" : "neutral", delta });
        }
      } else {
        await db.insert(learnedClipPrefsTable).values({
          id: randomUUID(),
          format,
          clipType: clipType ?? "",
          tag: tag ?? "",
          dimension: isTag ? "tag" : "clip_type",
          selectionRate: rawRate,
          usageCount: sig.total,
          avgPosition: 0.5,
          avgDuration: 0,
        });
        if (rawRate >= 0.70 || rawRate <= 0.35) {
          changedRules.push({ label: displayLabel, selectionRate: rawRate, direction: rawRate >= 0.70 ? "prefer" : "avoid", delta: rawRate - 0.5 });
        }
      }
    }

    // 5. Compute and persist timing correction signal from segment edits
    const edits = await db.select().from(segmentEditsTable).where(eq(segmentEditsTable.projectId, projectId));
    let totalDs = 0; let totalDe = 0; let deltaCount = 0;
    for (const e of edits) {
      if (e.deltaStartSeconds != null) { totalDs += e.deltaStartSeconds; deltaCount++; }
      if (e.deltaEndSeconds != null) { totalDe += e.deltaEndSeconds; }
    }
    const avgDeltaStart = deltaCount > 0 ? totalDs / deltaCount : 0;
    const avgDeltaEnd = deltaCount > 0 ? totalDe / deltaCount : 0;

    if (deltaCount > 0) {
      const corrKey = `correction_signal_${format}`;
      await upsertConfig(corrKey, JSON.stringify({ avgDeltaStart, avgDeltaEnd, editCount: edits.length, format, updatedAt: new Date().toISOString() }));
    }

    // 6. Build overall summary stats
    const allPrefs = await db.select().from(learnedClipPrefsTable).where(eq(learnedClipPrefsTable.format, format));
    const topPreferences = allPrefs
      .filter(p => (p.usageCount ?? 0) >= 2)
      .sort((a, b) => Math.abs((b.selectionRate ?? 0.5) - 0.5) - Math.abs((a.selectionRate ?? 0.5) - 0.5))
      .slice(0, 8)
      .map(p => ({
        label: p.tag ? `tag:${p.tag}` : p.clipType,
        selectionRate: p.selectionRate,
        direction: (p.selectionRate ?? 0.5) >= 0.70 ? "prefer" : (p.selectionRate ?? 0.5) <= 0.35 ? "avoid" : "neutral",
        usageCount: p.usageCount,
      }));

    res.json({
      ok: true,
      format,
      signalsProcessed: Object.keys(signals).length,
      changedRules: changedRules.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5),
      topPreferences,
      timingCorrection: deltaCount > 0 ? { avgDeltaStart, avgDeltaEnd, editCount: deltaCount } : null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── GET /api/model-intelligence ─────────────────────────────────────────────
// Called from the project workspace to show AI learning status
router.get("/model-intelligence", async (req, res) => {
  try {
    const format = String(req.query.format ?? "instagram_reel");

    const [{ totalExamples }] = await db
      .select({ totalExamples: sql<number>`cast(count(*) as int)` })
      .from(trainingExamplesTable);

    const [{ totalCorrections }] = await db
      .select({ totalCorrections: sql<number>`cast(count(*) as int)` })
      .from(segmentEditsTable);

    const prefs = await db
      .select()
      .from(learnedClipPrefsTable)
      .where(eq(learnedClipPrefsTable.format, format))
      .orderBy(desc(learnedClipPrefsTable.selectionRate))
      .limit(10);

    const activeModelRow = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "active_finetune_model"))
      .limit(1);

    const finetuneJobRow = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "latest_finetune_job_id"))
      .limit(1);

    const activeModel = activeModelRow[0]?.value ?? null;
    const finetuneJobId = finetuneJobRow[0]?.value ?? null;

    const topPrefs = prefs.map((p) => ({
      label: p.tag ? `tag:${p.tag}` : p.clipType,
      selectionRate: p.selectionRate,
      usageCount: p.usageCount,
      dimension: p.dimension,
    }));

    // Count signal types from corrections (editType breakdown for signalCounts)
    const editTypeCounts = await db
      .select({
        editType: segmentEditsTable.editType,
        count: sql<number>`cast(count(*) as int)`,
      })
      .from(segmentEditsTable)
      .groupBy(segmentEditsTable.editType);
    const signalCounts = Object.fromEntries(editTypeCounts.map((e) => [e.editType, e.count]));

    // ── Clip training pairs count (ML dataset size) ───────────────────────────
    const [{ totalPairs }] = await db
      .select({ totalPairs: sql<number>`cast(count(*) as int)` })
      .from(clipTrainingPairsTable);

    // ── Learnable formula weights ─────────────────────────────────────────────
    const [weightsRow] = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "formula_weights"))
      .limit(1);
    let formulaWeights: Record<string, number> | null = null;
    let formulaWeightsVersion = 0;
    if (weightsRow?.value) {
      try {
        const parsed = JSON.parse(weightsRow.value);
        formulaWeights = parsed;
        formulaWeightsVersion = parsed._version ?? 0;
      } catch {}
    }

    res.json({
      // New keys
      totalExamples,
      totalCorrections,
      format,
      topPrefs,
      activeModel,
      finetuneJobId,
      learningActive: totalExamples > 0,
      signalCounts,
      // ML dataset
      totalTrainingPairs: totalPairs,
      formulaWeights,
      formulaWeightsVersion,
      // Backward-compatible aliases consumed by projects/[id]/index.tsx
      totalTrainingExamples: totalExamples,
      totalLearnedPrefs: prefs.length,
      topPreferences: topPrefs,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed to load intelligence data" });
  }
});

// ── GET /api/training/overview ───────────────────────────────────────────────
router.get("/training/overview", async (_req, res) => {
  try {
    const [{ totalExamples }] = await db
      .select({ totalExamples: sql<number>`cast(count(*) as int)` })
      .from(trainingExamplesTable);

    const [{ totalCorrections }] = await db
      .select({ totalCorrections: sql<number>`cast(count(*) as int)` })
      .from(segmentEditsTable);

    const [{ totalPrefs }] = await db
      .select({ totalPrefs: sql<number>`cast(count(*) as int)` })
      .from(learnedClipPrefsTable);

    const recentExamples = await db
      .select()
      .from(trainingExamplesTable)
      .orderBy(desc(trainingExamplesTable.createdAt))
      .limit(10);

    const activeModelRow = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "active_finetune_model"))
      .limit(1);

    const finetuneJobRow = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "latest_finetune_job_id"))
      .limit(1);

    const formatBreakdown = await db
      .select({ format: trainingExamplesTable.format, count: sql<number>`cast(count(*) as int)` })
      .from(trainingExamplesTable)
      .groupBy(trainingExamplesTable.format);

    // Compute estimated accuracy improvement based on real learning signals:
    // - Learned prefs that deviate significantly from baseline 0.5 show the model has
    //   developed clear editorial opinions (not just guessing).
    // - We weight by training example count (confidence in the signal).
    const allPrefs = await db.select().from(learnedClipPrefsTable);
    let estimatedAccuracyGain = 0;
    if (allPrefs.length > 0 && totalExamples > 0) {
      const avgDeviation = allPrefs.reduce((sum, p) => sum + Math.abs((p.selectionRate ?? 0.5) - 0.5), 0) / allPrefs.length;
      const confidenceFactor = Math.min(1, totalExamples / 10);
      estimatedAccuracyGain = Math.round(avgDeviation * 2 * 100 * confidenceFactor);
    }

    // ── Clip training pairs count (ML dataset size) ───────────────────────────
    const [{ totalPairs }] = await db
      .select({ totalPairs: sql<number>`cast(count(*) as int)` })
      .from(clipTrainingPairsTable);

    // ── Learnable formula weights ─────────────────────────────────────────────
    const [weightsRow] = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "formula_weights"))
      .limit(1);
    let formulaWeights = null;
    let formulaWeightsVersion = 0;
    if (weightsRow?.value) {
      try { const p = JSON.parse(weightsRow.value); formulaWeights = p; formulaWeightsVersion = p._version ?? 0; } catch {}
    }

    res.json({
      totalExamples,
      totalCorrections,
      totalPrefs,
      totalTrainingPairs: totalPairs,
      estimatedAccuracyGain,
      activeModel: activeModelRow[0]?.value ?? null,
      finetuneJobId: finetuneJobRow[0]?.value ?? null,
      formulaWeights,
      formulaWeightsVersion,
      formatBreakdown: Object.fromEntries(formatBreakdown.map((f) => [f.format ?? "unknown", f.count])),
      recentExamples: recentExamples.map((e) => ({
        id: e.id,
        projectName: e.projectName,
        format: e.format,
        totalClipsAvailable: e.totalClipsAvailable,
        totalClipsUsed: e.totalClipsUsed,
        totalDuration: e.totalDuration,
        humanApproved: e.humanApproved,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── GET /api/training/corrections ───────────────────────────────────────────
router.get("/training/corrections", async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(String(req.query.limit ?? "50"), 10));
    const corrections = await db
      .select()
      .from(segmentEditsTable)
      .orderBy(desc(segmentEditsTable.createdAt))
      .limit(limit);

    // Expand each correction into canonical per-field diff rows so downstream
    // consumers can use the standard {field, aiValue, humanValue, editedAt} contract.
    const expanded: any[] = [];
    for (const c of corrections) {
      const base = {
        id: c.id,
        segmentId: c.segmentId,
        projectId: c.projectId,
        videoId: c.videoId,
        editType: c.editType,
        field: c.field,
        aiValue: c.aiValue,
        humanValue: c.humanValue,
        editedAt: c.editedAt.toISOString(),
        createdAt: c.createdAt.toISOString(),
        // wasKept: true for trim/reorder/speed/color edits (segment retained),
        // false when human excluded or deleted the segment.
        wasKept: c.editType === "delete"
          ? false
          : c.humanIncluded != null
          ? c.humanIncluded
          : true,
        // Full raw timing/order/include values for UI rendering (AI→Human diffs)
        aiStartTime: c.aiStartTime,
        humanStartTime: c.humanStartTime,
        aiEndTime: c.aiEndTime,
        humanEndTime: c.humanEndTime,
        aiIncluded: c.aiIncluded,
        humanIncluded: c.humanIncluded,
        deltaStartSeconds: c.deltaStartSeconds,
        deltaEndSeconds: c.deltaEndSeconds,
        aiOrderIndex: c.aiOrderIndex,
        humanOrderIndex: c.humanOrderIndex,
      };

      // Per-field diff — use the stored `field`/`aiValue`/`humanValue` columns
      // (written by the new PATCH handler); fall back to deriving from rich columns
      // for rows inserted before the schema upgrade.
      const fieldDiffs: Array<{ field: string; aiValue: any; humanValue: any; editedAt: string }> = [];
      if (c.field && c.aiValue !== null && c.humanValue !== null) {
        // New canonical per-field row — expose directly
        fieldDiffs.push({ field: c.field, aiValue: c.aiValue, humanValue: c.humanValue, editedAt: c.createdAt.toISOString() });
      } else {
        // Legacy wide-column row — derive per-field diffs from rich columns
        if (c.aiStartTime != null || c.humanStartTime != null) {
          fieldDiffs.push({ field: "startTime", aiValue: c.aiStartTime, humanValue: c.humanStartTime, editedAt: c.createdAt.toISOString() });
        }
        if (c.aiEndTime != null || c.humanEndTime != null) {
          fieldDiffs.push({ field: "endTime", aiValue: c.aiEndTime, humanValue: c.humanEndTime, editedAt: c.createdAt.toISOString() });
        }
        if (c.aiOrderIndex != null || c.humanOrderIndex != null) {
          fieldDiffs.push({ field: "orderIndex", aiValue: c.aiOrderIndex, humanValue: c.humanOrderIndex, editedAt: c.createdAt.toISOString() });
        }
        if (c.aiIncluded != null || c.humanIncluded != null) {
          fieldDiffs.push({ field: "included", aiValue: c.aiIncluded, humanValue: c.humanIncluded, editedAt: c.createdAt.toISOString() });
        }
      }

      expanded.push({ ...base, fieldDiffs });
    }

    res.json(expanded);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── POST /api/training/export-finetune ──────────────────────────────────────
// Exports training data as OpenAI fine-tuning JSONL and optionally submits it.
// Each training pair incorporates human corrections from segment_edits so the
// model learns both clip selection AND preferred timing adjustments.
router.post("/training/export-finetune", async (req, res) => {
  try {
    // Default is to submit to OpenAI fine-tuning (spec contract).
    // Pass submit: false in the body to download JSONL instead.
    const { submit = true } = req.body ?? {};
    const examples = await db
      .select()
      .from(trainingExamplesTable)
      .where(eq(trainingExamplesTable.humanApproved, true))
      .orderBy(desc(trainingExamplesTable.createdAt))
      .limit(200);

    if (examples.length === 0) {
      return res.status(400).json({
        error: "No approved training examples found. Run 'Learn from Edit' on completed projects first.",
      });
    }

    // Load all segment edit corrections so we can annotate each training pair
    const allCorrections = await db
      .select()
      .from(segmentEditsTable)
      .orderBy(desc(segmentEditsTable.createdAt));

    // Group corrections by projectId
    const correctionsByProject: Record<string, typeof allCorrections> = {};
    for (const c of allCorrections) {
      if (!correctionsByProject[c.projectId]) correctionsByProject[c.projectId] = [];
      correctionsByProject[c.projectId].push(c);
    }

    const lines: string[] = [];
    for (const ex of examples) {
      let rawClips: any[] = [];
      let finalTimeline: any[] = [];
      try { rawClips = Array.isArray(ex.rawClips) ? ex.rawClips : JSON.parse(ex.rawClips as any ?? "[]"); } catch {}
      try { finalTimeline = Array.isArray(ex.finalTimeline) ? ex.finalTimeline : JSON.parse(ex.finalTimeline as any ?? "[]"); } catch {}

      if (rawClips.length === 0 || finalTimeline.length === 0) continue;

      // Build correction context for this project
      const projectCorrections = correctionsByProject[ex.projectId] ?? [];
      let correctionContext = "";
      if (projectCorrections.length > 0) {
        const summary = projectCorrections.reduce(
          (acc, c) => {
            acc[c.editType] = (acc[c.editType] ?? 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );
        const avgDeltaStart = projectCorrections
          .filter((c) => c.deltaStartSeconds != null)
          .reduce((sum, c, _i, arr) => sum + (c.deltaStartSeconds ?? 0) / arr.length, 0);
        const avgDeltaEnd = projectCorrections
          .filter((c) => c.deltaEndSeconds != null)
          .reduce((sum, c, _i, arr) => sum + (c.deltaEndSeconds ?? 0) / arr.length, 0);

        correctionContext = `

Human corrections applied to this edit (${projectCorrections.length} total):
${Object.entries(summary).map(([type, count]) => `  - ${type}: ${count} times`).join("\n")}
Average timing correction: start ${avgDeltaStart >= 0 ? "+" : ""}${avgDeltaStart.toFixed(2)}s, end ${avgDeltaEnd >= 0 ? "+" : ""}${avgDeltaEnd.toFixed(2)}s
Note: A positive start-time correction means the AI cut too early; negative means too late.`;
      }

      // Include transcript context when available in rawClips metadata
      const transcriptLines: string[] = [];
      for (const clip of rawClips) {
        if (clip.transcript) {
          const txText = typeof clip.transcript === "string"
            ? clip.transcript.substring(0, 200)
            : "";
          if (txText) transcriptLines.push(`  "${clip.name}": "${txText}"`);
        }
        if (clip.timedPhrases && Array.isArray(clip.timedPhrases) && clip.timedPhrases.length > 0) {
          const phraseLines = clip.timedPhrases.slice(0, 5).map((p: any) =>
            `    [${p.start?.toFixed(2) ?? "?"}s→${p.end?.toFixed(2) ?? "?"}s] "${p.text?.trim() ?? ""}"`
          ).join("\n");
          transcriptLines.push(`  "${clip.name}" timed phrases:\n${phraseLines}`);
        }
      }
      const transcriptContext = transcriptLines.length > 0
        ? `\n\nTranscript context (use for dialogue-driven cuts):\n${transcriptLines.join("\n")}`
        : "";

      const userContent = `You are editing a ${ex.format?.replace(/_/g, " ") ?? "video"} for social media.

Available clips (${rawClips.length}):
${rawClips
  .map(
    (c: any, i: number) =>
      `[${i}] "${c.name}" — ${c.duration?.toFixed(1) ?? "?"}s | composite=${Math.round((c.compositeScore ?? 0.5) * 100)} hook=${Math.round((c.hookScore ?? 0.5) * 100)} emotion=${Math.round((c.emotionScore ?? 0.5) * 100)} | type: ${c.clipType ?? "unknown"} | tags: [${(c.tags ?? []).join(", ")}]`
  )
  .join("\n")}

Total clips available: ${ex.totalClipsAvailable}${transcriptContext}${correctionContext}`;

      // The assistant completion is the human-final timeline after all corrections
      const assistantContent = JSON.stringify({
        editPlan: {
          totalDuration: ex.totalDuration,
          avgClipDuration: ex.avgClipDuration,
          clipsUsed: ex.totalClipsUsed,
          segments: finalTimeline.map((seg: any) => ({
            videoId: seg.videoId,
            startTime: seg.startTime,
            endTime: seg.endTime,
            duration: seg.duration,
            position: seg.position,
            colorGrade: seg.colorGrade ?? "none",
            speedFactor: seg.speedFactor ?? 1.0,
            audioMixLevel: seg.audioMixLevel ?? 1.0,
            musicDuckLevel: seg.musicDuckLevel ?? 1.0,
          })),
        },
      });

      lines.push(
        JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "You are CutAI, a professional video editing AI trained to select the best clips and create compelling edits for social media. When given a list of available clips with their analysis scores, you produce an optimal edit plan selecting the best footage and arranging it into an engaging timeline. Apply any correction patterns indicated in the user message to refine timing decisions.",
            },
            { role: "user", content: userContent },
            { role: "assistant", content: assistantContent },
          ],
        })
      );
    }

    if (lines.length === 0) {
      return res.status(400).json({ error: "Not enough valid training examples to export." });
    }

    const jsonl = lines.join("\n");
    const exportId = randomUUID();

    if (!submit) {
      res.setHeader("Content-Type", "application/jsonl");
      res.setHeader("Content-Disposition", `attachment; filename="cutai-finetune-${exportId.slice(0, 8)}.jsonl"`);
      return res.send(jsonl);
    }

    // Submit to OpenAI fine-tuning
    const buffer = Buffer.from(jsonl, "utf-8");
    const file = new File([buffer], "training.jsonl", { type: "application/jsonl" });

    const uploadedFile = await openai.files.create({ file, purpose: "fine-tune" });

    const ftJob = await openai.fineTuning.jobs.create({
      training_file: uploadedFile.id,
      model: "gpt-4o-mini",
    });

    // Store job ID in model_config
    await upsertConfig("latest_finetune_job_id", ftJob.id, "Latest OpenAI fine-tuning job ID");

    res.json({
      success: true,
      jobId: ftJob.id,
      status: ftJob.status,
      trainingExamples: lines.length,
      correctionsIncluded: allCorrections.length,
      model: "gpt-4o-mini",
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Export failed" });
  }
});

// ── GET /api/training/finetune-status ───────────────────────────────────────
// Polls OpenAI for job status. When a job has succeeded, automatically persists
// the fine_tuned_model ID to model_config so generate_edit_plan can use it.
router.get("/training/finetune-status", async (_req, res) => {
  try {
    const jobRow = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "latest_finetune_job_id"))
      .limit(1);

    if (jobRow.length === 0) {
      const activeModelRow = await db
        .select()
        .from(modelConfigTable)
        .where(eq(modelConfigTable.key, "active_finetune_model"))
        .limit(1);
      return res.json({ jobs: [], activeModel: activeModelRow[0]?.value ?? null });
    }

    const jobId = jobRow[0].value;
    let currentJob: any = null;
    let allJobs: any[] = [];

    try {
      currentJob = await openai.fineTuning.jobs.retrieve(jobId);
      const listResult = await openai.fineTuning.jobs.list({ limit: 10 });
      allJobs = listResult.data ?? [];
    } catch {
      const activeModelRow = await db
        .select()
        .from(modelConfigTable)
        .where(eq(modelConfigTable.key, "active_finetune_model"))
        .limit(1);
      return res.json({
        jobs: [],
        activeModel: activeModelRow[0]?.value ?? null,
        error: "Could not reach OpenAI fine-tuning API",
      });
    }

    // Auto-persist succeeded model to model_config so generate_edit_plan picks it up
    if (currentJob?.status === "succeeded" && currentJob?.fine_tuned_model) {
      await upsertConfig(
        "active_finetune_model",
        currentJob.fine_tuned_model,
        `Auto-activated from fine-tuning job ${currentJob.id} at ${new Date().toISOString()}`
      );
    }

    const activeModelRow = await db
      .select()
      .from(modelConfigTable)
      .where(eq(modelConfigTable.key, "active_finetune_model"))
      .limit(1);

    res.json({
      currentJob: currentJob
        ? {
            id: currentJob.id,
            status: currentJob.status,
            model: currentJob.model,
            fineTunedModel: currentJob.fine_tuned_model,
            trainedTokens: currentJob.trained_tokens,
            createdAt: currentJob.created_at,
            finishedAt: currentJob.finished_at,
          }
        : null,
      jobs: allJobs.map((j: any) => ({
        id: j.id,
        status: j.status,
        model: j.model,
        fineTunedModel: j.fine_tuned_model,
        trainedTokens: j.trained_tokens,
        createdAt: j.created_at,
        finishedAt: j.finished_at,
      })),
      activeModel: activeModelRow[0]?.value ?? null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── POST /api/training/activate-model ───────────────────────────────────────
router.post("/training/activate-model", async (req, res) => {
  try {
    const { modelId } = req.body ?? {};
    if (!modelId) return res.status(400).json({ error: "modelId is required" });
    await upsertConfig("active_finetune_model", modelId, `Manually activated at ${new Date().toISOString()}`);
    res.json({ success: true, activeModel: modelId });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── DELETE /api/training/deactivate-model ───────────────────────────────────
router.delete("/training/deactivate-model", async (_req, res) => {
  try {
    await db.delete(modelConfigTable).where(eq(modelConfigTable.key, "active_finetune_model"));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

// ── GET /api/training/prefs ──────────────────────────────────────────────────
router.get("/training/prefs", async (req, res) => {
  try {
    const format = String(req.query.format ?? "");
    const prefs = format
      ? await db
          .select()
          .from(learnedClipPrefsTable)
          .where(eq(learnedClipPrefsTable.format, format))
          .orderBy(desc(learnedClipPrefsTable.selectionRate))
      : await db
          .select()
          .from(learnedClipPrefsTable)
          .orderBy(desc(learnedClipPrefsTable.selectionRate))
          .limit(100);
    res.json(prefs.map((p) => ({ ...p, lastUpdated: p.lastUpdated.toISOString() })));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Failed" });
  }
});

export default router;
