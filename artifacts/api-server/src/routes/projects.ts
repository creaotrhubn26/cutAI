import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { projectsTable, videosTable, segmentsTable, jobsTable, activityTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  CreateProjectBody,
  UpdateProjectBody,
  GetProjectParams,
  UpdateProjectParams,
  DeleteProjectParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/projects", async (req, res) => {
  const projects = await db.select().from(projectsTable).orderBy(sql`${projectsTable.updatedAt} DESC`);
  const videoCountsRaw = await db
    .select({ projectId: videosTable.projectId, count: sql<number>`cast(count(*) as int)` })
    .from(videosTable)
    .groupBy(videosTable.projectId);
  const segmentCountsRaw = await db
    .select({ projectId: segmentsTable.projectId, count: sql<number>`cast(count(*) as int)` })
    .from(segmentsTable)
    .groupBy(segmentsTable.projectId);

  const videoCounts = Object.fromEntries(videoCountsRaw.map((r) => [r.projectId, r.count]));
  const segmentCounts = Object.fromEntries(segmentCountsRaw.map((r) => [r.projectId, r.count]));

  const result = projects.map((p) => ({
    ...p,
    videoCount: videoCounts[p.id] ?? 0,
    segmentCount: segmentCounts[p.id] ?? 0,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }));
  res.json(result);
});

router.post("/projects", async (req, res) => {
  const body = CreateProjectBody.parse(req.body);
  const id = randomUUID();
  const [project] = await db
    .insert(projectsTable)
    .values({ id, name: body.name, description: body.description ?? null, targetFormat: body.targetFormat })
    .returning();

  await db.insert(activityTable).values({
    id: randomUUID(),
    type: "project_created",
    description: `Project "${body.name}" created`,
    projectId: id,
    projectName: body.name,
  });

  res.status(201).json({ ...project, videoCount: 0, segmentCount: 0, createdAt: project.createdAt.toISOString(), updatedAt: project.updatedAt.toISOString() });
});

router.get("/projects/:id", async (req, res) => {
  const { id } = GetProjectParams.parse(req.params);
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) return res.status(404).json({ error: "Not found" });

  const videos = await db.select().from(videosTable).where(eq(videosTable.projectId, id));
  const segments = await db.select().from(segmentsTable).where(eq(segmentsTable.projectId, id)).orderBy(segmentsTable.orderIndex);
  const jobs = await db.select().from(jobsTable).where(eq(jobsTable.projectId, id)).orderBy(sql`${jobsTable.createdAt} DESC`);

  res.json({
    ...project,
    videoCount: videos.length,
    segmentCount: segments.length,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    videos: videos.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
    segments: segments.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
    jobs: jobs.map((j) => ({
      ...j,
      createdAt: j.createdAt.toISOString(),
      startedAt: j.startedAt?.toISOString() ?? null,
      completedAt: j.completedAt?.toISOString() ?? null,
    })),
  });
});

router.patch("/projects/:id", async (req, res) => {
  const { id } = UpdateProjectParams.parse(req.params);
  const body = UpdateProjectBody.parse(req.body);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (body.name != null) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;
  if (body.targetFormat != null) updates.targetFormat = body.targetFormat;
  if (body.status != null) updates.status = body.status;

  const [project] = await db.update(projectsTable).set(updates).where(eq(projectsTable.id, id)).returning();
  if (!project) return res.status(404).json({ error: "Not found" });

  const videoCounts = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(videosTable)
    .where(eq(videosTable.projectId, id));
  const segmentCounts = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(segmentsTable)
    .where(eq(segmentsTable.projectId, id));

  res.json({
    ...project,
    videoCount: videoCounts[0]?.count ?? 0,
    segmentCount: segmentCounts[0]?.count ?? 0,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
});

router.put("/projects/:id/vocabulary", async (req, res) => {
  const id = req.params.id;
  const { customVocabulary } = req.body as { customVocabulary: string };
  if (typeof customVocabulary !== "string")
    return res.status(400).json({ error: "customVocabulary must be a string" });

  const [project] = await db
    .update(projectsTable)
    .set({ customVocabulary, updatedAt: new Date() })
    .where(eq(projectsTable.id, id))
    .returning();
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json({ id: project.id, customVocabulary: project.customVocabulary });
});

router.put("/projects/:id/manuscript", async (req, res) => {
  const id = req.params.id;
  const { manuscript } = req.body as { manuscript: string };
  if (typeof manuscript !== "string") return res.status(400).json({ error: "manuscript must be a string" });
  const [project] = await db
    .update(projectsTable)
    .set({ manuscript, manuscriptAnalysis: null, updatedAt: new Date() })
    .where(eq(projectsTable.id, id))
    .returning();
  if (!project) return res.status(404).json({ error: "Project not found" });
  res.json({ id: project.id, manuscript: project.manuscript, manuscriptAnalysis: project.manuscriptAnalysis });
});

// ── Quality rating endpoint — drives RL feedback loop ─────────────────────────
router.patch("/projects/:id/rating", async (req, res) => {
  const id = req.params.id;
  const { rating } = req.body as { rating: number };
  if (typeof rating !== "number" || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "rating must be 1–5" });
  }
  const [project] = await db
    .update(projectsTable)
    .set({ qualityRating: rating, updatedAt: new Date() })
    .where(eq(projectsTable.id, id))
    .returning();
  if (!project) return res.status(404).json({ error: "Not found" });
  res.json({ id: project.id, qualityRating: project.qualityRating });
});

// ── Auto-apply pacing suggestions to segment durations ────────────────────────
router.post("/projects/:id/apply-pacing", async (req, res) => {
  const id = req.params.id;
  const { issues } = req.body as {
    issues: Array<{ clipIndex: number; suggestedDuration: number | null }>
  };

  if (!Array.isArray(issues)) return res.status(400).json({ error: "issues must be an array" });

  const segs = await db
    .select()
    .from(segmentsTable)
    .where(eq(segmentsTable.projectId, id));

  const included = segs
    .filter(s => s.included !== false)
    .sort((a, b) => (a.orderIndex ?? a.position ?? 0) - (b.orderIndex ?? b.position ?? 0));

  let applied = 0;
  for (const issue of issues) {
    if (!issue.suggestedDuration || issue.clipIndex < 1) continue;
    const seg = included[issue.clipIndex - 1];
    if (!seg) continue;
    const newEnd = parseFloat((seg.startTime + issue.suggestedDuration).toFixed(3));
    await db.update(segmentsTable).set({ endTime: newEnd }).where(eq(segmentsTable.id, seg.id));
    applied++;
  }

  await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, id));
  res.json({ applied, total: issues.length });
});

// ── Bulk segment update (label, caption, included) — Descript-style sync ──────
router.patch("/projects/:id/segments/bulk", async (req, res) => {
  const id = req.params.id;
  const { updates } = req.body as {
    updates: Array<{ id: string; label?: string; captionText?: string; included?: boolean }>
  };

  if (!Array.isArray(updates)) return res.status(400).json({ error: "updates must be an array" });

  let applied = 0;
  for (const upd of updates) {
    if (!upd.id) continue;
    const patch: Record<string, any> = {};
    if (upd.label !== undefined) patch.label = upd.label;
    if (upd.captionText !== undefined) patch.captionText = upd.captionText;
    if (upd.included !== undefined) patch.included = upd.included;
    if (Object.keys(patch).length === 0) continue;
    await db.update(segmentsTable).set(patch).where(eq(segmentsTable.id, upd.id));
    applied++;
  }

  await db.update(projectsTable).set({ updatedAt: new Date() }).where(eq(projectsTable.id, id));
  res.json({ applied });
});

router.delete("/projects/:id", async (req, res) => {
  const { id } = DeleteProjectParams.parse(req.params);
  await db.delete(segmentsTable).where(eq(segmentsTable.projectId, id));
  await db.delete(jobsTable).where(eq(jobsTable.projectId, id));
  await db.delete(videosTable).where(eq(videosTable.projectId, id));
  await db.delete(projectsTable).where(eq(projectsTable.id, id));
  res.status(204).send();
});

export default router;
