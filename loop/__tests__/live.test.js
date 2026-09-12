import assert from "node:assert/strict";
import test from "node:test";
import { classifyTrigger, createLiveDetector, heuristicExtractor } from "../live.js";

class FakePolly {
  runs = [];
  async run(raw, hooks = {}) {
    this.runs.push(raw);
    const poll = raw.polls[0];
    const record = { id: poll.id, meeting_id: raw.meeting_id, kind: poll.kind, question: poll.question, options: poll.options, status: "open", votes: 0, choices: [], ranking: [], meta: poll.meta, polly: { id: `p${this.runs.length}`, type: "poll", sent_at: "2026-09-12T05:00:00Z" } };
    await hooks.onSent?.([record]);
    const closed = { ...record, status: "closed", votes: 3, closed_at: "2026-09-12T05:05:00Z", ranking: poll.options.map((o, i) => ({ rank: i + 1, option: o, score: i === 0 ? 2 : i === 1 ? 1 : 0 })) };
    return { records: [closed], summary: {} };
  }
}

test("triggers: explicit poll requests vs heuristic decision/owner questions", () => {
  assert.equal(classifyTrigger("Let's take a quick poll on it: open on Zoom or on the canvas?"), "explicit");
  assert.equal(classifyTrigger("Fine, poll it."), "explicit");
  assert.equal(classifyTrigger("Let's vote."), "explicit");
  assert.equal(classifyTrigger("Should we post on LinkedIn or on X?"), "heuristic");
  assert.equal(classifyTrigger("Who is going to own the README update?"), "heuristic");
  assert.equal(classifyTrigger("Which option do you prefer?"), "heuristic");
  assert.equal(classifyTrigger("Entitlement is confirmed, credits are on the account."), null);
  assert.equal(classifyTrigger("the poll closes in thirty minutes"), null);
});

test("detector: explicit trigger → one live poll with role live; cooldown and dedupe hold", async () => {
  let clock = 1_000_000;
  const now = () => clock;
  const polly = new FakePolly();
  const events = [];
  const extract = async ({ trigger, window }) => ({ fire: true, reason: `${trigger}`, question: "Open the demo on Zoom or on the Slack canvas?", kind: "single", options: ["Zoom first", "Canvas first"], item: "Demo opening", field: "decision", window });
  const detector = createLiveDetector({ meetingId: "s1", pollyMeetingId: "s1", channel: "#closed-loop-project", title: "Sync", polly, extract, notify: async (event, payload) => events.push([event, payload.poll.id]), now, sleep: async () => {}, options: { cooldownSeconds: 120, maxPolls: 3, debounceMs: 0, settleSeconds: 10, pollMinutes: 4 } });
  assert.equal(detector.push({ speaker: "Obaid", text: "Should we open on Zoom or on the canvas?" }), "heuristic");
  assert.equal(detector.push({ speaker: "Obaid", text: "Let's take a quick poll on it." }), "busy");
  await detector.idle();
  await detector.drain();
  assert.equal(polly.runs.length, 1);
  const raw = polly.runs[0];
  assert.equal(raw.meeting_id, "s1");
  assert.equal(raw.channel, "#closed-loop-project");
  assert.equal(raw.polls[0].id, "live-1");
  assert.equal(raw.polls[0].delivery, "channel");
  assert.equal(raw.polls[0].close_after_minutes, 4);
  assert.deepEqual(raw.polls[0].options, ["Zoom first", "Canvas first", "Decide at the next sync"]);
  assert.equal(raw.polls[0].meta.role, "live");
  assert.equal(raw.polls[0].meta.gap_id, "live-1");
  assert.deepEqual(events, [["live.poll_sent", "live-1"], ["live.poll_closed", "live-1"]]);
  const state = detector.state();
  assert.equal(state.polls[0].status, "closed");
  assert.equal(state.polls[0].result.resolution, "filled");
  assert.equal(state.polls[0].result.winning_option, "Zoom first");
  // Inside the cooldown: nothing fires.
  clock += 30_000;
  assert.equal(detector.push({ speaker: "Zaid", text: "Should we post on LinkedIn or on X?" }), "cooldown");
  // After the cooldown the same question is not asked twice.
  clock += 120_000;
  assert.equal(detector.push({ speaker: "Zaid", text: "Let's poll that again." }), "explicit");
  await detector.idle();
  assert.equal(polly.runs.length, 1);
  assert.equal(detector.state().skipped.duplicate, 1);
  detector.stop();
  assert.equal(detector.push({ speaker: "Zaid", text: "let's vote" }), null);
});

test("detector: extractor declining or failing sends nothing; heuristics can be turned off", async () => {
  const polly = new FakePolly();
  let calls = 0;
  const extract = async () => { calls++; if (calls === 1) return { fire: false, reason: "already decided" }; throw new Error("boom"); };
  const detector = createLiveDetector({ meetingId: "s2", channel: "#c", polly, extract, now: () => 5, sleep: async () => {}, options: { debounceMs: 0, cooldownSeconds: 0, heuristics: false } });
  assert.equal(detector.push({ speaker: "A", text: "Who is going to own this?" }), null, "heuristics off");
  assert.equal(detector.push({ speaker: "A", text: "let's vote" }), "explicit");
  await detector.idle();
  assert.equal(detector.push({ speaker: "A", text: "quick poll please" }), "explicit");
  await detector.idle();
  assert.equal(polly.runs.length, 0);
  assert.deepEqual(detector.state().skipped, { cooldown: 0, max: 0, declined: 1, duplicate: 0, failed: 1 });
});

test("heuristic extractor: explicit A-or-B request becomes a two-option poll", async () => {
  const extract = heuristicExtractor();
  const lines = [{ speaker: "Obaid", text: "Let's take a quick poll on it: open on Zoom or open on the Slack canvas?" }];
  const decision = await extract({ lines, trigger: "explicit" });
  assert.equal(decision.fire, true);
  assert.deepEqual(decision.options, ["open on Zoom", "open on the Slack canvas"]);
  assert.equal((await extract({ lines, trigger: "heuristic" })).fire, false);
});
