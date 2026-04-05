import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { exportsTable, projectsTable, segmentsTable, activityTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import {
  CreateExportBody,
  GetExportParams,
  ListProjectExportsParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function serializeExport(e: typeof exportsTable.$inferSelect) {
  return {
    ...e,
    createdAt: e.createdAt.toISOString(),
    completedAt: e.completedAt?.toISOString() ?? null,
  };
}

async function simulateExport(exportId: string, projectId: string) {
  await db.update(exportsTable).set({ status: "rendering", progress: 10 }).where(eq(exportsTable.id, exportId));
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, projectId));

  const steps = [20, 40, 60, 80, 95];
  for (const p of steps) {
    await new Promise((r) => setTimeout(r, 1500));
    await db.update(exportsTable).set({ progress: p }).where(eq(exportsTable.id, exportId));
  }

  const [exp] = await db.select().from(exportsTable).where(eq(exportsTable.id, exportId));
  const filename = `cutai_export_${Date.now()}.${exp?.format ?? "mp4"}`;
  const filePath = `/tmp/cutai-exports/${filename}`;

  await db
    .update(exportsTable)
    .set({
      status: "completed",
      progress: 100,
      filePath,
      fileSize: Math.floor(Math.random() * 50 * 1024 * 1024) + 5 * 1024 * 1024,
      downloadUrl: `/api/exports/${exportId}/download`,
      completedAt: new Date(),
    })
    .where(eq(exportsTable.id, exportId));

  await db.update(projectsTable).set({ status: "exported", updatedAt: new Date() }).where(eq(projectsTable.id, projectId));
  await db.insert(activityTable).values({
    id: randomUUID(),
    type: "export_ready",
    description: `Export ready for "${project?.name ?? projectId}"`,
    projectId,
    projectName: project?.name ?? null,
  });
}

router.post("/exports", async (req, res) => {
  const body = CreateExportBody.parse(req.body);
  const id = randomUUID();
  const [exp] = await db
    .insert(exportsTable)
    .values({ id, projectId: body.projectId, format: body.format, resolution: body.resolution })
    .returning();

  simulateExport(id, body.projectId).catch(() => {});

  res.status(201).json(serializeExport(exp));
});

router.get("/exports/:id", async (req, res) => {
  const { id } = GetExportParams.parse(req.params);
  const [exp] = await db.select().from(exportsTable).where(eq(exportsTable.id, id));
  if (!exp) return res.status(404).json({ error: "Not found" });
  res.json(serializeExport(exp));
});

router.get("/projects/:id/exports", async (req, res) => {
  const { id } = ListProjectExportsParams.parse(req.params);
  const exports_ = await db.select().from(exportsTable).where(eq(exportsTable.projectId, id)).orderBy(sql`${exportsTable.createdAt} DESC`);
  res.json(exports_.map(serializeExport));
});

export default router;
