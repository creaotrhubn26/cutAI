import { Router } from "express";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { db } from "@workspace/db";
import { projectsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

const router = Router();
const RENDER_DIR = "/tmp/cutai-renders";

async function requireRender(projectId: string, res: any): Promise<string | null> {
  const renderPath = path.join(RENDER_DIR, `${projectId}.mp4`);
  if (!fs.existsSync(renderPath)) {
    res.status(404).json({ error: "No render found. Export the project first (Export tab → Render to MP4)." });
    return null;
  }
  return renderPath;
}

function httpsPost(urlStr: string, body: string, headers: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(opts, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(urlStr: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: "GET", headers };
    const req = https.request(opts, (r) => {
      let d = ""; r.on("data", (c) => (d += c));
      r.on("end", () => { try { resolve(JSON.parse(d)); } catch { resolve({ _raw: d }); } });
    });
    req.on("error", reject);
    req.end();
  });
}

function httpsUploadFile(urlStr: string, filePath: string, method = "PUT", extraHeaders: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const fileSize = fs.statSync(filePath).size;
    const protocol = urlStr.startsWith("https") ? https : http;
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": fileSize,
        ...extraHeaders,
      },
    };
    const req = (protocol as any).request(opts, (r: any) => {
      let d = ""; r.on("data", (c: any) => (d += c));
      r.on("end", () => resolve({ status: r.statusCode, body: d }));
    });
    req.on("error", reject);
    fs.createReadStream(filePath).pipe(req);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// TikTok Content Posting API v2
// Env: TIKTOK_ACCESS_TOKEN, TIKTOK_OPEN_ID
// ─────────────────────────────────────────────────────────────────────────────
router.post("/projects/:id/upload-to-tiktok", async (req, res) => {
  const { id } = req.params;
  const { title, privacyLevel = "SELF_ONLY" } = req.body as {
    title?: string;
    privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
  };

  const accessToken = process.env.TIKTOK_ACCESS_TOKEN;
  if (!accessToken) {
    res.status(400).json({
      error:
        "TikTok not connected. Add TIKTOK_ACCESS_TOKEN to your Secrets (Settings → Secrets). " +
        "Obtain this from the TikTok Developer Portal → Content Posting API → OAuth 2.0 flow.",
    });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const renderPath = await requireRender(id, res);
  if (!renderPath) return;

  try {
    const fileSize = fs.statSync(renderPath).size;
    const postTitle = (title ?? project.name ?? "CutAI Export").slice(0, 150);

    // Step 1: Init upload
    const init = await httpsPost(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      JSON.stringify({
        post_info: {
          title: postTitle,
          privacy_level: privacyLevel,
          disable_duet: false,
          disable_comment: false,
          disable_stitch: false,
          video_cover_timestamp_ms: 1000,
        },
        source_info: {
          source: "FILE_UPLOAD",
          video_size: fileSize,
          chunk_size: fileSize,
          total_chunk_count: 1,
        },
      }),
      { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json; charset=UTF-8" }
    );

    if (!init.data?.publish_id) {
      res.status(400).json({ error: `TikTok init error: ${init.error?.message ?? JSON.stringify(init)}` });
      return;
    }

    const { publish_id, upload_url } = init.data;

    // Step 2: Upload video
    await httpsUploadFile(upload_url, renderPath, "PUT", {
      "Content-Range": `bytes 0-${fileSize - 1}/${fileSize}`,
    });

    res.json({ publishId: publish_id, message: "TikTok draft created. Check Creator Studio." });
  } catch (err: any) {
    console.error("[TikTok]", err);
    res.status(500).json({ error: err.message ?? "TikTok upload failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Instagram Reels via Meta Graph API (URL-based container)
// Env: INSTAGRAM_ACCESS_TOKEN, INSTAGRAM_BUSINESS_ACCOUNT_ID
// Note: The rendered video must be served at a public URL.
//       We use the REPLIT_DEV_DOMAIN env var which Replit sets automatically.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/projects/:id/upload-to-instagram", async (req, res) => {
  const { id } = req.params;
  const { caption } = req.body as { caption?: string };

  const accessToken = process.env.INSTAGRAM_ACCESS_TOKEN;
  const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID;

  if (!accessToken || !accountId) {
    res.status(400).json({
      error:
        "Instagram not connected. Add INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_BUSINESS_ACCOUNT_ID to your Secrets. " +
        "These come from Meta Business Manager → Instagram Professional Account → Graph API access.",
    });
    return;
  }

  const devDomain = process.env.REPLIT_DEV_DOMAIN;
  if (!devDomain) {
    res.status(400).json({ error: "REPLIT_DEV_DOMAIN not set — cannot construct public video URL for Instagram." });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const renderPath = await requireRender(id, res);
  if (!renderPath) return;

  try {
    // Public video URL — our API serves the rendered file
    const videoUrl = `https://${devDomain}/api/projects/${id}/download-render`;
    const postCaption = caption ?? `${project.name ?? "CutAI Export"}\n\n#reels #video #ai`;

    // Step 1: Create container
    const container = await httpsPost(
      `https://graph.facebook.com/v18.0/${accountId}/media`,
      JSON.stringify({
        media_type: "REELS",
        video_url: videoUrl,
        caption: postCaption,
        share_to_feed: true,
        access_token: accessToken,
      }),
      { "Content-Type": "application/json" }
    );

    if (container.error || !container.id) {
      res.status(400).json({ error: `Instagram container failed: ${container.error?.message ?? JSON.stringify(container)}` });
      return;
    }

    // Step 2: Poll for container status (up to 60s)
    const containerId = container.id;
    let status = "IN_PROGRESS";
    for (let i = 0; i < 12 && status === "IN_PROGRESS"; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const check = await httpsGet(
        `https://graph.facebook.com/v18.0/${containerId}?fields=status_code&access_token=${accessToken}`,
      );
      status = check.status_code ?? "IN_PROGRESS";
    }

    if (status !== "FINISHED") {
      res.status(400).json({ error: `Instagram video not ready (status: ${status}). Try again in a minute.` });
      return;
    }

    // Step 3: Publish
    const publish = await httpsPost(
      `https://graph.facebook.com/v18.0/${accountId}/media_publish`,
      JSON.stringify({ creation_id: containerId, access_token: accessToken }),
      { "Content-Type": "application/json" }
    );

    if (publish.error) {
      res.status(400).json({ error: `Instagram publish failed: ${publish.error?.message ?? JSON.stringify(publish)}` });
      return;
    }

    res.json({ mediaId: publish.id, permalink: `https://www.instagram.com/`, message: "Instagram Reel published." });
  } catch (err: any) {
    console.error("[Instagram]", err);
    res.status(500).json({ error: err.message ?? "Instagram upload failed" });
  }
});

// Add a public download endpoint for renders (used by Instagram)
router.get("/projects/:id/download-render", (req, res) => {
  const { id } = req.params;
  const renderPath = path.join(RENDER_DIR, `${id}.mp4`);
  if (!fs.existsSync(renderPath)) {
    res.status(404).json({ error: "No render found" });
    return;
  }
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `inline; filename="${id}.mp4"`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  fs.createReadStream(renderPath).pipe(res as any);
});

// ─────────────────────────────────────────────────────────────────────────────
// LinkedIn Video UGC Post (UGC Posts API v2)
// Env: LINKEDIN_ACCESS_TOKEN, LINKEDIN_PERSON_URN  (e.g. "urn:li:person:XXXX")
// ─────────────────────────────────────────────────────────────────────────────
router.post("/projects/:id/upload-to-linkedin", async (req, res) => {
  const { id } = req.params;
  const { text } = req.body as { text?: string };

  const accessToken = process.env.LINKEDIN_ACCESS_TOKEN;
  const personUrn = process.env.LINKEDIN_PERSON_URN;

  if (!accessToken || !personUrn) {
    res.status(400).json({
      error:
        "LinkedIn not connected. Add LINKEDIN_ACCESS_TOKEN and LINKEDIN_PERSON_URN to your Secrets. " +
        "Get these from the LinkedIn Developer Portal → OAuth 2.0 → w_member_social scope.",
    });
    return;
  }

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
  if (!project) { res.status(404).json({ error: "Project not found" }); return; }
  const renderPath = await requireRender(id, res);
  if (!renderPath) return;

  try {
    const fileSize = fs.statSync(renderPath).size;
    const postText = text ?? `${project.name ?? "CutAI Export"}\n\n#video #content #ai`;

    // Step 1: Register upload
    const register = await httpsPost(
      "https://api.linkedin.com/v2/assets?action=registerUpload",
      JSON.stringify({
        registerUploadRequest: {
          recipes: ["urn:li:digitalmediaRecipe:feedshare-video"],
          owner: personUrn,
          serviceRelationships: [
            { relationshipType: "OWNER", identifier: "urn:li:userGeneratedContent" },
          ],
        },
      }),
      {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      }
    );

    const uploadMechanism = register.value?.uploadMechanism;
    if (!uploadMechanism) {
      res.status(400).json({ error: `LinkedIn register failed: ${register.message ?? JSON.stringify(register)}` });
      return;
    }

    const uploadUrl: string =
      uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"]?.uploadUrl;
    const assetUrn: string = register.value.asset;

    // Step 2: Upload video
    const uploadResult = await httpsUploadFile(uploadUrl, renderPath, "POST", {
      Authorization: `Bearer ${accessToken}`,
    });

    if (uploadResult.status && uploadResult.status >= 400) {
      res.status(400).json({ error: `LinkedIn video upload failed (HTTP ${uploadResult.status}): ${uploadResult.body}` });
      return;
    }

    // Step 3: Create UGC post
    const post = await httpsPost(
      "https://api.linkedin.com/v2/ugcPosts",
      JSON.stringify({
        author: personUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: postText },
            shareMediaCategory: "VIDEO",
            media: [
              {
                status: "READY",
                description: { text: project.description ?? "Edited with CutAI" },
                media: assetUrn,
                title: { text: project.name ?? "CutAI Export" },
              },
            ],
          },
        },
        visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
      }),
      {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      }
    );

    if (post.message || post.errorDetails) {
      res.status(400).json({ error: `LinkedIn post failed: ${post.message ?? JSON.stringify(post)}` });
      return;
    }

    const urn = post.id ?? "";
    res.json({
      urn,
      postUrl: `https://www.linkedin.com/feed/update/${encodeURIComponent(urn)}`,
      message: "LinkedIn video post published.",
    });
  } catch (err: any) {
    console.error("[LinkedIn]", err);
    res.status(500).json({ error: err.message ?? "LinkedIn upload failed" });
  }
});

export default router;
