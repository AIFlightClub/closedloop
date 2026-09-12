/**
 * ClosedLoop loop module — public entry point.
 *
 *   import { createLoop } from "./loop/index.js";
 *   const loop = createLoop({ polly, port });
 *   app.use("/loop", loop.router);
 *   // on meeting.rtms_started:  const live = loop.live.start(streamId); live.push({ speaker, text })
 *   // on meeting.rtms_stopped:  loop.live.stop(streamId); await generateNotes(streamId); await loop.afterNotes(streamId)
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readJson, records, root } from "../meeting-records.js";
import { createNotifier } from "./callback.js";
import { codexExtractor, createLiveDetector, heuristicExtractor } from "./live.js";
import { createRouter } from "./router.js";
import { createLoopRunner } from "./run.js";
import { pollyMeetingKey } from "./survey-builder.js";

const num = (value, fallback) => (value === undefined || value === "" || Number.isNaN(Number(value)) ? fallback : Number(value));
const bool = (value, fallback) => (value === undefined || value === "" ? fallback : !/^(false|0|no|off)$/i.test(String(value)));

export function createLoop({ polly, log, port, env = process.env } = {}) {
  if (!polly) throw new Error("createLoop needs the Polly module (createPolly())");
  const logLine = log ?? ((line) => console.log(`[loop] ${line}`));
  const baseUrl = String(env.PUBLIC_BASE_URL || `http://localhost:${port ?? env.ZM_RTMS_PORT ?? 8080}`).replace(/\/$/, "");
  const channel = env.POLLY_CHANNEL || "#closed-loop-project";
  const notifier = createNotifier({ url: env.LOOP_CALLBACK_URL || undefined, secret: env.LOOP_CALLBACK_SECRET || undefined, log: logLine });
  const runner = createLoopRunner({
    polly,
    notifier,
    log: logLine,
    baseUrl,
    channel,
    options: {
      surveyBuilder: env.LOOP_SURVEY_BUILDER === "codex" ? "codex" : "local",
      closeAt: env.LOOP_SURVEY_CLOSE_AT || "+30m",
      minVotes: num(env.LOOP_SURVEY_MIN_VOTES, 1),
      settleSeconds: num(env.LOOP_SURVEY_SETTLE_SECONDS, 90),
      timeoutMinutes: env.LOOP_SURVEY_TIMEOUT_MINUTES ? num(env.LOOP_SURVEY_TIMEOUT_MINUTES, undefined) : undefined,
      surveyEnabled: bool(env.LOOP_SURVEY_ENABLED, true),
      enrichEnabled: bool(env.LOOP_ENRICH_ENABLED, true),
    },
  });

  const liveEnabled = bool(env.LOOP_LIVE_ENABLED, true);
  const detectors = new Map();
  const configFor = (id) => {
    const record = records()[id];
    if (record?.contextPath && existsSync(record.contextPath)) return readJson(record.contextPath).config;
    return readJson(resolve(root, "meeting-config.json"));
  };
  const live = {
    enabled: liveEnabled,
    get: (id) => detectors.get(id),
    start(id) {
      const existing = detectors.get(id);
      if (existing) return existing;
      const cfg = configFor(id);
      const roster = cfg.required_attendees ?? [];
      const extract = env.LOOP_LIVE_EXTRACTOR === "heuristic" ? heuristicExtractor() : codexExtractor({ title: cfg.title, roster, log: logLine });
      const detector = createLiveDetector({
        meetingId: id,
        pollyMeetingId: pollyMeetingKey(id),
        channel,
        title: cfg.title,
        polly,
        extract,
        notify: (event, payload) => notifier.notify(event, payload),
        log: logLine,
        payload: (extra) => ({ ...runner.payload(id), ...extra }),
        options: {
          enabled: liveEnabled,
          cooldownSeconds: num(env.LOOP_LIVE_COOLDOWN_SECONDS, 120),
          maxPolls: num(env.LOOP_LIVE_MAX_POLLS, 3),
          pollMinutes: num(env.LOOP_LIVE_POLL_MINUTES, 5),
          settleSeconds: num(env.LOOP_LIVE_SETTLE_SECONDS, 45),
          minVotes: num(env.LOOP_LIVE_MIN_VOTES, 1),
          heuristics: bool(env.LOOP_LIVE_HEURISTICS, true),
        },
      });
      detectors.set(id, detector);
      logLine(`${id}: live detection ${liveEnabled ? "on" : "off"} (${env.LOOP_LIVE_EXTRACTOR === "heuristic" ? "heuristic" : "codex"} extractor, ${channel})`);
      return detector;
    },
    stop(id) {
      const detector = detectors.get(id);
      if (!detector) return [];
      detectors.delete(id);
      return detector.stop();
    },
  };
  runner.liveFactory = (id) => live.start(id);

  return {
    router: createRouter({ runner, notifier, live, log: logLine }),
    runner,
    notifier,
    live,
    baseUrl,
    channel,
    run: (id, options) => runner.run(id, options),
    afterNotes: (id, options) => runner.afterNotes(id, options),
    demo: (options) => runner.demo(options),
    close: (id) => runner.closeNow(id),
    status: (id) => runner.status(id),
  };
}
