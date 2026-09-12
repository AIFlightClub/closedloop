import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// meeting-records.js keys everything off process.cwd(): move into a scratch
// repo before importing anything that touches data/ or notes/.
const repo = fileURLToPath(new URL("../..", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "loop-run-"));
cpSync(resolve(repo, "demo"), join(scratch, "demo"), { recursive: true });
cpSync(resolve(repo, "skills"), join(scratch, "skills"), { recursive: true });
writeFileSync(join(scratch, "meeting-config.json"), JSON.stringify({ series_id: "CL", title: "ClosedLoop Sync", timezone: "Asia/Karachi", required_attendees: ["Zaid", "Sharjeel", "Obaid", "Nouman"], seed_notes_directory: "demo/meetings" }));
process.chdir(scratch);

const { records, notesPaths, updateRecord } = await import("../../meeting-records.js");
const { ResultsStore } = await import("../../polly/src/results.js");
const { createLoopRunner, parseTranscriptLine } = await import("../run.js");
const { createLiveDetector } = await import("../live.js");

const sync06 = readFileSync(join(scratch, "demo/meetings/sync-06-2026-09-10.md"), "utf8");
const loopState06 = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(sync06)[1]);

/** Stands in for generate-notes.js: writes sync-06's notes + loop state for the meeting. */
async function fakeNotes(id) {
  mkdirSync(join(scratch, "notes"), { recursive: true });
  const { notesPath, loopStatePath } = notesPaths(id);
  writeFileSync(notesPath, sync06.split("\n---\n")[0]);
  writeFileSync(loopStatePath, JSON.stringify({ ...loopState06, meeting_id: id }));
  updateRecord(id, { status: "complete", notesPath, loopStatePath, completedAt: new Date().toISOString() });
}

function fakePolly(store) {
  const runs = [];
  const watching = new Map();
  return {
    store,
    runs,
    runner: { watching, close: async () => {} },
    surveys: { watching, close: async () => {} },
    parse: (raw) => ({ kind: "survey", request: raw }),
    summary: (key) => store.writeSummary(key),
    async run(raw, hooks = {}) {
      runs.push(raw);
      if (raw.survey) {
        const record = { id: `survey_${raw.survey.draftId}`, meeting_id: raw.meeting_id, kind: "survey", question: raw.survey.title, options: [], channel: raw.channel, meta: { question_map: raw.question_map }, status: "open", votes: 0, choices: [], ranking: [], questions: [], created_at: new Date().toISOString(), polly: { id: "srv1", type: "survey", results_url: "https://polly.test/srv1", web_voting_url: "https://polly.test/vote/srv1", sent_at: new Date().toISOString() } };
        store.write(record);
        await hooks.onSent?.([record]);
        const closed = { ...record, status: "closed", votes: 3, closed_at: new Date().toISOString(), readback: { respondents: 3, gaps: [{ gap_id: "CL-A-08.due", field: "due_date", resolution: "filled", winning_option: "Fri 11 Sep", votes: 3, counts: { "Fri 11 Sep": 3 } }, { gap_id: "CL-Q-03.decision", field: "decision", resolution: "tie", winning_option: null, votes: 2, counts: { "Live RTMS — go for it": 1, "Recorded fallback — play it safe": 1 } }], ratification: { confirmed: ["CL-D-06"], partial: ["CL-D-07"], none_of_these: 0, decisions: [] }, ranking: { order: [{ rank: 1, item: "CL-A-01", choice: "CL-A-01 — Confirm Zoom RTMS entitlement and credits", priority: "P0", score: 7 }], scale: ["P0", "P1", "P2"] }, human_only: [] } };
        store.write(closed);
        return { record: closed, summary: store.writeSummary(raw.meeting_id) };
      }
      const poll = raw.polls[0];
      const record = { id: poll.id, meeting_id: raw.meeting_id, kind: poll.kind, question: poll.question, options: poll.options, meta: poll.meta, status: "open", votes: 0, choices: [], ranking: [], created_at: new Date().toISOString(), polly: { id: "p1", type: "poll", sent_at: new Date().toISOString() } };
      store.write(record);
      await hooks.onSent?.([record]);
      const closed = { ...record, status: "closed", votes: 2, closed_at: new Date().toISOString(), ranking: poll.options.map((o, i) => ({ rank: i + 1, option: o, score: i === 0 ? 2 : 0 })) };
      store.write(closed);
      return { records: [closed], summary: store.writeSummary(raw.meeting_id) };
    },
  };
}

test("transcript lines parse", () => {
  assert.deepEqual(parseTranscriptLine("[1789189200000] Obaid: Okay, recording is on."), { ts: "1789189200000", speaker: "Obaid", text: "Okay, recording is on." });
  assert.equal(parseTranscriptLine("# Zoom RTMS transcript"), null);
});

test("demo run: transcript → notes → survey → results → enriched, one callback per stage", async () => {
  const store = new ResultsStore(join(scratch, "polly-results"));
  const polly = fakePolly(store);
  const events = [];
  const notifier = { url: "http://cb.test", events: () => [], notify: async (event, payload) => { events.push({ event, payload }); return { delivered: true }; } };
  const enriched = [];
  const enrich = async (id, { pollRound }) => {
    enriched.push(pollRound);
    return { notes: "# enriched", loopState: { meeting_id: id, gaps: [] }, stats: { respondents: pollRound.respondents, filled: 1, gaps_asked: pollRound.results.length }, version: 2, previous: {}, enrichedAt: "now" };
  };
  const runner = createLoopRunner({ polly, notifier, log: () => {}, baseUrl: "http://localhost:8080", channel: "#closed-loop-project", options: { settleSeconds: 5, closeAt: "+10m" }, notes: fakeNotes, enrich });
  const detector = createLiveDetector({ meetingId: "demo-1", pollyMeetingId: "demo-1", channel: "#closed-loop-project", polly, extract: async () => ({ fire: true, reason: "asked", question: "Open on Zoom or on the canvas?", kind: "single", options: ["Zoom", "Canvas"], item: "Demo opening", field: "decision" }), notify: notifier.notify, sleep: async () => {}, options: { debounceMs: 0 } });

  const status = await runner.demo({ transcriptPath: "demo/transcripts/sync-07-2026-09-12.txt", meetingId: "demo-1", live: true, detector });
  assert.equal(status.stage, "done");
  assert.deepEqual(events.map((e) => e.event), ["live.poll_sent", "live.poll_closed", "notes.ready", "survey.sent", "results.ready", "notes.enriched"]);

  const record = records()["demo-1"];
  assert.equal(record.status, "complete");
  assert.equal(record.loop.survey_round, 1);
  assert.equal(record.loop.polly_meeting_id, "demo-1");
  assert.ok(existsSync(record.loop.survey_request_path));
  assert.deepEqual(record.loop.live_polls, [{ id: "live-1", question: "Open on Zoom or on the canvas?", status: "closed" }]);
  assert.equal(polly.runs.length, 2, "live poll + survey");
  const surveyRaw = polly.runs[1];
  assert.equal(surveyRaw.channel, "#closed-loop-project");
  assert.equal(surveyRaw.survey.draftId, "cl-demo-1-r1");
  assert.equal(surveyRaw.settle_seconds, 5);
  assert.equal(surveyRaw.survey.closeAt, "+10m");

  const notesReady = events.find((e) => e.event === "notes.ready").payload;
  assert.match(notesReady.notes_markdown, /^# 📋 ClosedLoop Sync/);
  assert.equal(notesReady.gaps, 6);
  assert.equal(notesReady.urls.notes, "http://localhost:8080/loop/demo-1/notes.md");
  const sent = events.find((e) => e.event === "survey.sent").payload;
  assert.equal(sent.survey.fallback, false);
  assert.equal(sent.survey.pollys[0].web_voting_url, "https://polly.test/vote/srv1");
  assert.equal(sent.question_map.length, 11);
  const results = events.find((e) => e.event === "results.ready").payload;
  assert.equal(results.poll_round.respondents, 3);
  assert.deepEqual(results.poll_round.results.map((r) => [r.gap_id, r.resolution]), [["live-1", "filled"], ["CL-A-08.due", "filled"], ["CL-Q-03.decision", "tie"]]);
  assert.deepEqual(results.poll_round.ratification.confirmed, ["CL-D-06"]);
  assert.equal(results.results.live_polls, 1);
  assert.equal(enriched.length, 1);
  const done = events.find((e) => e.event === "notes.enriched").payload;
  assert.equal(done.notes_markdown, "# enriched");
  assert.equal(done.enrichment.filled, 1);
  assert.equal(runner.status("demo-1").files.poll_round, join(scratch, "polly-results/demo-1/poll_round.json"));

  // A second round re-asks with a new draftId; a plain re-run is a no-op.
  await runner.run("demo-1");
  assert.equal(polly.runs.length, 2);
  await runner.run("demo-1", { from: "survey" });
  assert.equal(polly.runs.length, 3);
  assert.equal(polly.runs[2].survey.draftId, "cl-demo-1-r2");
  assert.equal(records()["demo-1"].loop.survey_round, 2);
  assert.equal(events.filter((e) => e.event === "notes.ready").length, 1, "no second notes.ready on a re-poll");
  await runner.run("demo-1", { from: "enrich" });
  assert.equal(enriched.length, 3);
  await assert.rejects(() => runner.demo({ transcriptPath: "demo/transcripts/sync-07-2026-09-12.txt", meetingId: "demo-1" }), /already exists/);
});

test("survey skipped and loop failures are reported", async () => {
  const store = new ResultsStore(join(scratch, "polly-results-2"));
  const polly = fakePolly(store);
  const events = [];
  const notifier = { url: null, events: () => [], notify: async (event, payload) => { events.push(event); return { delivered: false }; } };
  const emptyNotes = async (id) => {
    mkdirSync(join(scratch, "notes"), { recursive: true });
    const { notesPath, loopStatePath } = notesPaths(id);
    writeFileSync(notesPath, "# 📋 Quiet sync\n\n## Decisions\n\n(none)\n");
    writeFileSync(loopStatePath, JSON.stringify({ meeting_id: id, attendance: {}, open_items: [], gaps: [] }));
    updateRecord(id, { status: "complete", notesPath, loopStatePath });
  };
  const runner = createLoopRunner({ polly, notifier, log: () => {}, channel: "#c", notes: emptyNotes, enrich: async () => { throw new Error("should not enrich"); } });
  const status = await runner.demo({ transcriptPath: "demo/transcripts/sync-07-2026-09-12.txt", meetingId: "quiet" });
  assert.equal(status.stage, "done");
  assert.deepEqual(events, ["notes.ready", "survey.skipped"]);
  assert.equal(polly.runs.length, 0);

  const failing = createLoopRunner({ polly, notifier, log: () => {}, channel: "#c", notes: async (id) => updateRecord(id, { status: "skipped", error: "Transcript has no utterances" }) });
  await assert.rejects(() => failing.demo({ transcriptPath: "demo/transcripts/sync-07-2026-09-12.txt", meetingId: "broken" }), /notes not generated \(skipped: Transcript has no utterances\)/);
});
