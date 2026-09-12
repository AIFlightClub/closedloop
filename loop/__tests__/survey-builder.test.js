import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseSurveyRequest } from "../../polly/index.js";
import { clip, parseActionItems, parseDecisions } from "../notes-parse.js";
import { buildSurveyRequest, ensureEscape, pollyMeetingKey } from "../survey-builder.js";

const notes = readFileSync(fileURLToPath(new URL("../../demo/meetings/sync-06-2026-09-10.md", import.meta.url)), "utf8");
const loopState = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(notes)[1]);
const config = { title: "ClosedLoop Sync", required_attendees: ["Zaid", "Sharjeel", "Obaid", "Nouman"], timezone: "Asia/Karachi" };

test("notes parser: decisions and action items with stable ids", () => {
  const decisions = parseDecisions(notes);
  assert.deepEqual(decisions.map((d) => d.id), ["CL-D-06", "CL-D-07"]);
  assert.match(decisions[0].text, /^The side panel shows three buckets/);
  assert.doesNotMatch(decisions[0].text, /proposed by/);
  const actions = parseActionItems(notes);
  assert.deepEqual(actions.map((a) => a.id), ["CL-A-01", "CL-A-03", "CL-A-07", "CL-A-09", "CL-A-08", "CL-A-02", "CL-A-04"]);
  assert.equal(actions.find((a) => a.id === "CL-A-02").text, "Slack canvas write/edit path spike");
  assert.equal(actions.find((a) => a.id === "CL-A-07").text, "Zoom side-panel skeleton with the three-bucket layout");
  assert.equal(clip("a".repeat(400), 300).length, 300);
});

test("survey builder: fixed shape from notes + loop state, valid for the Polly module", () => {
  const built = buildSurveyRequest({ meetingId: "rtms/stream 07", meetingDate: "2026-09-10", notes, loopState, config, channel: "#closed-loop-project", round: 1, options: { closeAt: "+20m", settleSeconds: 30 } });
  assert.ok(built.request, built.reason);
  const { raw, request } = built;
  assert.equal(raw.meeting_id, "rtms_stream_07");
  assert.equal(raw.survey.draftId, "cl-rtms-stream-07-r1");
  assert.equal(raw.survey.closeAt, "+20m");
  assert.equal(request.channel, "#closed-loop-project");
  assert.deepEqual(raw.question_map.map((m) => m.role), ["ratification", "missed_items", "gap", "gap", "gap", "gap", "gap", "gap", "ranking", "meeting_rating", "next_agenda"]);
  raw.question_map.forEach((entry, i) => assert.equal(entry.index, i));
  const q1 = raw.survey.questions[0];
  assert.equal(q1.type, "multipleChoice");
  assert.equal(q1.allowMultipleAnswers, true);
  assert.equal(q1.required, false);
  assert.equal(q1.choices.at(-1), "None of these — see my comment");
  assert.match(q1.choices[0], /^CL-D-06 — The side panel/);
  assert.deepEqual(raw.question_map[0].decisions, ["CL-D-06", "CL-D-07"]);
  const gaps = raw.question_map.filter((m) => m.role === "gap");
  assert.deepEqual(gaps.map((g) => g.gap_id), ["CL-Q-03.decision", "CL-A-07.priority", "CL-A-08.priority", "CL-A-08.due", "CL-A-09.priority", "CL-A-02.status"]);
  for (const gap of gaps) {
    const q = raw.survey.questions[gap.index];
    assert.equal(q.type, "multipleChoice");
    assert.equal(q.required, true);
    assert.ok(gap.escape_options.length >= 1, `${gap.gap_id} needs an escape hatch`);
    assert.ok(q.choices.every((c) => c.length <= 300));
  }
  assert.match(raw.survey.questions[gaps[1].index].title, /Zoom side-panel skeleton/, "gap question names the item");
  const ranking = raw.question_map.find((m) => m.role === "ranking");
  const rq = raw.survey.questions[ranking.index];
  assert.equal(rq.type, "ranked");
  assert.equal(rq.rankCount, 7);
  assert.equal(rq.choices.length, 7);
  assert.match(rq.choices[0], /^CL-A-01 — /, "P0 first");
  assert.deepEqual(ranking.items.slice(0, 1), ["CL-A-01"]);
  assert.equal(raw.survey.questions.at(-2).type, "1To5");
  assert.equal(raw.survey.questions.at(-1).type, "openEnded");
  assert.deepEqual(built.escalated, []);
  assert.deepEqual(built.deferred, []);
  assert.equal(built.counts.questions, 11);
  assert.doesNotThrow(() => parseSurveyRequest(raw, { channel: "#closed-loop-project" }));
});

test("survey builder: escalated gaps skipped, overflow deferred, nothing-to-ask returns null", () => {
  const many = { ...loopState, gaps: [...loopState.gaps.map((g) => ({ ...g })), ...Array.from({ length: 5 }, (_, i) => ({ gap_id: `CL-A-2${i}.owner`, field: "owner", ask: `Who owns item ${i}?`, options: ["Zaid", "Obaid"], audience: ["zaid"], rounds_asked: 0 })), { gap_id: "CL-A-03.owner", field: "owner", ask: "Who owns CL-A-03?", options: ["Zaid", "Obaid", "Someone else"], audience: ["zaid"], rounds_asked: 3 }] };
  const built = buildSurveyRequest({ meetingId: "m", meetingDate: "2026-09-10", notes, loopState: many, config, channel: "#c" });
  assert.equal(built.raw.question_map.filter((m) => m.role === "gap").length, 8);
  assert.deepEqual(built.deferred, ["CL-A-22.owner", "CL-A-23.owner", "CL-A-24.owner"]);
  assert.deepEqual(built.escalated, ["CL-A-03.owner"]);
  const empty = buildSurveyRequest({ meetingId: "m", meetingDate: "2026-09-10", notes: "# notes\n\n## Decisions\n\n(none)\n", loopState: { open_items: [{ id: "A-1", item: "one" }], gaps: [] }, config, channel: "#c" });
  assert.equal(empty.request, null);
  assert.match(empty.reason, /nothing to ask/);
  const one = buildSurveyRequest({ meetingId: "m", meetingDate: "2026-09-10", notes: "## Decisions\n\n1. **[D-1]** Ship it — proposed by A, affirmed by B\n", loopState: { open_items: [], gaps: [] }, config, channel: "#c" });
  assert.ok(one.request);
  assert.deepEqual(one.raw.question_map.map((m) => m.role), ["ratification", "missed_items", "meeting_rating", "next_agenda"]);
});

test("escape hatches and meeting keys", () => {
  assert.deepEqual(ensureEscape("owner", ["Zaid", "Obaid", "zaid"]), ["Zaid", "Obaid", "Someone else / not yet decided"]);
  assert.deepEqual(ensureEscape("due_date", ["Fri 18 Sep", "No date needed"]), ["Fri 18 Sep", "No date needed"]);
  assert.deepEqual(ensureEscape("priority", ["P0", "P1"]), ["P0", "P1", "Drop it"]);
  assert.equal(pollyMeetingKey("abc/def ghi:1"), "abc_def_ghi_1");
});
