import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rankChoices, renderRecordMarkdown, ResultsStore } from "../src/results.js";
import { renderResultsMrkdwn } from "../src/slack.js";
const options = ["Event discovery", "Registration flow", "Partner integration", "Analytics"];
test("ranking matches by text, ignores case/spacing, keeps option order on ties", () => {
    const ranking = rankChoices(options, [
        { text: "analytics", votes: 5, percentage: 15 },
        { text: "  Partner   integration ", votes: 9, percentage: 27 },
        { text: "Event discovery", votes: 12, percentage: 36 },
        { text: "Registration flow", votes: 5, percentage: 15 },
    ]);
    assert.deepEqual(ranking.map((r) => [r.rank, r.option, r.score]), [[1, "Event discovery", 12], [2, "Partner integration", 9], [3, "Registration flow", 5], [4, "Analytics", 5]]);
});
test("ranking falls back to position when texts differ but counts align", () => {
    const ranking = rankChoices(options, [
        { text: "1", votes: 1, percentage: 10 },
        { text: "2", votes: 4, percentage: 40 },
        { text: "3", votes: 3, percentage: 30 },
        { text: "4", votes: 2, percentage: 20 },
    ]);
    assert.deepEqual(ranking.map((r) => r.option), ["Registration flow", "Partner integration", "Analytics", "Event discovery"]);
});
function record(overrides = {}) {
    const stamp = "2026-09-12T08:00:00.000Z";
    return {
        id: "priorities",
        meeting_id: "sync_12",
        kind: "ranked",
        question: "Rank these",
        options,
        context: "no agreed priority",
        channel: "#closed-loop-project",
        meta: {},
        polly: { id: "p1", type: "poll", draft_id: "d", results_url: "https://polly.test/r/p1", sent_at: stamp },
        status: "closed",
        closed_by: "settled",
        votes: 14,
        choices: [],
        ranking: [
            { rank: 1, option: "Event discovery", score: 41, percentage: 32 },
            { rank: 2, option: "Analytics", score: 22, percentage: 17 },
        ],
        winner: "Event discovery",
        created_at: stamp,
        updated_at: stamp,
        ...overrides,
    };
}
test("markdown and mrkdwn renderings carry question, votes, ranking, link", () => {
    const md = renderRecordMarkdown(record());
    assert.match(md, /^### Rank these/);
    assert.match(md, /14 votes/);
    assert.match(md, /1\. \*\*Event discovery\*\* — 41 \(32%\)/);
    assert.match(md, /\[results\]\(https:\/\/polly.test\/r\/p1\)/);
    const mrkdwn = renderResultsMrkdwn(record());
    assert.match(mrkdwn, /Poll closed — Rank these/);
    assert.match(mrkdwn, /1\. \*Event discovery\* — 41/);
    assert.match(mrkdwn, /<https:\/\/polly.test\/r\/p1\|full results>/);
});
test("store round-trips records and writes the meeting summary", () => {
    const store = new ResultsStore(mkdtempSync(join(tmpdir(), "polly-results-")));
    store.write(record());
    store.write(record({ id: "owner", question: "Who owns it?", kind: "single", created_at: "2026-09-12T08:00:01.000Z" }));
    assert.equal(store.read("sync_12", "priorities")?.winner, "Event discovery");
    assert.deepEqual(store.list("sync_12").map((r) => r.id), ["priorities", "owner"]);
    const summary = store.writeSummary("sync_12");
    assert.equal(summary.records.length, 2);
    assert.match(summary.md, /summary\.md$/);
    assert.equal(store.list("sync_12").length, 2, "summary files are not records");
});
test("gap resolution follows the enrich rules: filled / tie / escape hatch / no responses", async () => {
    const { resolveGap, buildPollRound } = await import("../src/results.js");
    const gap = (ranking, votes, extra = {}) => resolveGap(record({
        id: "CL-A-03.owner",
        question: "Who owns the launch-readiness review?",
        kind: "single",
        options: ["Zaid", "Nouman", "Sharjeel", "Obaid", "Someone else / not decided"],
        meta: { gap_id: "CL-A-03.owner", item: "Launch-readiness review", field: "owner" },
        votes,
        ranking: ranking.map(([option, score], i) => ({ rank: i + 1, option, score, percentage: 0 })),
        ...extra,
    }));
    assert.deepEqual(gap([["Sharjeel", 3], ["Nouman", 1]], 4).resolution, "filled");
    assert.equal(gap([["Sharjeel", 3], ["Nouman", 1]], 4).winning_option, "Sharjeel");
    const tie = gap([["Sharjeel", 2], ["Nouman", 2], ["Zaid", 0]], 4);
    assert.equal(tie.resolution, "tie");
    assert.equal(tie.winning_option, null);
    assert.equal(tie.detail, "Sharjeel 2, Nouman 2");
    const escape = gap([["Someone else / not decided", 3], ["Zaid", 1]], 4);
    assert.equal(escape.resolution, "escape_hatch");
    assert.equal(escape.winning_option, "Someone else / not decided");
    assert.equal(gap([["Fri 11 Sep", 2], ["No date needed", 1]], 3, { options: ["Fri 11 Sep", "No date needed"] }).resolution, "filled");
    assert.equal(gap([["No date needed", 2], ["Fri 11 Sep", 1]], 3).resolution, "escape_hatch");
    assert.equal(gap([["Drop it", 2], ["P1", 1]], 3).resolution, "filled", "Drop it is a real answer");
    assert.equal(gap([["Later", 2]], 3, { escape_options: ["Later"] }).resolution, "escape_hatch");
    assert.equal(gap([], 0).resolution, "no_responses");
    assert.equal(gap([["Zaid", 0], ["Nouman", 0]], 0).resolution, "no_responses");
    const round = buildPollRound("CL-sync-06", [
        record({ id: "CL-A-03.owner", votes: 4, ranking: [{ rank: 1, option: "Sharjeel", score: 3, percentage: 75 }, { rank: 2, option: "Nouman", score: 1, percentage: 25 }], meta: { gap_id: "CL-A-03.owner", field: "owner" }, closed_at: "2026-09-12T09:00:00.000Z" }),
        record({ id: "CL-A-08.due", votes: 1, status: "open", closed_at: undefined, ranking: [], meta: { gap_id: "CL-A-08.due", field: "due_date" } }),
    ]);
    assert.equal(round.respondents, 4);
    assert.equal(round.complete, false);
    assert.deepEqual(round.results.map((r) => [r.gap_id, r.resolution, r.winning_option]), [
        ["CL-A-03.owner", "filled", "Sharjeel"],
        ["CL-A-08.due", "no_responses", null],
    ]);
});
