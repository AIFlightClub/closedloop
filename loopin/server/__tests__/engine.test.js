import test from "node:test";
import assert from "node:assert/strict";
import { Engine, reconcileRoster } from "../../shared/engine.js";
const people = ["Obaid", "Zaid", "Nouman", "Sharjeel"].map((name) => ({
  id: name.toLowerCase(),
  name,
}));
function setup() {
  let time = 0;
  const e = new Engine(
    {
      meeting: {
        id: "m",
        title: "ClosedLoop Sync",
        startedAt: "2026-09-12T09:00:00Z",
        scheduledEndAt: "2026-09-12T09:30:00Z",
        timezone: "Asia/Karachi",
      },
      required: people,
      agenda: [
        {
          id: "a",
          label: "RTMS entitlement",
          keywords: ["rtms", "entitlement"],
        },
      ],
    },
    { now: () => time },
  );
  e.roster(people.slice(0, 3));
  return {
    e,
    at: (t) => {
      time = t;
      e.tick();
    },
  };
}
const action = {
  actionId: "a1",
  item: "Prepare the launch review",
  owner: null,
  due: "2026-09-18",
  evidence: "We should prepare the launch review by Friday.",
};
test("owner grace is 60 seconds and repeated extraction does not reset it", () => {
  const { e, at } = setup();
  e.extract(action);
  at(59000);
  e.extract(action);
  assert.equal(e.state.activeLoopId, null);
  at(60000);
  assert.equal(e.state.loops[0].kind, "owner_missing");
  assert.equal(e.state.activeLoopId, "L-01");
});
test("verbal owner during grace prevents a card", () => {
  const { e, at } = setup();
  e.extract(action);
  at(20000);
  e.extract({ ...action, owner: "zaid" });
  at(60000);
  assert.equal(e.state.activeLoopId, null);
  assert.equal(e.state.loops[0].resolution.source, "verbal");
});
test("both missing produces separate linked gaps and cooldown holds the second", () => {
  const { e, at } = setup();
  e.extract({ ...action, due: null });
  at(60000);
  assert.equal(e.state.loops.length, 2);
  e.command(
    { type: "dismiss", loopId: "L-01" },
    { id: "obaid", role: "organizer" },
  );
  at(359999);
  assert.equal(e.state.activeLoopId, null);
  at(360000);
  assert.equal(e.state.activeLoopId, "L-02");
});
test("poll majority closes and late votes cannot change verbal resolution", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  const host = { id: "obaid", role: "organizer" };
  e.command(
    {
      type: "send",
      loopId: "L-01",
      audience: ["obaid", "zaid", "nouman"],
      question: "Who owns this?",
      requestId: "r",
    },
    host,
  );
  const poll = e.state.loops[0].poll;
  e.command(
    { type: "vote", loopId: "L-01", pollId: poll.id, optionId: "person:zaid" },
    { id: "nouman", role: "attendee" },
  );
  e.extract({ ...action, owner: "obaid" });
  assert.equal(poll.status, "superseded");
  assert.throws(
    () =>
      e.command(
        {
          type: "vote",
          loopId: "L-01",
          pollId: poll.id,
          optionId: "person:zaid",
        },
        { id: "zaid", role: "attendee" },
      ),
    /active/,
  );
  assert.equal(e.state.loops[0].resolution.label, "Obaid");
});
test("attendee projection has no transcript, dashboard, roster or other votes", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "send", loopId: "L-01", audience: ["zaid"], requestId: "r" },
    { id: "obaid", role: "organizer" },
  );
  const view = e.view({ id: "zaid", role: "attendee" });
  assert.ok(view.prompt);
  for (const k of ["loops", "people", "agenda", "evidence"])
    assert.equal(view[k], undefined);
  assert.throws(
    () =>
      e.command(
        { type: "dismiss", loopId: "L-01" },
        { id: "zaid", role: "attendee" },
      ),
    /organizer/,
  );
});
test("escape choice defers rather than claiming an owner", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "send", loopId: "L-01", audience: ["zaid"], requestId: "r" },
    { id: "obaid", role: "organizer" },
  );
  e.command(
    {
      type: "vote",
      loopId: "L-01",
      pollId: e.state.loops[0].poll.id,
      optionId: "undecided",
    },
    { id: "zaid", role: "attendee" },
  );
  assert.equal(e.state.loops[0].status, "deferred");
  assert.equal(e.state.loops[0].resolution, undefined);
});
test("email first, unique names second; ambiguous names remain unmatched", () => {
  const r = reconcileRoster(
    [{ id: "z", name: "Zaid", email: "z@a.test" }],
    [{ id: "x", name: "Other", email: "Z@a.test" }],
  );
  assert.equal(r.absent.length, 0);
  assert.equal(
    reconcileRoster(
      [{ id: "z", name: "Zaid" }],
      [
        { id: "a", name: "Zaid" },
        { id: "b", name: "Zaid" },
      ],
    ).absent.length,
    1,
  );
});
test("agenda requires sustained evidence and respects manual override", () => {
  const { e, at } = setup();
  e.topic("RTMS entitlement");
  at(20000);
  e.topic("RTMS entitlement");
  at(45000);
  e.topic("RTMS entitlement");
  assert.equal(e.state.agenda[0].status, "current");
  at(80000);
  assert.equal(e.state.agenda[0].status, "covered");
  e.command(
    { type: "agenda", id: "a", status: "uncovered" },
    { id: "obaid", role: "organizer" },
  );
  e.topic("RTMS entitlement");
  at(140000);
  assert.equal(e.state.agenda[0].status, "uncovered");
});
test("scheduled end is mandatory", () =>
  assert.throws(() => new Engine({ meeting: { id: "x" } }), /scheduledEndAt/));
test("majority uses frozen audience, validates options and counts one vote per person", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  const c = {
    type: "send",
    loopId: "L-01",
    audience: ["obaid", "zaid", "nouman"],
    requestId: "r",
  };
  e.command(c, { id: "obaid", role: "organizer" });
  const p = e.state.loops[0].poll;
  e.command(c, { id: "obaid", role: "organizer" });
  assert.equal(e.state.loops[0].poll.id, p.id);
  const vote = {
    type: "vote",
    loopId: "L-01",
    pollId: p.id,
    optionId: "person:zaid",
  };
  assert.throws(
    () => e.command(vote, { id: "sharjeel", role: "attendee" }),
    /audience/,
  );
  e.command(vote, { id: "zaid", role: "attendee" });
  e.command(vote, { id: "zaid", role: "attendee" });
  assert.equal(p.responses.length, 1);
  e.roster(people.slice(0, 2));
  e.command(vote, { id: "obaid", role: "organizer" });
  assert.equal(e.state.loops[0].status, "closed");
});
test("three surfaced cards per rolling thirty minutes", () => {
  const { e, at } = setup();
  for (let i = 0; i < 4; i++) {
    e.extract({ ...action, actionId: "a" + i, item: "Task " + i });
    at(60000 + i * 360000);
    if (i < 3)
      e.command(
        { type: "dismiss", loopId: "L-0" + (i + 1) },
        { id: "obaid", role: "organizer" },
      );
  }
  assert.equal(e.state.activeLoopId, null);
  at(1860001);
  assert.equal(e.state.activeLoopId, "L-04");
});
test("timeout stays unresolved and organizer can review and resolve it", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "send", loopId: "L-01", audience: ["zaid"], requestId: "r" },
    { id: "obaid", role: "organizer" },
  );
  at(180000);
  assert.equal(e.state.loops[0].status, "deferred");
  assert.equal(e.state.health, "open");
  e.command(
    { type: "review", loopId: "L-01" },
    { id: "obaid", role: "organizer" },
  );
  e.command(
    { type: "resolve", loopId: "L-01", optionId: "person:zaid" },
    { id: "obaid", role: "organizer" },
  );
  assert.equal(e.state.loops[0].status, "closed");
});
test("verbal commitment can resolve a deferred escape answer", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "resolve", loopId: "L-01", optionId: "undecided" },
    { id: "obaid", role: "organizer" },
  );
  e.extract({ ...action, owner: "zaid" });
  assert.equal(e.state.loops[0].status, "closed");
});
test("poll outcome is retained in known action context", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "resolve", loopId: "L-01", optionId: "person:zaid" },
    { id: "obaid", role: "organizer" },
  );
  assert.equal(e.actions.get("a1").owner, "zaid");
});
test("date choices use the actual live date when service starts after meeting start", () => {
  const now = Date.parse("2026-09-13T01:00:00Z");
  const e = new Engine(
    {
      meeting: {
        id: "m",
        title: "Meeting",
        startedAt: "2026-09-12T09:00:00Z",
        scheduledEndAt: "2026-09-13T02:00:00Z",
        timezone: "Asia/Karachi",
      },
      required: people,
    },
    { now: () => now },
  );
  e.roster(people);
  e.extract({ ...action, owner: "zaid", due: null });
  assert.equal(e.state.loops[0].options[0].value, "2026-09-14");
});
test("unmapped participants are shown but cannot be put in a poll audience", () => {
  const { e, at } = setup();
  e.roster([
    ...people.slice(0, 3),
    { id: "guest", name: "Guest", canVote: false },
  ]);
  e.extract(action);
  at(60000);
  assert.throws(
    () =>
      e.command(
        { type: "send", loopId: "L-01", audience: ["guest"] },
        { id: "obaid", role: "organizer" },
      ),
    /audience/,
  );
});
test("organizer sees aggregate responses and their own vote, not other voter identities", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "send", loopId: "L-01", audience: ["obaid", "zaid", "nouman"] },
    { id: "obaid", role: "organizer" },
  );
  e.command(
    {
      type: "vote",
      loopId: "L-01",
      pollId: e.state.loops[0].poll.id,
      optionId: "person:zaid",
    },
    { id: "nouman", role: "attendee" },
  );
  const v = e.view({ id: "obaid", role: "organizer" });
  assert.equal(v.loops[0].poll.responses[0].personId, undefined);
  assert.equal(v.loops[0].poll.myResponse, null);
});
test("a majority waits for speech already being extracted so verbal resolution wins", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "send", loopId: "L-01", audience: ["zaid"] },
    { id: "obaid", role: "organizer" },
  );
  e.evidenceVersion = 1;
  e.command(
    {
      type: "vote",
      loopId: "L-01",
      pollId: e.state.loops[0].poll.id,
      optionId: "person:zaid",
    },
    { id: "zaid", role: "attendee" },
  );
  assert.equal(e.state.loops[0].status, "awaiting");
  e.extract({ ...action, owner: "obaid" });
  e.processedVersion = 1;
  e.tick();
  assert.equal(e.state.loops[0].resolution.source, "verbal");
});
test("a held majority closes after speech is processed without a verbal resolution", () => {
  const { e, at } = setup();
  e.extract(action);
  at(60000);
  e.command(
    { type: "send", loopId: "L-01", audience: ["zaid"] },
    { id: "obaid", role: "organizer" },
  );
  e.evidenceVersion = 1;
  e.command(
    {
      type: "vote",
      loopId: "L-01",
      pollId: e.state.loops[0].poll.id,
      optionId: "person:zaid",
    },
    { id: "zaid", role: "attendee" },
  );
  e.processedVersion = 1;
  e.tick();
  assert.equal(e.state.loops[0].resolution.source, "poll");
});
