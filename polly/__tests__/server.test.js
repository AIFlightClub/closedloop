import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResultsStore } from "../src/results.js";
import { PollRunner } from "../src/runner.js";
import { createApp, startInbox } from "../src/server.js";
import { SurveyRunner } from "../src/survey.js";
class FakePolly {
    created = [];
    reads = new Map();
    async createPoll(input) {
        this.created.push(input.draftId);
        return { id: `p_${input.draftId}`, type: "poll", alreadySent: false, raw: {} };
    }
    async getResults(id, type) {
        const n = (this.reads.get(id) ?? 0) + 1;
        this.reads.set(id, n);
        const choices = [
            { text: "A", votes: 3, percentage: 60 },
            { text: "B", votes: 2, percentage: 40 },
        ];
        return { id, type, responseCount: 5, totalVotes: 5, choices, status: n >= 2 ? "closed" : "active", raw: {} };
    }
    async closePoll() { }
    async disconnect() { }
}
function deps() {
    const dir = mkdtempSync(join(tmpdir(), "polly-server-"));
    const store = new ResultsStore(join(dir, "results"));
    const mcp = new FakePolly();
    const runner = new PollRunner({ mcp, store, pollEveryMs: 10, log: () => { } });
    const surveys = new SurveyRunner({ mcp, store, pollEveryMs: 10, log: () => { } });
    return { dir, store, mcp, runner, surveys, defaultChannel: "#closed-loop-project", log: () => { } };
}
const body = { meeting_id: "m1", polls: [{ id: "q1", kind: "single", question: "A or B?", options: ["A", "B"] }] };
const until = async (pred, ms = 2000) => {
    const start = Date.now();
    while (!pred()) {
        if (Date.now() - start > ms)
            throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 15));
    }
};
test("HTTP: POST /polls sends and watches in the background; GET reads records", async () => {
    const d = deps();
    const app = createApp(d);
    const server = app.listen(0);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    try {
        const res = await fetch(`${base}/polls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(res.status, 202);
        const accepted = (await res.json());
        assert.equal(accepted.kind, "polls");
        assert.equal(accepted.channel, "#closed-loop-project");
        assert.equal(accepted.records[0]?.status, "open");
        await until(() => d.store.read("m1", "q1")?.status === "closed");
        const record = (await (await fetch(`${base}/polls/m1/q1`)).json());
        assert.equal(record.winner, "A");
        const all = (await (await fetch(`${base}/polls/m1`)).json());
        assert.equal(all.length, 1);
        await until(() => existsSync(join(d.store.meetingDir("m1"), "summary.md")));
        const md = await (await fetch(`${base}/polls/m1/summary.md`)).text();
        assert.match(md, /A or B\?/);
        const bad = await fetch(`${base}/polls`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_id: "m2", polls: [] }) });
        assert.equal(bad.status, 400);
    }
    finally {
        server.close();
    }
});
test("inbox: a dropped file is sent, moved to done/, and rejected files go to failed/", async () => {
    const d = deps();
    const inbox = join(d.dir, "inbox");
    const stop = startInbox(d, inbox, 30);
    try {
        writeFileSync(join(inbox, "req.json"), JSON.stringify({ ...body, meeting_id: "m9" }));
        writeFileSync(join(inbox, "broken.json"), "{ not json");
        await until(() => readdirSync(join(inbox, "done")).length === 1 && readdirSync(join(inbox, "failed")).length === 1, 4000);
        await until(() => d.store.read("m9", "q1")?.status === "closed");
        assert.deepEqual(d.mcp.created, ["closedloop_m9_q1"]);
    }
    finally {
        stop();
    }
});
