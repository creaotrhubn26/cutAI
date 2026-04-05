import { Router } from "express";
import { google } from "googleapis";
import { getCallbackUrl } from "../lib/google";

const router = Router();

const SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/youtube.upload",
];

const WORKSPACE_SCOPES = [
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube",
];

function buildAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getCallbackUrl(),
  );
}

/** GET /api/auth/google — redirect user to Google consent screen */
router.get("/auth/google", (_req, res) => {
  const auth = buildAuthClient();
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
  res.redirect(url);
});

/**
 * GET /api/auth/google/workspace
 * One-time flow to authorise Drive + YouTube with your registered OAuth app.
 * Visit this URL in your browser, sign in, and the refresh token will be stored
 * in the session and printed in the server logs so you can save it as
 * GOOGLE_WORKSPACE_REFRESH_TOKEN.
 */
router.get("/auth/google/workspace", (_req, res) => {
  const domain = process.env.REPLIT_DEV_DOMAIN;
  const callbackUrl = domain
    ? `https://${domain}/api/auth/google/workspace/callback`
    : `http://localhost:8080/api/auth/google/workspace/callback`;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    clientSecret,
    callbackUrl,
  );
  const url = auth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: WORKSPACE_SCOPES,
  });
  res.redirect(url);
});

router.get("/auth/google/workspace/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  const errorParam = req.query.error as string | undefined;
  if (!code) {
    const msg = errorParam
      ? `Google returned error: <strong>${errorParam}</strong> — ${req.query.error_description ?? ""}`
      : "No code returned. Make sure the redirect URI is registered in Google Cloud Console.";
    res.status(400).send(`<html><body style="font-family:monospace;background:#111;color:#f55;padding:2rem"><h2>Auth Error</h2><p>${msg}</p><p style="color:#aaa;margin-top:1rem">Redirect URI that must be registered:<br><code style="color:#0f0">https://${process.env.REPLIT_DEV_DOMAIN}/api/auth/google/workspace/callback</code></p></body></html>`);
    return;
  }
  const domain = process.env.REPLIT_DEV_DOMAIN;
  const callbackUrl = domain
    ? `https://${domain}/api/auth/google/workspace/callback`
    : `http://localhost:8080/api/auth/google/workspace/callback`;
  const clientSecret = process.env.GOOGLE_DRIVE_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET;
  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      clientSecret,
      callbackUrl,
    );
    const { tokens } = await auth.getToken(code);
    const rt = tokens.refresh_token;
    console.log("=================================================");
    console.log("WORKSPACE REFRESH TOKEN (save as GOOGLE_WORKSPACE_REFRESH_TOKEN):");
    console.log(rt ?? "(no refresh_token returned — try again with prompt=consent)");
    console.log("=================================================");
    // Store in session so Drive API works immediately for this session
    const session = (req as any).session;
    if (!session.workspace) session.workspace = {};
    session.workspace.refreshToken = rt;
    session.workspace.accessToken = tokens.access_token;
    res.send(`
      <html><body style="font-family:monospace;background:#111;color:#0f0;padding:2rem">
        <h2 style="color:#fff">✅ Drive authorised!</h2>
        <p>Refresh token:</p>
        <pre style="background:#222;padding:1rem;word-break:break-all">${rt ?? "none — consent already granted earlier"}</pre>
        <p style="color:#aaa">Copy this value and save it as the <strong>GOOGLE_WORKSPACE_REFRESH_TOKEN</strong> secret, then reload the app.</p>
        <br><a href="/" style="color:#4af">← Back to CutAI</a>
      </body></html>
    `);
  } catch (err: any) {
    console.error("Workspace auth callback error:", err);
    res.status(500).send(`Auth error: ${err.message}`);
  }
});

/** GET /api/auth/google/callback — exchange code for tokens, store in session */
router.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code as string | undefined;
  if (!code) {
    res.status(400).json({ error: "Missing code" });
    return;
  }
  try {
    const auth = buildAuthClient();
    const { tokens } = await auth.getToken(code);
    auth.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: "v2", auth });
    const { data: profile } = await oauth2.userinfo.get();

    const session = (req as any).session;
    session.user = {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      picture: profile.picture,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? session.user?.refreshToken,
    };

    const base = process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "";
    res.redirect(`${base}/`);
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    res.status(500).json({ error: "Authentication failed" });
  }
});

/** GET /api/auth/me — return current session user */
router.get("/auth/me", (req, res) => {
  const session = (req as any).session;
  if (!session?.user) {
    res.json({ user: null });
    return;
  }
  const { id, email, name, picture } = session.user;
  res.json({ user: { id, email, name, picture } });
});

/** POST /api/auth/logout — clear session */
router.post("/auth/logout", (req, res) => {
  (req as any).session.destroy(() => {
    res.json({ ok: true });
  });
});

export default router;
