import express, { type Request, type Response } from "express";
import crypto from "crypto";

const app = express();
const BASE = "https://closedloop.shares.zrok.io";
const { GITHUB_WEBHOOK_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } =
  process.env;
if (!GITHUB_WEBHOOK_SECRET || !ZOOM_WEBHOOK_SECRET_TOKEN || !ZOOM_CLIENT_ID || !ZOOM_CLIENT_SECRET)
  throw new Error(
    "GITHUB_WEBHOOK_SECRET, ZOOM_WEBHOOK_SECRET_TOKEN, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET must be set"
  );

app.use(express.raw({ type: "*/*" }));       // raw body — any content-type, needed for signatures

const hmac = (secret: string, data: string | Buffer) =>
  crypto.createHmac("sha256", secret).update(data).digest("hex");

const sigOk = (given: string, expected: string) =>
  given.length === expected.length &&
  crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));

// ponytail: `any` on payloads — type the events you actually branch on
const parse = (req: Request): any => JSON.parse(req.body.toString());

// x-zm-signature is v0=HMAC(`v0:<timestamp>:<raw body>`)
const zoomVerified = (req: Request) =>
  sigOk(
    req.get("x-zm-signature") || "",
    "v0=" + hmac(ZOOM_WEBHOOK_SECRET_TOKEN, `v0:${req.get("x-zm-request-timestamp")}:${req.body}`)
  );

app.get("/", (_req: Request, res: Response) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>closedloop</title>
<style>body{font:16px/1.6 system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem}code{background:#eee;padding:.1em .3em}</style>
<h1>closedloop</h1>
<p>Webhook receiver for <strong>closedloop</strong>. It listens for GitHub and Zoom events and closes the loop between them.</p>
<ul>
  <li><code>POST /webhooks/github</code> — GitHub events</li>
  <li><code>POST /webhooks/zoom</code> — Zoom events</li>
  <li><code>GET /zoom/oauth</code> — Zoom OAuth redirect</li>
  <li><code>POST /zoom/deauth</code> — Zoom deauthorization</li>
</ul>`);
});

app.post("/webhooks/github", (req: Request, res: Response) => {
  if (!sigOk(req.get("X-Hub-Signature-256") || "", "sha256=" + hmac(GITHUB_WEBHOOK_SECRET, req.body)))
    return res.sendStatus(401);

  res.sendStatus(200);                       // ack FIRST, then work
  console.log("github", req.get("X-GitHub-Event"), req.get("X-GitHub-Delivery"), parse(req));
});

// --- RTMS ------------------------------------------------------------------
// Zoom only streams media over WebSockets you open yourself. meeting.rtms_started
// hands you the signaling URL; that gets you the media URL; then media flows.

const streams = new Map<string, WebSocket[]>();

const rtmsSign = (uuid: string, sid: string) =>
  hmac(ZOOM_CLIENT_SECRET, `${ZOOM_CLIENT_ID},${uuid},${sid}`);

// msg_type 12 is a keep-alive — miss the 13 and the stream dies mid-meeting
const keepAlive = (ws: WebSocket, m: any) =>
  m.msg_type === 12 && ws.send(JSON.stringify({ msg_type: 13, timestamp: m.timestamp }));

function connectRtms(uuid: string, sid: string, signalingUrl: string) {
  const signaling = new WebSocket(signalingUrl);
  const sockets = [signaling];
  streams.set(uuid, sockets);

  signaling.onerror = (e) => console.error("rtms signaling error", e);
  signaling.onopen = () =>
    signaling.send(
      JSON.stringify({
        msg_type: 1,
        protocol_version: 1,
        meeting_uuid: uuid,
        rtms_stream_id: sid,
        sequence: Math.floor(Math.random() * 1e9),
        signature: rtmsSign(uuid, sid),
      })
    );

  signaling.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    keepAlive(signaling, m);
    if (m.msg_type !== 2) return;
    if (m.status_code !== 0) return console.error("rtms signaling handshake failed", m);

    const media = new WebSocket(m.media_server.server_urls.all);
    sockets.push(media);

    media.onerror = (err) => console.error("rtms media error", err);
    media.onopen = () =>
      media.send(
        JSON.stringify({
          msg_type: 3,
          protocol_version: 1,
          meeting_uuid: uuid,
          rtms_stream_id: sid,
          signature: rtmsSign(uuid, sid),
          media_type: 1 | 8,          // AUDIO | TRANSCRIPT — matches the granted scopes
          payload_encryption: false,
          media_params: {
            audio: { content_type: 1, sample_rate: 1, channel: 1, codec: 1, data_opt: 1, send_rate: 100 },
          },
        })
      );

    media.onmessage = (ev) => {
      const mm = JSON.parse(String(ev.data));
      keepAlive(media, mm);

      if (mm.msg_type === 4)
        return mm.status_code === 0
          ? signaling.send(JSON.stringify({ msg_type: 7, rtms_stream_id: sid })) // start streaming
          : console.error("rtms media handshake failed", mm);

      if (mm.msg_type === 17) console.log(`[${mm.content.user_name}] ${mm.content.data}`);
      // ponytail: audio frames (msg_type 14, base64 PCM) dropped — Zoom's own transcript is
      // enough until you need a different STT engine
    };
  };
}

function closeRtms(uuid: string) {
  streams.get(uuid)?.forEach((ws) => ws.close());
  streams.delete(uuid);
}

app.post("/webhooks/zoom", (req: Request, res: Response) => {
  if (!zoomVerified(req)) return res.sendStatus(401);

  const body = parse(req);
  if (body.event === "endpoint.url_validation") {
    const { plainToken } = body.payload;
    return res.json({ plainToken, encryptedToken: hmac(ZOOM_WEBHOOK_SECRET_TOKEN, plainToken) });
  }

  res.sendStatus(200);
  console.log("zoom", body.event, body.payload);

  // payload shape varies by event — some nest under .object
  const p = body.payload?.object ?? body.payload ?? {};
  if (body.event === "meeting.rtms_started")
    connectRtms(
      p.meeting_uuid,
      p.rtms_stream_id,
      typeof p.server_urls === "string" ? p.server_urls : p.server_urls[0]
    );
  if (body.event === "meeting.rtms_stopped") closeRtms(p.meeting_uuid);
});

app.post("/zoom/deauth", (req: Request, res: Response) => {
  if (!zoomVerified(req)) return res.sendStatus(401);

  res.sendStatus(200);
  console.log("zoom deauth", parse(req).payload);
  // ponytail: logged only — add data deletion here if you ever store Zoom user data
});

app.get("/zoom/oauth", async (req: Request, res: Response) => {
  const { code } = req.query;
  if (typeof code !== "string") return res.status(400).send("missing ?code");

  const r = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`).toString("base64") },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${BASE}/zoom/oauth`,
    }),
  });
  const token: any = await r.json();
  // ponytail: token logged, not stored — add storage when you actually call the Zoom API
  console.log("zoom oauth", r.status, r.ok ? token.scope : token);
  res.send(r.ok ? "closedloop connected. You can close this tab." : "OAuth failed — check server logs.");
});

app.listen(8080);
