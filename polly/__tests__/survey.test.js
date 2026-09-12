import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createPolly } from "../index.js";
import { buildPollRound, ResultsStore } from "../src/results.js";
import { isSurveyRequest, minutesUntilClose, parseSurveyRequest, readbackSurvey, SurveyRunner } from "../src/survey.js";

const example = JSON.parse(readFileSync(fileURLToPath(new URL("../examples/survey-request.json", import.meta.url)), "utf8"));

/** Polly's get_polly_results for the example survey: 4 respondents. */
function surveyResults(status = "active") {
  const q = (index, choices, extra = {}) => ({ index, title: example.survey.questions[index].title, type: example.survey.questions[index].type, totalVotes: 4, responseCount: 4, choices, ...extra });
  return {
    id: "srv1",
    type: "survey",
    status,
    responseCount: 4,
    questions: [
      q(0, [
        { text: example.survey.questions[0].choices[0], votes: 4, percentage: 100 },
        { text: example.survey.questions[0].choices[1], votes: 2, percentage: 50 },
        { text: "None of these — see my comment", votes: 1, percentage: 25 },
      ]),
      q(1, [], { responseCount: 2 }),
      q(2, [
        { text: "Obaid", votes: 0, percentage: 0 },
        { text: "Zaid", votes: 1, percentage: 25 },
        { text: "Nouman", votes: 0, percentage: 0 },
        { text: "Sharjeel", votes: 3, percentage: 75 },
        { text: "Someone else / not yet decided", votes: 0, percentage: 0 },
      ]),
      q(3, [
        { text: "Live RTMS — go for it", votes: 2, percentage: 50 },
        { text: "Recorded fallback — play it safe", votes: 2, percentage: 50 },
        { text: "Decide Saturday morning once entitlement is known", votes: 0, percentage: 0 },
      ]),
      q(4, [
        { text: "CL-A-01 — Confirm Zoom RTMS entitlement and credits", votes: 18, percentage: 30 },
        { text: "CL-A-02 — Slack canvas write/edit path spike", votes: 9, percentage: 15 },
        { text: "CL-A-03 — Launch-readiness review and dry run", votes: 15, percentage: 25 },
        { text: "CL-A-07 — Zoom side-panel skeleton", votes: 12, percentage: 20 },
        { text: "CL-A-08 — Intervention cooldown and priority-ordering logic", votes: 6, percentage: 10 },
      ]),
      q(5, [], { averageScore: 4.25, responseCount: 4 }),
      q(6, [], { responseCount: 3 }),
    ],
    raw: {},
  };
}

class FakePolly {
  created = [];
  reads = 0;
  constructor(closeAfterReads = 2) {
    this.closeAfterReads = closeAfterReads;
  }
  async createSurvey(input) {
    this.created.push(input);
    return { id: "srv1", type: "survey", resultsUrl: "https://polly.test/srv1", alreadySent: false, raw: {} };
  }
  async getAllResults() {
    this.reads++;
    return surveyResults(this.reads >= this.closeAfterReads ? "closed" : "active");
  }
  async closePoll() {}
  async disconnect() {}
}

test("the skill's worked example parses as a survey request", () => {
  assert.ok(isSurveyRequest(example));
  const request = parseSurveyRequest(example);
  assert.equal(request.survey.questions.length, 7);
  assert.equal(request.question_map.length, 7);
  assert.equal(request.min_votes, 1);
  assert.deepEqual(request.priority_scale, ["P0", "P1", "P2"]);
  assert.throws(() => parseSurveyRequest({ ...example, question_map: [{ index: 9, role: "gap" }] }), /out of range/);
  assert.throws(() => parseSurveyRequest({ meeting_id: "m", survey: { title: "t", questions: [{ type: "yesNo", title: "one?" }] } }), /questions/);
  assert.equal(minutesUntilClose("+18h"), 1080);
  assert.equal(minutesUntilClose("+45m"), 45);
  assert.equal(minutesUntilClose(undefined), 1440);
});

test("readback per role: ratification majority, gap filled/tie, ranking → priority buckets, rating, human-only", () => {
  const request = parseSurveyRequest(example);
  const rb = readbackSurvey(request, surveyResults());
  assert.equal(rb.respondents, 4);
  assert.deepEqual(rb.ratification.confirmed, ["CL-D-06"]);
  assert.deepEqual(rb.ratification.partial, ["CL-D-07"]);
  assert.equal(rb.ratification.none_of_these, 1);
  assert.deepEqual(rb.gaps.map((g) => [g.gap_id, g.resolution, g.winning_option]), [
    ["CL-A-03.owner", "filled", "Sharjeel"],
    ["CL-Q-03.decision", "tie", null],
  ]);
  assert.equal(rb.gaps[1].detail, "Live RTMS — go for it 2, Recorded fallback — play it safe 2");
  assert.deepEqual(rb.ranking.order.map((o) => [o.rank, o.item, o.priority]), [
    [1, "CL-A-01", "P0"],
    [2, "CL-A-03", "P0"],
    [3, "CL-A-07", "P1"],
    [4, "CL-A-02", "P1"],
    [5, "CL-A-08", "P2"],
  ]);
  assert.equal(rb.meeting_rating.average, 4.25);
  assert.deepEqual(rb.human_only.map((h) => [h.role, h.responses]), [["missed_items", 2], ["next_agenda", 3]]);
});

test("survey runner: send → watch → closed → poll_round.json carries gaps, ratification, ranking", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polly-survey-"));
  const store = new ResultsStore(dir);
  const mcp = new FakePolly(2);
  let clock = 0;
  const runner = new SurveyRunner({ mcp, store, pollEveryMs: 1000, now: () => clock, sleep: async (ms) => (clock += ms), log: () => {} });
  const request = parseSurveyRequest(example);
  const { record, summary } = await runner.run(request);
  assert.equal(mcp.created.length, 1);
  assert.equal(mcp.created[0].draftId, "closedloop-sync-6-1757667000");
  assert.deepEqual(mcp.created[0].userNames, ["Obaid", "Zaid", "Nouman", "Sharjeel"]);
  assert.equal(mcp.created[0].channelNames, undefined, "named audience wins over the channel");
  assert.equal(mcp.created[0].resultsVisibility, "onClose");
  assert.equal(record.kind, "survey");
  assert.equal(record.status, "closed");
  assert.equal(record.closed_by, "polly_close_at");
  assert.equal(record.votes, 4);
  const round = JSON.parse(readFileSync(summary.round, "utf8"));
  assert.equal(round.respondents, 4);
  assert.deepEqual(round.results.map((r) => r.gap_id), ["CL-A-03.owner", "CL-Q-03.decision"]);
  assert.deepEqual(round.ratification.confirmed, ["CL-D-06"]);
  assert.equal(round.ranking.order[0].item, "CL-A-01");
  assert.equal(round.meeting_rating.average, 4.25);
  assert.ok(existsSync(summary.md));
  assert.match(readFileSync(summary.md, "utf8"), /Priority ranking/);
  // re-run reuses the sent survey
  await runner.run(request);
  assert.equal(mcp.created.length, 1);
});

test("survey auto-close: settles once min_votes are in and nothing changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polly-survey-"));
  const store = new ResultsStore(dir);
  const mcp = new FakePolly(1000);
  let clock = 0;
  const closed = [];
  mcp.closePoll = async (id) => {
    closed.push(id);
  };
  const runner = new SurveyRunner({ mcp, store, pollEveryMs: 5000, now: () => clock, sleep: async (ms) => (clock += ms), log: () => {} });
  const { record } = await runner.run(parseSurveyRequest({ ...example, min_votes: 3, settle_seconds: 20 }));
  assert.equal(record.closed_by, "settled");
  assert.deepEqual(closed, ["srv1"]);
});

test("createPolly dispatches surveys and gap polls through the same entry point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "polly-entry-"));
  const mcp = new FakePolly(1);
  mcp.createPoll = async (input) => ({ id: `p_${input.draftId}`, type: "poll", alreadySent: false, raw: {} });
  mcp.getResults = async (id, type) => ({ id, type, status: "closed", responseCount: 1, totalVotes: 1, choices: [{ text: "Fri", votes: 1, percentage: 100 }, { text: "No date needed", votes: 0, percentage: 0 }], raw: {} });
  const polly = createPolly({ mcp, channel: "#closed-loop-project", resultsDir: join(dir, "results"), pollEveryMs: 1, log: () => {} });
  const survey = await polly.run(example);
  assert.equal(survey.record.kind, "survey");
  const gaps = await polly.run({ meeting_id: "CL-sync-06", gaps: [{ gap_id: "CL-A-08.due", field: "due_date", ask: "When?", options: ["Fri", "No date needed"] }] });
  assert.equal(gaps.records[0].status, "closed");
  const round = buildPollRound("CL-sync-06", polly.results("CL-sync-06"));
  assert.deepEqual(round.results.map((r) => r.gap_id).sort(), ["CL-A-03.owner", "CL-A-08.due", "CL-Q-03.decision"]);
});

test("Free-plan fallback: a survey refused as premium degrades to one poll per readable question", async () => {
  const { PollyToolError } = await import("../src/mcp.js");
  const { surveyToPolls } = await import("../src/survey.js");
  const dir = mkdtempSync(join(tmpdir(), "polly-fallback-"));
  const created = [];
  const spreads = {
    ratification: [3, 1, 1],
    "CL-A-03.owner": [0, 1, 0, 3, 0],
    "CL-Q-03.decision": [3, 1, 0],
    ranking: [18, 9, 15, 12, 6],
  };
  const mcp = {
    async createSurvey() {
      throw new PollyToolError("create_polly", "plan limit (premium-type): Survey is not available on their current plan (Free).");
    },
    async createPoll(input) {
      created.push(input);
      return { id: `p_${input.draftId}`, type: "poll", alreadySent: false, raw: {} };
    },
    async getResults(id, type) {
      const input = created.find((c) => `p_${c.draftId}` === id);
      const key = Object.keys(spreads).find((k) => input.draftId.endsWith(k.replace(/[^A-Za-z0-9_-]/g, "_")));
      const spread = spreads[key];
      return { id, type, status: "closed", responseCount: 4, totalVotes: 4, choices: input.options.map((text, i) => ({ text, votes: spread[i] ?? 0, percentage: 0 })), raw: {} };
    },
    async closePoll() {},
    async disconnect() {},
  };
  const converted = surveyToPolls(parseSurveyRequest(example));
  assert.deepEqual(converted.polls.map((p) => [p.id, p.kind, p.delivery]), [
    ["ratification", "multiple", "dm"],
    ["CL-A-03.owner", "single", "dm"],
    ["CL-Q-03.decision", "single", "dm"],
    ["ranking", "ranked", "dm"],
  ]);
  assert.deepEqual(converted.polls[0].audience, ["Obaid", "Zaid", "Nouman", "Sharjeel"]);

  const polly = createPolly({ mcp, channel: "#closed-loop-project", resultsDir: join(dir, "results"), pollEveryMs: 1, log: () => {} });
  const outcome = await polly.run(example);
  assert.equal(outcome.fallback, true);
  assert.equal(outcome.record.status, "failed");
  assert.equal(created.length, 4);
  assert.deepEqual(created[0].audience, { emails: [], ids: [], names: ["Obaid", "Zaid", "Nouman", "Sharjeel"] });
  const round = JSON.parse(readFileSync(outcome.summary.round, "utf8"));
  assert.equal(round.fallback, true);
  assert.deepEqual(round.results.map((r) => [r.gap_id, r.resolution, r.winning_option]), [
    ["CL-A-03.owner", "filled", "Sharjeel"],
    ["CL-Q-03.decision", "filled", "Live RTMS — go for it"],
  ]);
  assert.deepEqual(round.ratification.confirmed, ["CL-D-06"]);
  assert.deepEqual(round.ratification.partial, ["CL-D-07"]);
  assert.equal(round.ratification.none_of_these, 1);
  assert.deepEqual(round.ranking.order.map((o) => [o.rank, o.item, o.priority]), [
    [1, "CL-A-01", "P0"], [2, "CL-A-03", "P0"], [3, "CL-A-07", "P1"], [4, "CL-A-02", "P1"], [5, "CL-A-08", "P2"],
  ]);
  assert.equal(round.surveys[0].error.includes("plan limit"), true);
});
