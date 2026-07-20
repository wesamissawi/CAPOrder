// src/scrapers/gmail.auth.js
// Gmail OAuth2 helpers for the Transbec invoice pipeline.
//
// Auth model (mirrors how the other vendors store creds in windowConfig):
//   - GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET  -> from a Google Cloud "Desktop app"
//     OAuth client the user creates once, entered in Settings.
//   - GMAIL_REFRESH_TOKEN                     -> obtained the first time the user
//     clicks "Connect Gmail"; long-lived, used to mint access tokens on demand.
//
// Only the read-only Gmail scope is requested — we never send or modify mail.
const http = require("http");
const { google } = require("googleapis");

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// Desktop OAuth clients redirect to a loopback address. Port 0 lets the OS pick
// a free port so we never collide with something already listening.
function buildRedirectUri(port) {
  return `http://127.0.0.1:${port}`;
}

function createOAuth2Client(clientId, clientSecret, redirectUri) {
  if (!clientId || !clientSecret) {
    throw new Error("Missing Gmail OAuth client id/secret. Set them in Settings.");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// Build an authorized client from a stored refresh token. googleapis refreshes
// the short-lived access token itself as long as the refresh token is present.
function getAuthorizedClient({ clientId, clientSecret, refreshToken }) {
  if (!refreshToken) {
    throw new Error("Gmail is not connected. Click “Connect Gmail” in Settings.");
  }
  const client = createOAuth2Client(clientId, clientSecret, buildRedirectUri(80));
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

// A Gmail API service bound to an authorized client.
function getGmailService(authClient) {
  return google.gmail({ version: "v1", auth: authClient });
}

// Interactive one-time consent using the loopback redirect flow:
//   1. spin up a throwaway localhost server,
//   2. open Google's consent screen in the user's default browser,
//   3. capture the ?code=... redirect, exchange it for tokens,
//   4. resolve with the refresh token (which the caller persists to config).
// `openExternal` is injected (shell.openExternal) so this file stays UI-agnostic.
function runInteractiveAuth({ clientId, clientSecret, openExternal }, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {}
      clearTimeout(timer);
      fn(arg);
    };

    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, `http://127.0.0.1`);
        // Ignore favicon and any stray requests; only act on the redirect that
        // carries the auth code (or an error).
        const code = url.searchParams.get("code");
        const errParam = url.searchParams.get("error");
        if (!code && !errParam) {
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          errParam
            ? `<html><body style="font-family:sans-serif"><h2>Gmail connection failed</h2><p>${errParam}</p><p>You can close this tab and try again.</p></body></html>`
            : `<html><body style="font-family:sans-serif"><h2>Gmail connected ✓</h2><p>You can close this tab and return to CAPOrder.</p></body></html>`
        );

        if (errParam) {
          finish(reject, new Error(`Google returned an error: ${errParam}`));
          return;
        }

        const client = createOAuth2Client(clientId, clientSecret, redirectUri);
        const { tokens } = await client.getToken(code);
        if (!tokens?.refresh_token) {
          // Google only returns a refresh token when access_type=offline AND the
          // user is freshly consenting (prompt=consent forces this below).
          finish(
            reject,
            new Error(
              "Google did not return a refresh token. Remove CAPOrder from your Google account's third-party access and reconnect."
            )
          );
          return;
        }
        finish(resolve, {
          refreshToken: tokens.refresh_token,
          accessToken: tokens.access_token || "",
          scope: tokens.scope || GMAIL_SCOPES.join(" "),
        });
      } catch (e) {
        finish(reject, e);
      }
    });

    let redirectUri = "";
    server.on("error", (e) => finish(reject, e));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      redirectUri = buildRedirectUri(port);
      let authUrl;
      try {
        const client = createOAuth2Client(clientId, clientSecret, redirectUri);
        authUrl = client.generateAuthUrl({
          access_type: "offline",
          prompt: "consent", // force a refresh token even on re-consent
          scope: GMAIL_SCOPES,
        });
      } catch (e) {
        finish(reject, e);
        return;
      }
      Promise.resolve(openExternal?.(authUrl)).catch((e) => finish(reject, e));
    });

    const timer = setTimeout(
      () => finish(reject, new Error("Timed out waiting for Gmail authorization.")),
      timeoutMs
    );
  });
}

// Cheap connectivity check used by Settings to show connected/expired state
// without doing a full mail search.
async function verifyConnection({ clientId, clientSecret, refreshToken }) {
  const client = getAuthorizedClient({ clientId, clientSecret, refreshToken });
  const gmail = getGmailService(client);
  const profile = await gmail.users.getProfile({ userId: "me" });
  return { emailAddress: profile.data.emailAddress || "" };
}

module.exports = {
  GMAIL_SCOPES,
  createOAuth2Client,
  getAuthorizedClient,
  getGmailService,
  runInteractiveAuth,
  verifyConnection,
};
