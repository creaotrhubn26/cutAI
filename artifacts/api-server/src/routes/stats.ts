import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { projectsTable, videosTable, exportsTable, jobsTable, activityTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/stats/overview", async (req, res) => {
  const [{ totalProjects }] = await db.select({ totalProjects: sql<number>`cast(count(*) as int)` }).from(projectsTable);
  const [{ totalVideosUploaded }] = await db.select({ totalVideosUploaded: sql<number>`cast(count(*) as int)` }).from(videosTable);
  const [{ totalExports }] = await db.select({ totalExports: sql<number>`cast(count(*) as int)` }).from(exportsTable);
  const [{ totalAiJobsRun }] = await db.select({ totalAiJobsRun: sql<number>`cast(count(*) as int)` }).from(jobsTable);

  const statusGroups = await db
    .select({ status: projectsTable.status, count: sql<number>`cast(count(*) as int)` })
    .from(projectsTable)
    .groupBy(projectsTable.status);
  const projectsByStatus: Record<string, number> = {};
  for (const g of statusGroups) projectsByStatus[g.status] = g.count;

  const formatGroups = await db
    .select({ format: projectsTable.targetFormat, count: sql<number>`cast(count(*) as int)` })
    .from(projectsTable)
    .groupBy(projectsTable.targetFormat);
  const projectsByFormat: Record<string, number> = {};
  for (const g of formatGroups) projectsByFormat[g.format] = g.count;

  res.json({
    totalProjects,
    totalVideosUploaded,
    totalExports,
    totalAiJobsRun,
    averageEditTimeSavedMinutes: totalAiJobsRun > 0 ? Math.round(totalAiJobsRun * 12.5 * 10) / 10 : 0,
    projectsByStatus,
    projectsByFormat,
  });
});

router.get("/stats/recent-activity", async (req, res) => {
  const activities = await db
    .select()
    .from(activityTable)
    .orderBy(sql`${activityTable.timestamp} DESC`)
    .limit(20);
  res.json(
    activities.map((a) => ({
      ...a,
      timestamp: a.timestamp.toISOString(),
    }))
  );
});

export default router;
