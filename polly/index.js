/**
 * ClosedLoop Polly module — public entry point.
 *
 *   import { createPolly } from "./polly/index.js";
 *   const polly = createPolly();
 *   app.use("/polls", polly.router);   // HTTP surface inside the main server
 *   polly.startInbox();                // file drop: polly/inbox/*.json
 *   await polly.run(requestJson);      // or call it directly from the handler
 *
 * Nothing connects to Polly until the first poll is sent, so the main server
 * boots fine before `npm run polly:auth` has been run.
 */
import { PollyMcp } from "./src/mcp.js";
import { parsePollRequest } from "./src/request.js";
import { ResultsStore } from "./src/results.js";
import { PollRunner } from "./src/runner.js";
import { accept, createRouter, parseAnyRequest, startInbox } from "./src/server.js";
import { posterFromEnv } from "./src/slack.js";
import { isPlanLimitError, parseSurveyRequest, SurveyRunner, surveyToPolls } from "./src/survey.js";

/** Connects on first use; one client per process. */
function lazyMcp() {
  let client;
  const get = () => (client ??= PollyMcp.fromEnv());
  return {
    createPoll: (input) => get().then((m) => m.createPoll(input)),
    createSurvey: (input) => get().then((m) => m.createSurvey(input)),
    getResults: (id, type) => get().then((m) => m.getResults(id, type)),
    getAllResults: (id, type) => get().then((m) => m.getAllResults(id, type)),
    closePoll: (id, type) => get().then((m) => m.closePoll(id, type)),
    listTools: () => get().then((m) => m.listTools()),
    disconnect: async () => {
      if (!client) return;
      const c = client;
      client = undefined;
      await (await c).disconnect();
    },
  };
}

export function createPolly(options = {}) {
  const env = process.env;
  const log = options.log ?? ((line) => console.log(`[polly] ${line}`));
  const defaultChannel = options.channel ?? env.POLLY_CHANNEL ?? undefined;
  const store = new ResultsStore(options.resultsDir ?? env.POLLY_RESULTS_DIR ?? "polly/results");
  const mcp = options.mcp ?? lazyMcp();
  const pollEveryMs = options.pollEveryMs ?? Number(env.POLLY_POLL_EVERY_MS || 5000);
  const runner = new PollRunner({ mcp, store, poster: options.poster ?? posterFromEnv(), pollEveryMs, log });
  const surveys = new SurveyRunner({ mcp, store, pollEveryMs, log });
  const deps = { runner, surveys, store, defaultChannel, log };
  const defaults = { channel: defaultChannel };

  return {
    store,
    runner,
    surveys,
    mcp,
    router: createRouter(deps),
    /** Send and return immediately; watching continues in the background. */
    accept: (raw) => accept(deps, raw),
    /** Send, watch until closed, write poll_round.json + summary.md. hooks.onSent(records) fires right after sending. */
    run: async (raw, hooks = {}) => {
      const { kind, request } = parseAnyRequest(raw, defaults);
      if (kind !== "survey") return runner.run(request, hooks);
      const outcome = await surveys.run(request, hooks);
      if (outcome.record.status === "failed" && isPlanLimitError(outcome.record.error) && request.fallback_to_polls) {
        log(`${request.meeting_id}: survey not available on this Polly plan — falling back to one poll per question`);
        const fallback = await runner.run(parsePollRequest(surveyToPolls(request), defaults), hooks);
        return { ...fallback, record: outcome.record, fallback: true };
      }
      return outcome;
    },
    /** Resume watching after a restart. */
    resume: (raw) => {
      const { kind, request } = parseAnyRequest(raw, defaults);
      return kind === "survey" ? surveys.resume(request) : runner.resume(request);
    },
    parse: (raw) => parseAnyRequest(raw, defaults),
    results: (meetingId) => store.list(meetingId),
    summary: (meetingId) => store.writeSummary(meetingId),
    startInbox: (dir, everyMs) => startInbox(deps, dir ?? env.POLLY_INBOX_DIR ?? "polly/inbox", everyMs),
  };
}

export { parsePollRequest, parseSurveyRequest, PollyMcp, ResultsStore };
