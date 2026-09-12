/**
 * Dev receiver for loop callbacks (what the Slack lane implements for real):
 * prints every event, verifies the signature when LOOP_CALLBACK_SECRET is set,
 * and saves each body to data/callbacks/. `npm run loop:receiver`, then set
 * LOOP_CALLBACK_URL=http://localhost:8090/closedloop in .env.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { sign } from "./callback.js";

const port = Number(process.env.LOOP_RECEIVER_PORT || 8090);
const secret = process.env.LOOP_CALLBACK_SECRET || "";
const dir = resolve(process.cwd(), "data/callbacks");
mkdirSync(dir, { recursive: true });

const app = express();
app.use(express.text({ type: "*/*", limit: "10mb" }));
app.use((req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const body = typeof req.body === "string" ? req.body : "";
  if (secret && req.get("x-closedloop-signature") !== sign(secret, body)) {
    console.log(`✗ bad signature on ${req.get("x-closedloop-event")}`);
    return res.status(401).json({ error: "bad signature" });
  }
  let event;
  try { event = JSON.parse(body); } catch { return res.status(400).json({ error: "not json" }); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = resolve(dir, `${stamp}-${event.event ?? "unknown"}.json`);
  writeFileSync(file, `${JSON.stringify(event, null, 2)}\n`);
  const detail = event.summary ?? "";
  console.log(`✓ ${event.event}  meeting=${event.meeting_id}  ${detail}  → ${file}`);
  if (event.event === "survey.sent") for (const p of event.survey?.pollys ?? []) console.log(`   vote: ${p.web_voting_url ?? p.results_url ?? p.id}`);
  res.json({ ok: true });
});
app.listen(port, () => console.log(`Loop callback receiver on http://localhost:${port}/closedloop (${secret ? "signature required" : "no secret"})`));
