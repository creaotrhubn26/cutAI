import { Router } from "express";
import { db } from "@workspace/db";
import { styleProfilesTable, projectsTable, clipEmbeddingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const router = Router();

// GET /api/style-profiles — list all style profiles
router.get("/style-profiles", async (_req, res) => {
  try {
    const profiles = await db.select().from(styleProfilesTable).orderBy(styleProfilesTable.createdAt);
    res.json({ profiles });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/style-profiles — create a new style profile
router.post("/style-profiles", async (req, res) => {
  try {
    const {
      name, description, targetAudience, pacing, cutStyle, transitionStyle,
      colorGrade, musicMood, hookStrategy, formatPreferences, systemPromptOverride,
    } = req.body;

    if (!name) return res.status(400).json({ error: "name is required" });

    const [profile] = await db.insert(styleProfilesTable).values({
      id: randomUUID(),
      name,
      description: description ?? null,
      targetAudience: targetAudience ?? null,
      pacing: pacing ?? "medium",
      cutStyle: cutStyle ?? "hard",
      transitionStyle: transitionStyle ?? "cut",
      colorGrade: colorGrade ?? "none",
      musicMood: musicMood ?? null,
      hookStrategy: hookStrategy ?? null,
      formatPreferences: formatPreferences ?? null,
      systemPromptOverride: systemPromptOverride ?? null,
    }).returning();

    res.json({ profile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/style-profiles/:id
router.get("/style-profiles/:id", async (req, res) => {
  try {
    const [profile] = await db.select().from(styleProfilesTable).where(eq(styleProfilesTable.id, req.params.id));
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json({ profile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/style-profiles/:id
router.patch("/style-profiles/:id", async (req, res) => {
  try {
    const allowed = [
      "name", "description", "targetAudience", "pacing", "cutStyle", "transitionStyle",
      "colorGrade", "musicMood", "hookStrategy", "formatPreferences", "systemPromptOverride",
    ];
    const updates: Record<string, any> = { updatedAt: new Date() };
    for (const key of allowed) {
      if (key in req.body) updates[key] = req.body[key];
    }
    const [profile] = await db.update(styleProfilesTable).set(updates).where(eq(styleProfilesTable.id, req.params.id)).returning();
    if (!profile) return res.status(404).json({ error: "Profile not found" });
    res.json({ profile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/style-profiles/:id
router.delete("/style-profiles/:id", async (req, res) => {
  try {
    await db.update(projectsTable).set({ styleProfileId: null })
      .where(eq(projectsTable.styleProfileId, req.params.id));
    await db.delete(styleProfilesTable).where(eq(styleProfilesTable.id, req.params.id));
    res.json({ deleted: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/projects/:id/style-profile — assign profile to project
router.patch("/projects/:id/style-profile", async (req, res) => {
  try {
    const { styleProfileId } = req.body;
    const [project] = await db.update(projectsTable)
      .set({ styleProfileId: styleProfileId ?? null, updatedAt: new Date() })
      .where(eq(projectsTable.id, req.params.id))
      .returning();
    if (!project) return res.status(404).json({ error: "Project not found" });
    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/similar-clips — cosine similarity retrieval
router.get("/projects/:id/similar-clips", async (req, res) => {
  try {
    const { clipId, limit = "5" } = req.query as { clipId?: string; limit?: string };
    const projectId = req.params.id;

    const embeddings = await db.select().from(clipEmbeddingsTable)
      .where(eq(clipEmbeddingsTable.projectId, projectId));

    if (embeddings.length === 0) {
      return res.json({ similar: [], note: "Run Embed Clips job first to generate embeddings" });
    }

    if (!clipId) {
      return res.json({ clips: embeddings.map(e => ({ videoId: e.videoId, inputText: e.inputText })) });
    }

    const target = embeddings.find(e => e.videoId === clipId);
    if (!target) return res.status(404).json({ error: "Clip embedding not found" });

    const targetVec = JSON.parse(target.embedding) as number[];

    const cosineSim = (a: number[], b: number[]) => {
      let dot = 0, normA = 0, normB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
      }
      return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
    };

    const scored = embeddings
      .filter(e => e.videoId !== clipId)
      .map(e => ({
        videoId: e.videoId,
        similarity: Math.round(cosineSim(targetVec, JSON.parse(e.embedding) as number[]) * 1000) / 1000,
        inputText: e.inputText,
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, parseInt(limit));

    res.json({ similar: scored });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
