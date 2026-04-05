import { google } from "googleapis";

/**
 * Build an OAuth2 client for Workspace API calls (Drive, YouTube, etc.).
 *
 * The GOOGLE_WORKSPACE_REFRESH_TOKEN was issued by `gcloud auth application-default login`,
 * which uses Google's own internal gcloud OAuth app (client_id starting with 764086051850-...).
 * That token MUST be exchanged using the same client — not the user's registered app.
 *
 * Credential resolution for workspace auth:
 *   1. ADC_CLIENT_ID + ADC_CLIENT_SECRET  (new split secrets — preferred)
 *   2. ADC_JSON parsed (authorized_user type) — full JSON blob
 *   3. GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET — user's OAuth app (wrong client, kept as last resort)
 */
function getWorkspaceCredentials(): { clientId: string; clientSecret: string; refreshToken: string } {
  // Prefer GOOGLE_DRIVE_REFRESH_TOKEN (freshly generated) over GOOGLE_WORKSPACE_REFRESH_TOKEN
  const refreshToken =
    process.env.GOOGLE_DRIVE_REFRESH_TOKEN ??
    process.env.GOOGLE_WORKSPACE_REFRESH_TOKEN ??
    "";

  // Option 1: dedicated Drive secret (avoids conflicts with sign-in client)
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_DRIVE_CLIENT_SECRET) {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
      refreshToken,
    };
  }

  // Option 2: split ADC secrets
  if (process.env.ADC_CLIENT_ID && process.env.ADC_CLIENT_SECRET) {
    return {
      clientId: process.env.ADC_CLIENT_ID,
      clientSecret: process.env.ADC_CLIENT_SECRET,
      refreshToken,
    };
  }

  // Option 2: full ADC_JSON blob
  const raw = process.env.ADC_JSON;
  if (raw) {
    try {
      const adc = JSON.parse(raw);
      if (adc.type === "authorized_user" && adc.client_id && adc.client_secret) {
        return {
          clientId: adc.client_id,
          clientSecret: adc.client_secret,
          refreshToken: adc.refresh_token ?? refreshToken,
        };
      }
    } catch {}
  }

  // Option 3: fallback to registered app env vars (may fail if token was not issued to this app)
  const clientId = process.env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Drive auth: missing credentials. Set ADC_CLIENT_ID + ADC_CLIENT_SECRET, or " +
      "ADC_JSON (authorized_user), plus GOOGLE_WORKSPACE_REFRESH_TOKEN."
    );
  }
  return { clientId, clientSecret, refreshToken };
}

export function getWorkspaceOAuth2Client() {
  const { clientId, clientSecret, refreshToken } = getWorkspaceCredentials();
  const client = new google.auth.OAuth2(clientId, clientSecret, getCallbackUrl());
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * OAuth2 client for user-facing sign-in flows.
 * Uses the registered GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (your OAuth app).
 */
export function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return new google.auth.OAuth2(clientId, clientSecret, getCallbackUrl());
}

/** The redirect URI for Google Sign-In — prefers REPLIT_DEV_DOMAIN if set. */
export function getCallbackUrl() {
  const replitDomain = process.env.REPLIT_DEV_DOMAIN;
  if (replitDomain) {
    return `https://${replitDomain}/api/auth/google/callback`;
  }
  return process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/api/auth/google/callback";
}

/** Drive client pre-authorised with the workspace OAuth2 token. */
export function getDriveClient() {
  return google.drive({ version: "v3", auth: getWorkspaceOAuth2Client() });
}

/** YouTube Data API client pre-authorised with the workspace OAuth2 token. */
export function getYouTubeClient() {
  return google.youtube({ version: "v3", auth: getWorkspaceOAuth2Client() });
}
