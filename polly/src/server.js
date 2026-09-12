/**
 * The module's HTTP surface + file inbox, mounted inside the main server.
 *
 *   POST /polls                        request JSON (survey / gaps / polls) → sends, watches in the background
 *   GET  /polls/:meeting_id            all records for the meeting
 *   GET  /polls/:meeting_id/poll_round.json   gap + ratification + ranking readback (enrich input)
 *   GET  /polls/:meeting_id/summary.md
 *   GET  /polls/:meeting_id/:id        one record (live counts while open)
 *   POST /polls/:meeting_id/:id/close  close now + finalize
 *
 * Inbox: drop the same JSON into polly/inbox/ — moved to done/ or failed/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import express from "express";
import { parsePollRequest } from "./request.js";
import { isPlanLimitError, isSurveyRequest, parseSurveyRequest, SurveyRunner, surveyToPolls } from "./survey.js";

const wrap = (fn) => (req, res) => {
  fn(req, res)
    .then((body) => {
      if (!res.headersSent) res.json(body);
    })
    .catch((err) => {
      const issues = err?.issues;
      res.status(issues ? 400 : 500).json({ error: err instanceof Error ? err.message : String(err), issues });
    });
};

/** Parse any accepted shape into { kind, request }. */
export function parseAnyRequest(raw, defaults) {
  return isSurveyRequest(raw)
    ? { kind: "survey", request: parseSurveyRequest(raw, defaults) }
    : { kind: "polls", request: parsePollRequest(raw, defaults) };
}

/** Send now, watch in the background, write the summary when everything closes. */
export async function accept(deps, raw) {
  const log = deps.log ?? ((line) => console.log(`[polly] ${line}`));
  const { kind, request } = parseAnyRequest(raw, { channel: deps.defaultChannel });
  const finish = (promise) =>
    promise
      .then(() => {
        const summary = deps.store.writeSummary(request.meeting_id);
        log(`${request.meeting_id}: closed — ${summary.round}`);
      })
      .catch((err) => log(`${request.meeting_id}: watch failed — ${err instanceof Error ? err.message : String(err)}`));

  const sendPolls = async (pollRequest, extra = []) => {
    const records = await deps.runner.send(pollRequest);
    const byId = new Map(pollRequest.polls.map((poll) => [poll.id, poll]));
    const open = records.filter((r) => r.status === "open");
    if (open.length) void finish(Promise.all(open.map((record) => deps.runner.watch(record, byId.get(record.id)))));
    return { kind: extra.length ? "survey_fallback" : kind, meeting_id: pollRequest.meeting_id, records: [...extra, ...records] };
  };

  if (kind === "survey") {
    const record = await deps.surveys.send(request);
    if (record.status === "open") {
      void finish(deps.surveys.watch(request, record));
      return { kind, meeting_id: request.meeting_id, records: [record] };
    }
    if (record.status === "failed" && isPlanLimitError(record.error) && request.fallback_to_polls) {
      log(`${request.meeting_id}: survey not available on this Polly plan — falling back to one poll per question`);
      return sendPolls(parsePollRequest(surveyToPolls(request), { channel: deps.defaultChannel }), [record]);
    }
    return { kind, meeting_id: request.meeting_id, records: [record] };
  }
  return sendPolls(request);
}

/** Express router for the module; mount it at /polls. */
export function createRouter(deps) {
  const router = express.Router();
  router.use(express.json({ limit: "1mb" }));

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.post(
    "/",
    wrap(async (req, res) => {
      const { kind, meeting_id, records } = await accept(deps, req.body);
      res.status(202);
      return {
        kind,
        meeting_id,
        channel: records[0]?.channel ?? deps.defaultChannel ?? null,
        records: records.map((r) => ({ id: r.id, status: r.status, polly: r.polly ?? null, error: r.error ?? null })),
      };
    }),
  );

  router.get("/:meeting", wrap(async (req) => deps.store.list(String(req.params.meeting))));

  // Before /:meeting/:id, which would otherwise capture these names.
  router.get(
    "/:meeting/poll_round.json",
    wrap(async (req) => JSON.parse(readFileSync(deps.store.writeSummary(String(req.params.meeting)).round, "utf8"))),
  );
  router.get(
    "/:meeting/summary.md",
    wrap(async (req, res) => {
      res.type("text/markdown").send(readFileSync(deps.store.writeSummary(String(req.params.meeting)).md, "utf8"));
      return undefined;
    }),
  );

  router.get(
    "/:meeting/:id",
    wrap(async (req) => {
      const record = deps.store.read(String(req.params.meeting), String(req.params.id));
      if (!record) throw new Error(`no poll ${String(req.params.id)} for ${String(req.params.meeting)}`);
      return record;
    }),
  );

  router.post(
    "/:meeting/:id/close",
    wrap(async (req) => {
      const meeting = String(req.params.meeting);
      const id = String(req.params.id);
      const record = deps.store.read(meeting, id);
      if (!record) throw new Error(`no poll ${id} for ${meeting}`);
      if (record.kind === "survey") {
        const request = req.body?.survey ? parseSurveyRequest(req.body, { channel: deps.defaultChannel }) : null;
        if (!request) throw new Error("closing a survey needs the original request JSON as the body (for the question_map)");
        return deps.surveys.close(request);
      }
      return deps.runner.close(meeting, id);
    }),
  );

  return router;
}

/** A standalone app (tests / dev): the router at /polls. */
export function createApp(deps) {
  const app = express();
  app.use("/polls", createRouter(deps));
  return app;
}

/**
 * Poll an inbox directory for new request files. A file is picked up once its
 * size has been stable for one tick, then moved to done/ or failed/.
 */
export function startInbox(deps, dir, everyMs = 2000) {
  const log = deps.log ?? ((line) => console.log(`[polly] ${line}`));
  mkdirSync(join(dir, "done"), { recursive: true });
  mkdirSync(join(dir, "failed"), { recursive: true });
  const sizes = new Map();
  const busy = new Set();

  const tick = async () => {
    let names;
    try {
      names = readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (busy.has(path)) continue;
      const size = statSync(path).size;
      if (sizes.get(path) !== size) {
        sizes.set(path, size);
        continue;
      }
      busy.add(path);
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      try {
        const raw = JSON.parse(readFileSync(path, "utf8"));
        const { kind, meeting_id, records } = await accept(deps, raw);
        log(`inbox: ${name} → ${kind} for ${meeting_id} (${records.map((r) => `${r.id}:${r.status}`).join(", ")})`);
        renameSync(path, join(dir, "done", `${stamp}-${name}`));
      } catch (err) {
        log(`inbox: ${name} rejected — ${err instanceof Error ? err.message : String(err)}`);
        if (existsSync(path)) renameSync(path, join(dir, "failed", `${stamp}-${name}`));
      } finally {
        busy.delete(path);
        sizes.delete(path);
      }
    }
  };

  const timer = setInterval(() => void tick(), everyMs);
  timer.unref?.();
  void tick();
  log(`inbox: watching ${dir}`);
  return () => clearInterval(timer);
}

export { SurveyRunner };
