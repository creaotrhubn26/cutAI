import { Router } from "express";
import fs from "fs";
import path from "path";
import { db } from "@workspace/db";
import { projectsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getYouTubeClient } from "../lib/google";

const router = Router();
const RENDER_DIR = "/tmp/cutai-renders";

/** POST /api/projects/:id/upload-to-youtube
 *  Uploads the rendered MP4 as an unlisted YouTube video.
 */
router.post("/projects/:id/upload-to-youtube", async (req, res) => {
  const { id } = req.params;
  const { title, description, privacyStatus = "unlisted" } = req.body as {
    title?: string;
    description?: string;
    privacyStatus?: "public" | "unlisted" | "private";
  };

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const renderPath = path.join(RENDER_DIR, `${id}.mp4`);
  if (!fs.existsSync(renderPath)) {
    res.status(404).json({ error: "No render found for this project. Render the project first." });
    return;
  }

  try {
    const youtube = getYouTubeClient();
    const fileStream = fs.createReadStream(renderPath);
    const fileSize = fs.statSync(renderPath).size;

    const response = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: {
          title: title ?? project.name,
          description: description ?? `Edited with CutAI\n\n${project.description ?? ""}`,
          tags: ["CutAI", "AI video editor"],
          categoryId: "22",
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
      },
      media: {
        mimeType: "video/mp4",
        body: fileStream,
      },
    }, {
      onUploadProgress: (evt: { bytesRead: number }) => {
        const progress = Math.round((evt.bytesRead / fileSize) * 100);
        console.log(`YouTube upload: ${progress}%`);
      },
    });

    const videoId = response.data.id;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    res.json({
      ok: true,
      videoId,
      videoUrl,
      title: response.data.snippet?.title,
      privacyStatus: response.data.status?.privacyStatus,
    });
  } catch (err: any) {
    console.error("YouTube upload error:", err.message ?? err);
    res.status(500).json({ error: err.message ?? "YouTube upload failed" });
  }
});

export default router;
