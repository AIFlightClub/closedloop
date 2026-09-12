/**
 * Drive the loop from a terminal. Talks to the running server over HTTP
 * (LOOP_BASE_URL, default http://localhost:$ZM_RTMS_PORT or 8080).
 *
 *   npm run loop -- list
 *   npm run loop -- status <meeting_id>
 *   npm run loop -- run <meeting_id> [--from=all|notes|survey|enrich] [--wait]
 *   npm run loop -- close <meeting_id>
 *   npm run loop -- demo <transcript.txt> [--id=<meeting_id>] [--live] [--speed-ms=800] [--wait]
 *   npm run loop -- say <meeting_id> "<Speaker>: <text>"
 *   npm run loop -- replay <meeting_id> <transcript.txt> [--speed-ms=800]
 *   npm run loop -- events [meeting_id]
 */
import { readFileSync } from "node:fs";
import { parseTranscriptLine } from "./run.js";

const base = String(process.env.LOOP_BASE_URL || `http://localhost:${process.env.ZM_RTMS_PORT || 8080}`).replace(/\/$/, "");
const [command, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }));
const args = rest.filter((a) => !a.startsWith("--"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!response.ok) throw new Error(typeof data === "object" && data?.error ? data.error : `${response.status} ${text.slice(0, 200)}`);
  return data;
}

async function waitFor(id) {
  let last = "";
  for (;;) {
    const status = await api("GET", `/loop/${encodeURIComponent(id)}`);
    const line = `${status.stage}${status.loop?.error ? ` — ${status.loop.error}` : ""}`;
    if (line !== last) {
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${id}: ${line}`);
      if (status.stage === "survey_open") for (const p of status.loop.survey?.pollys ?? []) console.log(`  vote: ${p.web_voting_url ?? p.results_url ?? p.id}`);
      last = line;
    }
    if (["done", "failed", "survey_failed"].includes(status.stage)) return status;
    await sleep(5000);
  }
}

async function main() {
  switch (command) {
    case "list": return console.table(await api("GET", "/loop"));
    case "status": {
      const status = await api("GET", `/loop/${encodeURIComponent(args[0])}`);
      return console.log(JSON.stringify(status, null, 2));
    }
    case "run": {
      const id = args[0];
      console.log(JSON.stringify(await api("POST", `/loop/${encodeURIComponent(id)}/run`, { from: flags.from ?? "all" })));
      if (flags.wait) await waitFor(id);
      return;
    }
    case "close": return console.log(JSON.stringify(await api("POST", `/loop/${encodeURIComponent(args[0])}/close`), null, 2));
    case "demo": {
      const started = await api("POST", "/loop/demo", { transcript: args[0], meeting_id: flags.id, live: !!flags.live, speed_ms: Number(flags["speed-ms"] ?? 0) });
      console.log(JSON.stringify(started));
      if (flags.wait) await waitFor(started.meeting_id);
      return;
    }
    case "say": {
      const parsed = parseTranscriptLine(`[cli] ${args.slice(1).join(" ")}`) ?? { speaker: "Unknown speaker", text: args.slice(1).join(" ") };
      return console.log(JSON.stringify(await api("POST", `/loop/${encodeURIComponent(args[0])}/live`, parsed)));
    }
    case "replay": {
      const [id, path] = args;
      const speed = Number(flags["speed-ms"] ?? 800);
      for (const line of readFileSync(path, "utf8").split("\n").map(parseTranscriptLine).filter(Boolean)) {
        const result = await api("POST", `/loop/${encodeURIComponent(id)}/live`, line);
        console.log(`${line.speaker}: ${line.text}${result.trigger ? `   ← ${result.trigger}` : ""}`);
        await sleep(speed);
      }
      return;
    }
    case "events": return console.table(await api("GET", args[0] ? `/loop/${encodeURIComponent(args[0])}/events` : "/loop/events"));
    default:
      console.log("usage: loop <list|status|run|close|demo|say|replay|events> … (see loop/cli.js)");
      process.exitCode = 1;
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
