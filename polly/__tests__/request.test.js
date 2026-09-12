import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { draftIdFor, parsePollRequest, resolveAudience, resolveDelivery, toPollyQuestion } from "../src/request.js";
const example = JSON.parse(readFileSync(new URL("../examples/poll-request.json", import.meta.url), "utf8"));
test("the example request parses with defaults filled in", () => {
    const request = parsePollRequest(example);
    assert.equal(request.meeting_id, "sync_12");
    assert.equal(request.channel, "#closed-loop-project");
    assert.equal(request.polls.length, 2);
    const [priorities, owner] = request.polls;
    assert.equal(priorities?.kind, "ranked");
    assert.equal(priorities?.settle_seconds, 30);
    assert.equal(priorities?.auto_close, true);
    assert.equal(owner?.kind, "single");
    assert.equal(owner?.close_after_minutes, 10);
    assert.equal(owner?.settle_seconds, 30);
    assert.deepEqual(owner?.meta, { action_id: "a_analytics_dashboard" });
});
test("single-poll shorthand and channel default", () => {
    const request = parsePollRequest({ meeting_id: "m1", id: "q", question: "Yes or no?", kind: "yes_no" }, { channel: "#closed-loop-project" });
    assert.equal(request.channel, "#closed-loop-project");
    assert.equal(request.polls[0]?.id, "q");
    assert.equal(request.polls[0]?.kind, "yes_no");
    assert.throws(() => parsePollRequest({ meeting_id: "m1", id: "q", question: "?", kind: "yes_no" }), /channel missing/);
});
test("validation: options, ids, uniqueness", () => {
    assert.throws(() => parsePollRequest({ meeting_id: "m", channel: "#c", polls: [{ id: "a", question: "q", options: ["one"] }] }), /at least 2 options/);
    assert.throws(() => parsePollRequest({ meeting_id: "m", channel: "#c", polls: [{ id: "bad id!", question: "q", options: ["a", "b"] }] }), /letters, digits/);
    assert.throws(() => parsePollRequest({ meeting_id: "m", channel: "#c", polls: [{ id: "a", question: "q", options: ["x", "X"] }] }), /unique/);
    assert.throws(() => parsePollRequest({ meeting_id: "m", channel: "#c", polls: [{ id: "a", question: "q", options: ["x", "y"] }, { id: "a", question: "q2", options: ["x", "y"] }] }), /poll ids must be unique/);
    assert.throws(() => parsePollRequest({ meeting_id: "m", channel: "#c", polls: [] }), /polls/);
});
test("kind → Polly question type", () => {
    const base = { id: "x", question: "q", options: ["a", "b", "c"], close_after_minutes: 15, min_votes: 1, settle_seconds: 30, auto_close: true, anonymous: false, audience: [], delivery: "auto", meta: {} };
    assert.deepEqual(toPollyQuestion({ ...base, kind: "ranked" }), { type: "ranked", options: ["a", "b", "c"], rankCount: 3 });
    assert.deepEqual(toPollyQuestion({ ...base, kind: "single" }), { type: "multipleChoice", options: ["a", "b", "c"] });
    assert.deepEqual(toPollyQuestion({ ...base, kind: "multiple" }), { type: "multipleChoice", options: ["a", "b", "c"], allowMultipleAnswers: true });
    assert.deepEqual(toPollyQuestion({ ...base, kind: "yes_no", options: [] }), { type: "yesNo" });
    assert.deepEqual(toPollyQuestion({ ...base, kind: "open", options: [] }), { type: "openEnded" });
});
test("draft ids are stable and Polly-safe", () => {
    assert.equal(draftIdFor("sync_12", "priorities"), "closedloop_sync_12_priorities");
    assert.match(draftIdFor("a.b", "c d"), /^[A-Za-z0-9_-]+$/);
});
test("loop-state gaps (meeting-notes skill output) become single-choice polls with delivery by audience", () => {
    const request = parsePollRequest({
        meeting_id: "CL-sync-06",
        required_attendees: ["obaid", "zaid", "nouman", "sharjeel"],
        roster: { zaid: { email: "zaid@example.com" }, nouman: { slack_id: "U0C09GK0UAZ" } },
        gaps: [
            { gap_id: "CL-Q-03.decision", field: "decision", ask: "Demo on live RTMS or the recorded fallback?", options: ["Live RTMS — go for it", "Recorded fallback — play it safe", "Decide Saturday morning once entitlement is known"], audience: ["obaid", "zaid", "nouman", "sharjeel"], rounds_asked: 0 },
            { gap_id: "CL-A-08.due", item: "Intervention cooldown logic", field: "due_date", ask: "When is the intervention cooldown logic due?", options: ["Fri 11 Sep", "Sat 12 Sep — before the demo", "After the hackathon", "No date needed"], audience: ["zaid"], rounds_asked: 0 },
        ],
    }, { channel: "#closed-loop-project" });
    assert.equal(request.channel, "#closed-loop-project");
    assert.equal(request.polls.length, 2);
    const [decision, due] = request.polls;
    assert.equal(decision?.id, "CL-Q-03.decision");
    assert.equal(decision?.kind, "single");
    assert.equal(decision?.question, "Demo on live RTMS or the recorded fallback?");
    assert.deepEqual(decision?.audience, ["obaid", "zaid", "nouman", "sharjeel"]);
    assert.equal(due?.context, "Intervention cooldown logic — due date");
    assert.deepEqual(due?.meta, { gap_id: "CL-A-08.due", item: "Intervention cooldown logic", field: "due_date", audience: ["zaid"], rounds_asked: 0 });
    assert.equal(resolveDelivery("auto", decision.audience, request.required_attendees), "channel");
    assert.equal(resolveDelivery("auto", due.audience, request.required_attendees), "dm");
    assert.equal(resolveDelivery("channel", due.audience, request.required_attendees), "channel");
    assert.deepEqual(resolveAudience(["zaid", "nouman", "obaid"], request.roster), { emails: ["zaid@example.com"], ids: ["U0C09GK0UAZ"], names: ["obaid"] });
    assert.equal(draftIdFor("CL-sync-06", "CL-A-08.due"), "closedloop_CL-sync-06_CL-A-08_due");
});
