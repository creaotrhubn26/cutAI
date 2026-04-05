import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { editStylesTable } from "@workspace/db";
import { eq, and, sql, like, ilike } from "drizzle-orm";
import { randomUUID } from "crypto";

const router: IRouter = Router();

// ── List styles (with optional category/search filter) ──────────────────
router.get("/styles", async (req, res) => {
  const category = req.query.category as string | undefined;
  const search = req.query.search as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string ?? "100"), 500);
  const offset = parseInt(req.query.offset as string ?? "0");

  let query = db.select({
    id: editStylesTable.id,
    name: editStylesTable.name,
    category: editStylesTable.category,
    subcategory: editStylesTable.subcategory,
    description: editStylesTable.description,
    source: editStylesTable.source,
    avgClipDuration: editStylesTable.avgClipDuration,
    cutsPerMinute: editStylesTable.cutsPerMinute,
    primaryColorGrade: editStylesTable.primaryColorGrade,
    beatSyncStrength: editStylesTable.beatSyncStrength,
    slowMotionPct: editStylesTable.slowMotionPct,
    musicDuckOnSpeech: editStylesTable.musicDuckOnSpeech,
    musicDuckLevel: editStylesTable.musicDuckLevel,
    captionStyle: editStylesTable.captionStyle,
    verified: editStylesTable.verified,
    usageCount: editStylesTable.usageCount,
    createdAt: editStylesTable.createdAt,
  }).from(editStylesTable).$dynamic();

  if (category) query = query.where(eq(editStylesTable.category, category)) as typeof query;
  if (search) query = query.where(ilike(editStylesTable.name, `%${search}%`)) as typeof query;
  query = query.orderBy(sql`${editStylesTable.usageCount} DESC, ${editStylesTable.verified} DESC`).limit(limit).offset(offset) as typeof query;

  const styles = await query;
  const [{ total }] = await db.select({ total: sql<number>`cast(count(*) as int)` }).from(editStylesTable);

  res.json({ styles, total, limit, offset });
});

// ── Get categories summary ──────────────────────────────────────────────
router.get("/styles/categories", async (req, res) => {
  const cats = await db
    .select({
      category: editStylesTable.category,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(editStylesTable)
    .groupBy(editStylesTable.category)
    .orderBy(sql`count(*) DESC`);
  res.json(cats);
});

// ── Get single style (full DNA) ─────────────────────────────────────────
router.get("/styles/:id", async (req, res) => {
  const [style] = await db.select().from(editStylesTable).where(eq(editStylesTable.id, req.params.id));
  if (!style) return res.status(404).json({ error: "Style not found" });

  // Don't return the raw FCPXML in the listing view (large payload)
  const { rawFcpxml, ...rest } = style;
  res.json({ ...rest, hasRawFcpxml: !!rawFcpxml });
});

// ── Upload FCPXML to learn a new style ─────────────────────────────────
// The actual analysis happens in the learn_xml_style job handler.
// This route just accepts the XML and queues the job.
router.post("/styles/learn", async (req, res) => {
  const { fcpxml, name } = req.body as { fcpxml: string; name?: string };
  if (!fcpxml || typeof fcpxml !== "string") {
    return res.status(400).json({ error: "fcpxml body field required" });
  }

  // Quick sanity check — must look like FCPXML
  if (!fcpxml.includes("<fcpxml") && !fcpxml.includes("<xmeml")) {
    return res.status(400).json({ error: "Content does not appear to be a valid FCPXML or XML file" });
  }

  const styleId = randomUUID();
  const styleName = name ?? `User Style — ${new Date().toLocaleDateString("en-US")}`;

  // Create a placeholder style record (will be filled by the analysis job)
  await db.insert(editStylesTable).values({
    id: styleId,
    name: styleName,
    category: "user",
    subcategory: "pending",
    description: "Pending analysis from uploaded FCPXML",
    source: "user",
    rawFcpxml: fcpxml,
    sourceFile: `${styleName}.fcpxml`,
    verified: false,
    usageCount: 0,
  });

  res.status(202).json({
    id: styleId,
    message: "FCPXML received. Run the learn_xml_style job to extract editing DNA.",
    styleId,
  });
});

// ── Apply style — increment usage count ────────────────────────────────
router.post("/styles/:id/apply", async (req, res) => {
  const [style] = await db.select().from(editStylesTable).where(eq(editStylesTable.id, req.params.id));
  if (!style) return res.status(404).json({ error: "Style not found" });

  await db
    .update(editStylesTable)
    .set({ usageCount: (style.usageCount ?? 0) + 1, updatedAt: new Date() })
    .where(eq(editStylesTable.id, req.params.id));

  res.json({ ok: true });
});

// ── Delete user-uploaded style ──────────────────────────────────────────
router.delete("/styles/:id", async (req, res) => {
  const [style] = await db.select().from(editStylesTable).where(eq(editStylesTable.id, req.params.id));
  if (!style) return res.status(404).json({ error: "Style not found" });
  if (style.source !== "user") return res.status(403).json({ error: "Cannot delete built-in styles" });

  await db.delete(editStylesTable).where(eq(editStylesTable.id, req.params.id));
  res.json({ ok: true });
});

export default router;
