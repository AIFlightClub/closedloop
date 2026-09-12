/**
 * HTTP surface for the loop, mounted at /loop inside the main server.
 *
 *   GET  /loop                          every meeting with its loop stage
 *   GET  /loop/:id                      status: stage, files, urls, live polls
 *   GET  /loop/:id/notes.md | loop.json | transcript.txt | poll_round.json | summary.md | survey-request.json | events
 *   POST /loop/:id/run    {from?}       all | notes | survey (new round) | enrich   → 202, runs in the background
 *   POST /loop/:id/close                close the survey + open polls now (the loop then finishes on its own)
 *   POST /loop/:id/live   {speaker,text} feed one transcript line to the live detector
 *   POST /loop/demo       {transcript, meeting_id?, live?, speed_ms?}  run the loop from a transcript file
 */
import { readFileSync } from "node:fs";
import express from "express";
import { records } from "../meeting-records.js";

const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((body) => {
      if (!res.headersSent) res.json(body);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      res.status(/unknown meeting|not found/i.test(message) ? 404 : /already running|already exists/i.test(message) ? 409 : 500).json({ error: message });
    });
};

export function createRouter({ runner, notifier, live, log = () => {} }) {
  const router = express.Router();
  router.use(express.json({ limit: "2mb" }));
  const file = (id, kind) => {
    const path = runner.files(id)[kind];
    if (!path) throw new Error(`${kind} not found for ${id}`);
    return readFileSync(path, "utf8");
  };
  const background = (id, promise) => {
    promise.catch((error) => log(`${id}: ${error instanceof Error ? error.message : String(error)}`));
  };

  router.get("/health", (_req, res) => res.json({ ok: true, callback: notifier?.url ?? null }));

  router.get("/", wrap(async () => {
    const all = records();
    return Object.keys(all)
      .sort((a, b) => String(all[b].startedAt ?? "").localeCompare(String(all[a].startedAt ?? "")))
      .map((id) => ({ meeting_id: id, status: all[id].status, stage: all[id].loop?.stage ?? null, started_at: all[id].startedAt ?? null, demo: !!all[id].demo }));
  }));

  router.post("/demo", wrap(async (req, res) => {
    const { transcript, meeting_id, live: replay = false, speed_ms = 0 } = req.body ?? {};
    if (!transcript) throw new Error("transcript (path to an RTMS transcript file) is required");
    const id = meeting_id ?? `demo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    if (records()[id]) throw new Error(`meeting ${id} already exists`);
    background(id, runner.demo({ transcriptPath: transcript, meetingId: id, live: !!replay, speedMs: Number(speed_ms) || 0 }));
    res.status(202);
    return { meeting_id: id, status_url: runner.urls(id).status, live: !!replay };
  }));

  router.get("/:id", wrap(async (req) => {
    const id = String(req.params.id);
    const detector = live?.get(id);
    return { ...runner.status(id), live: detector ? detector.state() : null };
  }));

  router.get("/:id/notes.md", wrap(async (req, res) => { res.type("text/markdown").send(file(String(req.params.id), "notes")); }));
  router.get("/:id/summary.md", wrap(async (req, res) => { res.type("text/markdown").send(file(String(req.params.id), "summary")); }));
  router.get("/:id/transcript.txt", wrap(async (req, res) => { res.type("text/plain").send(file(String(req.params.id), "transcript")); }));
  router.get("/:id/loop.json", wrap(async (req) => JSON.parse(file(String(req.params.id), "loop_state"))));
  router.get("/:id/poll_round.json", wrap(async (req) => JSON.parse(file(String(req.params.id), "poll_round"))));
  router.get("/:id/survey-request.json", wrap(async (req) => JSON.parse(file(String(req.params.id), "survey_request"))));
  router.get("/:id/events", wrap(async (req) => notifier?.events(String(req.params.id)) ?? []));

  router.post("/:id/run", wrap(async (req, res) => {
    const id = String(req.params.id);
    const from = req.body?.from ?? "all";
    if (!["all", "notes", "survey", "enrich"].includes(from)) throw new Error(`from must be all | notes | survey | enrich (got ${from})`);
    if (!records()[id]) throw new Error(`Unknown meeting: ${id}`);
    if (runner.active.has(id)) throw new Error(`${id}: the loop is already running`);
    background(id, runner.run(id, { from }));
    res.status(202);
    return { meeting_id: id, from, status_url: runner.urls(id).status };
  }));

  router.post("/:id/close", wrap(async (req) => ({ meeting_id: String(req.params.id), closed: await runner.closeNow(String(req.params.id)) })));

  router.post("/:id/live", wrap(async (req) => {
    const id = String(req.params.id);
    const { speaker = "Unknown speaker", text, ts = null } = req.body ?? {};
    if (!text) throw new Error("text is required");
    if (!live) throw new Error("live detection is disabled");
    const detector = live.get(id) ?? live.start(id);
    const trigger = detector.push({ speaker, text, ts });
    return { meeting_id: id, trigger, live: detector.state() };
  }));

  return router;
}
