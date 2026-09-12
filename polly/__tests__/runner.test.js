import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PollyToolError, parseAlreadySent } from "../src/mcp.js";
import { parsePollRequest } from "../src/request.js";
import { ResultsStore } from "../src/results.js";
import { PollRunner } from "../src/runner.js";
/** A scripted Polly: each getResults call pops the next snapshot. */
class FakePolly {
    script;
    opts;
    created = [];
    closed = [];
    reads = 0;
    constructor(script, opts = {}) {
        this.script = script;
        this.opts = opts;
    }
    async createPoll(input) {
        if (this.opts.failCreate)
            throw this.opts.failCreate;
        this.created.push(input);
        return { id: `polly_${input.draftId}`, type: "poll", resultsUrl: "https://polly.test/r", alreadySent: false, raw: {} };
    }
    async getResults(id, type) {
        const step = this.script[Math.min(this.reads, this.script.length - 1)] ?? {};
        this.reads++;
        return { id, type, totalVotes: 0, responseCount: 0, choices: [], raw: {}, ...step };
    }
    async closePoll(id) {
        this.closed.push(id);
    }
    async disconnect() { }
}
const request = parsePollRequest({
    meeting_id: "sync_12",
    channel: "#closed-loop-project",
    polls: [
        {
            id: "priorities",
            kind: "ranked",
            question: "Rank these",
            options: ["Event discovery", "Registration flow", "Partner integration", "Analytics"],
            close_after_minutes: 10,
            min_votes: 3,
            settle_seconds: 20,
            meta: { action_ids: ["a", "b", "c", "d"] },
        },
    ],
});
const votes = (n, spread = [12, 5, 9, 5]) => ({
    responseCount: n,
    totalVotes: n,
    choices: [
        { text: "Event discovery", votes: spread[0], percentage: 40 },
        { text: "Registration flow", votes: spread[1], percentage: 15 },
        { text: "Partner integration", votes: spread[2], percentage: 30 },
        { text: "Analytics", votes: spread[3], percentage: 15 },
    ],
});
function harness(script, opts = {}) {
    const dir = mkdtempSync(join(tmpdir(), "polly-runner-"));
    const store = new ResultsStore(dir);
    const mcp = new FakePolly(script, { failCreate: opts.failCreate });
    let clock = 1_000_000;
    const posted = [];
    const runner = new PollRunner({
        mcp,
        store,
        poster: opts.poster === false ? undefined : { post: async (r) => (posted.push(r), { channel: "C1", ts: "1.2" }) },
        pollEveryMs: 5000,
        now: () => clock,
        sleep: async (ms) => {
            clock += ms;
        },
        log: () => { },
    });
    return { dir, store, mcp, runner, posted, tick: (ms) => (clock += ms) };
}
test("send → watch → Polly closes → ranked results, file written, Slack posted", async () => {
    const h = harness([votes(2), votes(5), votes(14), { ...votes(14), status: "closed" }]);
    const { records, summary } = await h.runner.run(request);
    const [record] = records;
    assert.equal(h.mcp.created.length, 1);
    assert.equal(h.mcp.created[0]?.draftId, "closedloop_sync_12_priorities");
    assert.equal(h.mcp.created[0]?.type, "ranked");
    assert.equal(h.mcp.created[0]?.rankCount, 4);
    assert.equal(h.mcp.created[0]?.closeAt, "+10m");
    assert.equal(record?.status, "closed");
    assert.equal(record?.closed_by, "polly_close_at");
    assert.equal(record?.votes, 14);
    assert.deepEqual(record?.ranking.map((r) => r.option), ["Event discovery", "Partner integration", "Registration flow", "Analytics"]);
    assert.equal(record?.winner, "Event discovery");
    assert.deepEqual(record?.meta, { action_ids: ["a", "b", "c", "d"] });
    assert.equal(record?.slack?.posted, true);
    assert.equal(h.posted.length, 1);
    assert.deepEqual(h.mcp.closed, [], "Polly closed it; we did not");
    const onDisk = JSON.parse(readFileSync(h.store.path("sync_12", "priorities"), "utf8"));
    assert.equal(onDisk.status, "closed");
    assert.ok(existsSync(summary.md) && existsSync(summary.json));
    assert.match(readFileSync(summary.md, "utf8"), /1\. \*\*Event discovery\*\*/);
});
test("auto-close once min_votes are in and the count settles", async () => {
    // 3 votes arrive, then nothing changes: after settle_seconds (20s) at 5s ticks we close.
    const h = harness([votes(1), votes(3), votes(3), votes(3), votes(3), votes(3), votes(3)]);
    const { records } = await h.runner.run(request);
    assert.equal(records[0]?.closed_by, "settled");
    assert.deepEqual(h.mcp.closed, ["polly_closedloop_sync_12_priorities"]);
    assert.ok(h.mcp.reads >= 6 && h.mcp.reads <= 8, `reads=${h.mcp.reads}`);
});
test("re-running the same request reuses the sent poll instead of creating another", async () => {
    const h = harness([{ ...votes(4), status: "closed" }]);
    await h.runner.run(request);
    const again = await h.runner.send(request);
    assert.equal(h.mcp.created.length, 1);
    assert.equal(again[0]?.status, "closed");
});
test("a failed send is recorded, does not throw, and can be retried", async () => {
    const h = harness([{ ...votes(3), status: "closed" }], { failCreate: new PollyToolError("draft_polly", "plan limit") });
    const records = await h.runner.send(request);
    assert.equal(records[0]?.status, "failed");
    assert.match(records[0]?.error ?? "", /plan limit/);
    assert.equal(h.store.read("sync_12", "priorities")?.status, "failed");
});
test("timeout closes and finalizes with whatever came in", async () => {
    const h = harness([votes(1)]);
    const { records } = await h.runner.run({ ...request, polls: [{ ...request.polls[0], min_votes: 5, close_after_minutes: 1 }] });
    assert.equal(records[0]?.closed_by, "timeout");
    assert.equal(records[0]?.votes, 1);
    assert.equal(h.mcp.closed.length, 1);
});
test("already-sent recovery parses Polly's message", () => {
    assert.deepEqual(parseAlreadySent('This draft was already sent — edit the polly itself with update_polly, passing id: "abc123" and type: "poll".'), { id: "abc123", type: "poll" });
    assert.equal(parseAlreadySent("something else"), undefined);
});
test("manual close finalizes and posts", async () => {
    const h = harness([votes(2), votes(2), votes(2), votes(2), votes(2), votes(2), votes(2), votes(2)]);
    await h.runner.send(request);
    const closed = await h.runner.close("sync_12", "priorities");
    assert.equal(closed.closed_by, "manual");
    assert.equal(closed.votes, 2);
    assert.equal(h.posted.length, 1);
});
test("DM delivery hands Polly the roster people instead of the channel", async () => {
    const h = harness([{ ...votes(1), status: "closed" }]);
    const dmRequest = parsePollRequest({
        meeting_id: "CL-sync-06",
        channel: "#closed-loop-project",
        required_attendees: ["obaid", "zaid", "nouman", "sharjeel"],
        roster: { zaid: { email: "zaid@example.com" } },
        gaps: [{ gap_id: "CL-A-08.due", field: "due_date", ask: "When is it due?", options: ["Fri", "Sat", "No date needed"], audience: ["zaid"] }],
    });
    await h.runner.run(dmRequest);
    assert.deepEqual(h.mcp.created[0]?.audience, { emails: ["zaid@example.com"], ids: [], names: [] });
    assert.equal(h.store.read("CL-sync-06", "CL-A-08.due")?.delivery, "dm");
});
