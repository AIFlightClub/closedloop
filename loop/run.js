/**
 * The loop after the meeting: notes → survey (Polly) → results → enriched
 * notes, with a callback to the Slack lane after every stage. State lives in
 * data/meetings.json under `loop` so a stage can be re-run or resumed.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateNotes } from "../generate-notes.js";
import { readJson, records, root, saveJson, startRecord, updateRecord } from "../meeting-records.js";
import { enrichNotes, meetingDateOf, patchLoop, summarizePollRound } from "./enrich.js";
import { buildSurveyRequest, buildSurveyRequestWithCodex, pollyMeetingKey } from "./survey-builder.js";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const safeName = (id) => encodeURIComponent(String(id));

export const STAGES = ["recording", "notes", "survey_sending", "survey_open", "survey_skipped", "survey_failed", "results", "enriching", "enriched", "done", "failed"];

/** Parse one RTMS transcript line: `[ts] Speaker: text`. */
export function parseTranscriptLine(line) {
  const match = /^\[([^\]]*)\]\s*([^:]+?):\s*(.*)$/.exec(String(line ?? "").trim());
  if (!match) return null;
  return { ts: match[1], speaker: match[2].trim(), text: match[3].trim() };
}

export function createLoopRunner({ polly, notifier, log = () => {}, baseUrl = "", channel, options = {}, notes = generateNotes, enrich = enrichNotes, start = startRecord, liveFactory }) {
  const settings = {
    surveyBuilder: options.surveyBuilder ?? "local",
    closeAt: options.closeAt ?? "+30m",
    minVotes: options.minVotes ?? 1,
    settleSeconds: options.settleSeconds ?? 90,
    timeoutMinutes: options.timeoutMinutes,
    surveyEnabled: options.surveyEnabled ?? true,
    enrichEnabled: options.enrichEnabled ?? true,
  };
  const active = new Set();
  const notify = (event, payload) => (notifier ? notifier.notify(event, payload) : Promise.resolve({ delivered: false, skipped: true }));

  const loopDir = (id) => resolve(root, "data/loop", safeName(id));
  const key = (id) => records()[id]?.loop?.polly_meeting_id ?? pollyMeetingKey(id);
  const exists = (path) => (path && existsSync(path) ? path : null);

  function files(id) {
    const record = records()[id] ?? {};
    const resultsDir = polly.store.meetingDir(key(id));
    return {
      transcript: exists(record.transcriptPath),
      notes: exists(record.notesPath),
      loop_state: exists(record.loopStatePath),
      survey_request: exists(record.loop?.survey_request_path),
      poll_round: exists(join(resultsDir, "poll_round.json")),
      summary: exists(join(resultsDir, "summary.md")),
    };
  }

  function urls(id) {
    const base = `${baseUrl}/loop/${safeName(id)}`;
    return { status: base, notes: `${base}/notes.md`, loop_state: `${base}/loop.json`, transcript: `${base}/transcript.txt`, poll_round: `${base}/poll_round.json`, summary: `${base}/summary.md`, survey_request: `${base}/survey-request.json`, events: `${base}/events` };
  }

  function config(id) {
    const record = records()[id];
    if (!record?.contextPath || !existsSync(record.contextPath)) return readJson(resolve(root, "meeting-config.json"));
    return readJson(record.contextPath).config;
  }

  function status(id) {
    const record = records()[id];
    if (!record) throw new Error(`Unknown meeting: ${id}`);
    const cfg = config(id);
    return {
      meeting_id: id,
      series_id: record.seriesId ?? cfg.series_id ?? null,
      title: cfg.title ?? null,
      meeting_date: record.startedAt ? meetingDateOf(record, cfg) : null,
      status: record.status,
      error: record.error ?? null,
      stage: record.loop?.stage ?? (record.status === "complete" ? "notes" : record.status ?? "unknown"),
      loop: record.loop ?? {},
      started_at: record.startedAt ?? null,
      stopped_at: record.stoppedAt ?? null,
      files: files(id),
      urls: urls(id),
    };
  }

  function payload(id, extra = {}) {
    const base = status(id);
    return { meeting_id: id, series_id: base.series_id, title: base.title, meeting_date: base.meeting_date, stage: base.stage, files: base.files, urls: base.urls, ...extra };
  }

  const readText = (path) => (path && existsSync(path) ? readFileSync(path, "utf8") : null);
  const readJsonIf = (path) => (path && existsSync(path) ? readJson(path) : null);

  async function ensureNotes(id) {
    const record = records()[id];
    if (!record) throw new Error(`Unknown meeting: ${id}`);
    if (record.status !== "complete") {
      log(`${id}: generating notes…`);
      await notes(id);
    }
    const after = records()[id];
    if (after.status !== "complete") throw new Error(`notes not generated (${after.status}${after.error ? `: ${after.error}` : ""})`);
    if (!after.loop?.stage || after.loop.stage === "recording") patchLoop(id, { stage: "notes", notes_at: after.completedAt ?? new Date().toISOString() });
    return after;
  }

  async function stageNotesReady(id) {
    const record = records()[id];
    const loopState = readJsonIf(record.loopStatePath);
    const gaps = loopState?.gaps?.length ?? 0;
    await notify("notes.ready", payload(id, { notes_markdown: readText(record.notesPath), loop_state: loopState, gaps, summary: `notes ready (${gaps} gap${gaps === 1 ? "" : "s"})` }));
  }

  /** Every open poll of the meeting (live polls): wait for its watcher, or close it if nobody is watching. */
  async function settleOpenPolls(id) {
    const meetingKey = key(id);
    const open = polly.store.list(meetingKey).filter((r) => r.status === "open" || r.status === "sending");
    for (const record of open) {
      const inflight = polly.runner.watching?.get(`${meetingKey}/${record.id}`) ?? polly.surveys.watching?.get(`${meetingKey}/${record.id}`);
      if (inflight) {
        log(`${id}: waiting for ${record.id} to close…`);
        await inflight.catch(() => {});
      } else if (record.kind !== "survey") {
        log(`${id}: ${record.id} is open with nobody watching — closing it now`);
        await polly.runner.close(meetingKey, record.id).catch((error) => log(`${id}: could not close ${record.id} — ${error.message}`));
      }
    }
  }

  async function stageResults(id) {
    await settleOpenPolls(id);
    const summary = polly.summary(key(id));
    const pollRound = readJson(summary.round);
    const stats = summarizePollRound(pollRound);
    patchLoop(id, { stage: "results", results_at: new Date().toISOString(), poll_round_path: summary.round, summary_path: summary.md, results: stats });
    await notify("results.ready", payload(id, { poll_round: pollRound, summary_markdown: readText(summary.md), results: stats, summary: `results ready: ${stats.respondents} respondent${stats.respondents === 1 ? "" : "s"}, ${stats.filled}/${stats.gaps_asked} gaps filled` }));
    return { pollRound, summary };
  }

  async function stageSurvey(id, { newRound = false } = {}) {
    const record = records()[id];
    const cfg = config(id);
    const meetingDate = meetingDateOf(record, cfg);
    const previous = record.loop?.survey_round ?? 0;
    const round = newRound || !previous ? previous + 1 : previous;
    const meetingKey = pollyMeetingKey(id);
    const input = {
      meetingId: id,
      meetingDate,
      notes: readFileSync(record.notesPath, "utf8"),
      loopState: readJson(record.loopStatePath),
      config: cfg,
      channel,
      round,
      options: { closeAt: settings.closeAt, minVotes: settings.minVotes, settleSeconds: settings.settleSeconds, timeoutMinutes: settings.timeoutMinutes, notesUrl: baseUrl ? urls(id).notes : undefined },
    };
    const built = settings.surveyBuilder === "codex" ? await buildSurveyRequestWithCodex(input, { log }) : { ...buildSurveyRequest(input), builder: "local" };
    if (!built.request) {
      patchLoop(id, { stage: "survey_skipped", survey_round: round, polly_meeting_id: meetingKey, survey_reason: built.reason });
      log(`${id}: survey skipped — ${built.reason}`);
      await notify("survey.skipped", payload(id, { reason: built.reason, deferred_gaps: built.deferred, escalated_gaps: built.escalated, summary: `survey skipped: ${built.reason}` }));
      return null;
    }
    mkdirSync(loopDir(id), { recursive: true });
    const requestPath = join(loopDir(id), `survey-request.r${round}.json`);
    saveJson(requestPath, built.raw);
    patchLoop(id, { stage: "survey_sending", survey_round: round, polly_meeting_id: meetingKey, survey_request_path: requestPath, survey_builder: built.builder, survey_builder_error: built.builder_error ?? null, deferred_gaps: built.deferred, escalated_gaps: built.escalated, survey_counts: built.counts, error: null });
    log(`${id}: sending survey round ${round} (${built.counts.questions} questions, ${built.builder} builder) to ${channel}…`);

    const outcome = await polly.run(built.raw, {
      onSent: async (sentRecords) => {
        const open = sentRecords.filter((r) => r.status === "open");
        if (!open.length) {
          patchLoop(id, { stage: "survey_failed", error: sentRecords.map((r) => r.error).filter(Boolean).join("; ") || "not sent" });
          return;
        }
        const fallback = open[0].kind !== "survey";
        const survey = { fallback, channel, question_count: built.raw.survey.questions.length, pollys: open.map((r) => ({ record_id: r.id, id: r.polly?.id ?? null, type: r.polly?.type ?? null, results_url: r.polly?.results_url ?? null, web_voting_url: r.polly?.web_voting_url ?? null, close_at: r.polly?.close_at ?? null, sent_at: r.polly?.sent_at ?? null })) };
        patchLoop(id, { stage: "survey_open", survey, error: null });
        await notify("survey.sent", payload(id, { survey, question_map: built.raw.question_map, deferred_gaps: built.deferred, escalated_gaps: built.escalated, summary: `survey sent to ${channel}${fallback ? " (as separate polls)" : ""}` }));
      },
    });
    const sent = outcome.records ?? [outcome.record];
    if (!sent.some((r) => r.status === "closed")) {
      const error = sent.map((r) => r.error).filter(Boolean).join("; ") || "survey was not sent";
      patchLoop(id, { stage: "survey_failed", error });
      throw new Error(`survey failed: ${error}`);
    }
    return stageResults(id);
  }

  async function stageEnrich(id) {
    if (!settings.enrichEnabled) {
      log(`${id}: enrichment disabled (LOOP_ENRICH_ENABLED=false)`);
      return null;
    }
    const record = records()[id];
    const pollRoundPath = record.loop?.poll_round_path ?? join(polly.store.meetingDir(key(id)), "poll_round.json");
    const pollRound = readJsonIf(pollRoundPath);
    if (!pollRound) throw new Error("no poll_round.json to enrich from — run the survey stage first");
    patchLoop(id, { stage: "enriching" });
    const result = await enrich(id, { pollRound, summaryMarkdown: readText(record.loop?.summary_path), log });
    patchLoop(id, { stage: "enriched", enriched_round: records()[id].loop?.survey_round ?? null });
    await notify("notes.enriched", payload(id, { notes_markdown: result.notes, loop_state: result.loopState, enrichment: result.stats, version: result.version, previous_versions: records()[id].loop?.previous_versions ?? [], summary: `notes enriched: ${result.stats.filled}/${result.stats.gaps_asked} gaps filled from ${result.stats.respondents} respondent${result.stats.respondents === 1 ? "" : "s"}` }));
    return result;
  }

  async function guarded(id, work) {
    if (active.has(id)) throw new Error(`${id}: the loop is already running`);
    active.add(id);
    try {
      return await work();
    } catch (error) {
      patchLoop(id, { stage: "failed", error: error.message, failed_at: new Date().toISOString() });
      log(`${id}: loop failed — ${error.message}`);
      await notify("loop.failed", payload(id, { error: error.message, summary: `loop failed: ${error.message}` })).catch(() => {});
      throw error;
    } finally {
      active.delete(id);
    }
  }

  /** Called once notes exist: notes.ready → survey → results → enriched. */
  function afterNotes(id, { newRound = false, announceNotes = true } = {}) {
    return guarded(id, async () => {
      const record = records()[id];
      if (record?.status !== "complete") throw new Error(`notes for ${id} are not ready (${record?.status ?? "unknown"})`);
      if (announceNotes) await stageNotesReady(id);
      if (!settings.surveyEnabled) {
        patchLoop(id, { stage: "done", done_at: new Date().toISOString() });
        return status(id);
      }
      const results = await stageSurvey(id, { newRound });
      if (results) await stageEnrich(id);
      patchLoop(id, { stage: "done", done_at: new Date().toISOString() });
      return status(id);
    });
  }

  /**
   * @param {string} id
   * @param {{ from?: "all"|"notes"|"survey"|"enrich" }} [options]
   */
  async function run(id, { from = "all" } = {}) {
    if (!records()[id]) throw new Error(`Unknown meeting: ${id}`);
    if (from === "notes") {
      await ensureNotes(id);
      await guarded(id, () => stageNotesReady(id));
      return status(id);
    }
    if (from === "enrich") {
      await ensureNotes(id);
      await guarded(id, async () => {
        await stageEnrich(id);
        patchLoop(id, { stage: "done", done_at: new Date().toISOString() });
      });
      return status(id);
    }
    try {
      await ensureNotes(id);
    } catch (error) {
      patchLoop(id, { stage: "failed", error: error.message, failed_at: new Date().toISOString() });
      await notify("loop.failed", payload(id, { error: error.message, summary: `loop failed: ${error.message}` })).catch(() => {});
      throw error;
    }
    const stage = records()[id].loop?.stage;
    if (from === "all" && stage === "done") {
      log(`${id}: loop already complete — POST {"from":"survey"} for another round`);
      return status(id);
    }
    return afterNotes(id, { newRound: from === "survey", announceNotes: from !== "survey" });
  }

  /** Close the survey + every open poll now; the running watchers finish the loop. */
  async function closeNow(id) {
    const record = records()[id];
    if (!record) throw new Error(`Unknown meeting: ${id}`);
    const meetingKey = key(id);
    const closed = [];
    for (const item of polly.store.list(meetingKey).filter((r) => r.status === "open")) {
      if (item.kind === "survey") {
        const request = readJsonIf(record.loop?.survey_request_path);
        if (!request) throw new Error("survey request file missing — cannot close without its question_map");
        closed.push(await polly.surveys.close(polly.parse(request).request));
      } else {
        closed.push(await polly.runner.close(meetingKey, item.id));
      }
    }
    log(`${id}: closed ${closed.length} open poll${closed.length === 1 ? "" : "s"}`);
    return closed.map((r) => ({ id: r.id, status: r.status, votes: r.votes }));
  }

  /**
   * Run the whole loop from a transcript file without Zoom: registers a
   * meeting record, optionally replays the transcript through the live
   * detector, then generates notes and continues like a real stop event.
   */
  async function demo({ transcriptPath, meetingId, live = false, speedMs = 0, detector } = {}) {
    if (!transcriptPath) throw new Error("transcriptPath is required");
    const source = resolve(root, transcriptPath);
    if (!existsSync(source)) throw new Error(`transcript not found: ${source}`);
    const id = meetingId ?? `demo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`;
    if (records()[id]) throw new Error(`meeting ${id} already exists — pick another meeting_id`);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const transcriptsDir = resolve(root, "transcripts");
    mkdirSync(transcriptsDir, { recursive: true });
    const dest = join(transcriptsDir, `${stamp}-${String(id).replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`);
    copyFileSync(source, dest);
    await start(id, dest, null);
    updateRecord(id, { demo: { source }, loop: { stage: "recording", demo: true } });
    log(`${id}: demo meeting registered from ${transcriptPath}`);
    let livePolls = [];
    if (live) {
      const det = detector ?? liveFactory?.(id);
      if (!det) throw new Error("live replay needs a live detector");
      const parsed = readFileSync(source, "utf8").split("\n").map(parseTranscriptLine).filter(Boolean);
      log(`${id}: replaying ${parsed.length} transcript lines through the live detector${speedMs ? ` (${speedMs} ms/line)` : ""}…`);
      for (const line of parsed) {
        det.push(line);
        if (speedMs) await sleep(speedMs);
      }
      await det.idle();
      livePolls = det.stop();
    }
    updateRecord(id, { stoppedAt: new Date().toISOString(), status: "pending" });
    patchLoop(id, { stage: "notes_pending", live_polls: livePolls.map((p) => ({ id: p.id, question: p.question, status: p.status })) });
    await ensureNotes(id);
    return afterNotes(id);
  }

  return { settings, status, files, urls, payload, config, ensureNotes, afterNotes, run, closeNow, demo, settleOpenPolls, active, get liveFactory() { return liveFactory; }, set liveFactory(value) { liveFactory = value; } };
}
