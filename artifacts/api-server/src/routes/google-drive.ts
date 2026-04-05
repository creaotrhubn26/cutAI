import { Router } from "express";
import fs from "fs";
import path from "path";
import { db } from "@workspace/db";
import { projectsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { getDriveClient } from "../lib/google";

const router = Router();
const RENDER_DIR = "/tmp/cutai-renders";

/** POST /api/projects/:id/upload-to-drive
 *  Uploads the rendered MP4 for a project to Google Drive.
 */
router.post("/projects/:id/upload-to-drive", async (req, res) => {
  const { id } = req.params;

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
    const drive = getDriveClient();
    const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

    const fileName = `${project.name.replace(/[^a-zA-Z0-9 _-]/g, "")}.mp4`;
    const fileSize = fs.statSync(renderPath).size;

    const response = await drive.files.create({
      requestBody: {
        name: fileName,
        mimeType: "video/mp4",
        parents: folderId ? [folderId] : undefined,
      },
      media: {
        mimeType: "video/mp4",
        body: fs.createReadStream(renderPath),
      },
      fields: "id,name,webViewLink,webContentLink",
    }, {
      onUploadProgress: () => {},
    });

    await drive.permissions.create({
      fileId: response.data.id!,
      requestBody: { role: "reader", type: "anyone" },
    });

    res.json({
      ok: true,
      fileId: response.data.id,
      fileName: response.data.name,
      webViewLink: response.data.webViewLink,
      webContentLink: response.data.webContentLink,
      sizeMB: Math.round(fileSize / 1024 / 1024 * 10) / 10,
    });
  } catch (err: any) {
    console.error("Drive upload error:", err.message ?? err);
    res.status(500).json({ error: err.message ?? "Drive upload failed" });
  }
});

/** GET /api/drive-folders?parent=FOLDER_ID
 *  Lists Google Drive folders inside the given parent (or root if omitted).
 *  Returns: [{ id, name, hasChildren }]
 */
router.get("/drive-folders", async (req, res) => {
  const parent = (req.query.parent as string | undefined) ?? "root";
  try {
    const drive = getDriveClient();
    const q = `'${parent}' in parents AND mimeType = 'application/vnd.google-apps.folder' AND trashed = false`;
    const list = await drive.files.list({
      q,
      fields: "files(id, name)",
      orderBy: "name",
      pageSize: 200,
      spaces: "drive",
    });
    const folders = list.data.files ?? [];

    // Quick check for which folders have sub-folders (one parallel request per folder)
    const withChildren = await Promise.all(
      folders.map(async (f) => {
        try {
          const check = await drive.files.list({
            q: `'${f.id}' in parents AND mimeType = 'application/vnd.google-apps.folder' AND trashed = false`,
            fields: "files(id)",
            pageSize: 1,
            spaces: "drive",
          });
          return { id: f.id!, name: f.name!, hasChildren: (check.data.files?.length ?? 0) > 0 };
        } catch {
          return { id: f.id!, name: f.name!, hasChildren: false };
        }
      })
    );

    res.json(withChildren);
  } catch (err: any) {
    console.error("Drive folder list error:", err.message ?? err);
    res.status(500).json({ error: err.message ?? "Failed to list Drive folders" });
  }
});

export default router;
