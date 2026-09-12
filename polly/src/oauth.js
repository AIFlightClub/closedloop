/**
 * Polly MCP OAuth — a public PKCE client with a loopback redirect, the same
 * handshake any MCP host does, minus the UI. Run once (`npm run polly:auth`),
 * the token lands in .polly-mcp-token.json (gitignored) and refreshes itself.
 *
 * Discovery: RFC 9728 resource metadata on the MCP host → RFC 8414 metadata
 * on the authorization server (the Polly webapp). Falls back to the known
 * paths if discovery is unreachable.
 */
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
const DEFAULT_MCP_URL = "https://mcp.polly.ai/mcp";
const DEFAULT_WEBAPP_URL = "https://app.polly.ai";
export const DEFAULT_SCOPES = [
    "mcp:read",
    "mcp:write",
    "mcp:results:read",
    "offline_access",
];
export function mcpUrl() {
    return (process.env.POLLY_MCP_URL || DEFAULT_MCP_URL).replace(/\/$/, "");
}
export function tokenPath() {
    return process.env.POLLY_TOKEN_PATH || ".polly-mcp-token.json";
}
function serverBase() {
    return new URL(mcpUrl()).origin;
}
function webappBase() {
    return (process.env.POLLY_WEBAPP_URL || DEFAULT_WEBAPP_URL).replace(/\/$/, "");
}
async function fetchJson(url, init) {
    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try {
        body = JSON.parse(text);
    }
    catch {
        body = { raw: text };
    }
    if (!res.ok) {
        throw new Error(`${init?.method ?? "GET"} ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return body;
}
const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export async function discoverAuthServer() {
    const fallback = {
        issuer: webappBase(),
        authorization_endpoint: `${webappBase()}/mcp-authorize`,
        token_endpoint: `${serverBase()}/mcp-token`,
        registration_endpoint: `${serverBase()}/mcp-register`,
    };
    try {
        const resourceMeta = await fetchJson(`${serverBase()}/.well-known/oauth-protected-resource`);
        const authServer = resourceMeta.authorization_servers?.[0];
        if (!authServer)
            return fallback;
        const meta = await fetchJson(`${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`);
        if (typeof meta.authorization_endpoint === "string" &&
            typeof meta.token_endpoint === "string") {
            return meta;
        }
        return fallback;
    }
    catch {
        return fallback;
    }
}
/** RFC 7591 dynamic registration of a public (PKCE-only) client. */
export async function registerPublicClient(meta, redirectUri) {
    if (!meta.registration_endpoint) {
        throw new Error("auth server advertises no registration endpoint — set POLLY_OAUTH_CLIENT_ID");
    }
    const reg = await fetchJson(meta.registration_endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            client_name: "ClosedLoop (AI Tinkerers hackathon)",
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
        }),
    });
    if (typeof reg.client_id !== "string") {
        throw new Error(`registration returned no client_id: ${JSON.stringify(reg)}`);
    }
    return reg.client_id;
}
function toStored(token, clientId, tokenEndpoint, resource) {
    if (typeof token.access_token !== "string") {
        throw new Error(`token endpoint returned no access_token: ${JSON.stringify(token)}`);
    }
    const expiresIn = typeof token.expires_in === "number" ? token.expires_in : 43_200;
    return {
        access_token: token.access_token,
        refresh_token: typeof token.refresh_token === "string" ? token.refresh_token : undefined,
        expires_at: Date.now() + expiresIn * 1000,
        scope: typeof token.scope === "string" ? token.scope : undefined,
        client_id: clientId,
        token_endpoint: tokenEndpoint,
        resource,
        obtained_at: new Date().toISOString(),
    };
}
export function saveToken(token) {
    writeFileSync(tokenPath(), JSON.stringify(token, null, 2), { mode: 0o600 });
}
export function readStoredToken() {
    if (!existsSync(tokenPath()))
        return undefined;
    return JSON.parse(readFileSync(tokenPath(), "utf8"));
}
function openInBrowser(url) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
        spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
    }
    catch {
        /* the URL is printed anyway */
    }
}
/**
 * Full interactive flow: loopback listener → DCR → browser consent → code
 * exchange → token file. The person running it signs in to Polly and clicks
 * Allow; nothing here ever sees their password.
 */
export async function authorizeInteractive(opts = {}) {
    const log = opts.log ?? ((line) => console.log(line));
    const meta = await discoverAuthServer();
    log(`auth server: ${meta.authorization_endpoint}`);
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    try {
        const clientId = process.env.POLLY_OAUTH_CLIENT_ID || (await registerPublicClient(meta, redirectUri));
        const verifier = b64url(randomBytes(32));
        const challenge = b64url(createHash("sha256").update(verifier).digest());
        const state = b64url(randomBytes(16));
        const resource = mcpUrl();
        const authUrl = new URL(meta.authorization_endpoint);
        authUrl.search = new URLSearchParams({
            response_type: "code",
            client_id: clientId,
            redirect_uri: redirectUri,
            scope: (opts.scopes ?? DEFAULT_SCOPES).join(" "),
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
            resource,
        }).toString();
        const code = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("timed out waiting for the browser callback")), opts.timeoutMs ?? 5 * 60_000);
            server.on("request", (req, res) => {
                const url = new URL(req.url ?? "/", redirectUri);
                if (url.pathname !== "/callback") {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                const error = url.searchParams.get("error");
                const gotCode = url.searchParams.get("code");
                const gotState = url.searchParams.get("state");
                const ok = !error && !!gotCode && gotState === state;
                res.setHeader("content-type", "text/html; charset=utf-8");
                res.end(ok
                    ? "<h2>ClosedLoop is connected to Polly ✅</h2><p>You can close this tab.</p>"
                    : `<h2>Authorization failed</h2><pre>${error ?? "missing code / state mismatch"}</pre>`);
                clearTimeout(timer);
                if (ok)
                    resolve(gotCode);
                else
                    reject(new Error(error ?? "missing code or state mismatch"));
            });
        });
        log(`\nOpen this URL to connect ClosedLoop to Polly (sign in, click Allow):\n\n  ${authUrl.toString()}\n`);
        if (opts.openBrowser ?? true)
            openInBrowser(authUrl.toString());
        const receivedCode = await code;
        const token = await fetchJson(meta.token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "authorization_code",
                code: receivedCode,
                redirect_uri: redirectUri,
                client_id: clientId,
                code_verifier: verifier,
                resource,
            }).toString(),
        });
        const stored = toStored(token, clientId, meta.token_endpoint, resource);
        saveToken(stored);
        log(`token saved to ${tokenPath()} (expires ${new Date(stored.expires_at).toISOString()})`);
        return stored;
    }
    finally {
        server.close();
    }
}
export async function refreshStoredToken(stored) {
    if (!stored.refresh_token) {
        throw new Error("no refresh token stored — run `npm run polly:auth` again");
    }
    const token = await fetchJson(stored.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: stored.refresh_token,
            client_id: stored.client_id,
            resource: stored.resource,
        }).toString(),
    });
    const next = toStored(token, stored.client_id, stored.token_endpoint, stored.resource);
    saveToken(next);
    return next;
}
/** Access token for the MCP transport: env override, else the token file (refreshed when stale). */
export async function loadPollyAccessToken() {
    const override = process.env.POLLY_MCP_TOKEN;
    if (override)
        return override;
    let stored = readStoredToken();
    if (!stored) {
        throw new Error(`No Polly MCP token at ${tokenPath()} — run: npm run polly:auth`);
    }
    if (Date.now() > stored.expires_at - 60_000) {
        stored = await refreshStoredToken(stored);
    }
    return stored.access_token;
}
