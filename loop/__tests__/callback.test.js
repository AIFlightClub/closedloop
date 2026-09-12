import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNotifier, sign } from "../callback.js";

test("notifier: signs, retries once on 500, records every event", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-cb-"));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: calls.length > 1, status: calls.length > 1 ? 200 : 500 };
  };
  const notifier = createNotifier({ url: "http://receiver.test/closedloop", secret: "s3cret", log: () => {}, eventsPath: join(dir, "events.jsonl"), fetchImpl, backoffMs: 0 });
  const outcome = await notifier.notify("notes.ready", { meeting_id: "m1", notes_markdown: "# hi", summary: "notes ready" });
  assert.deepEqual({ delivered: outcome.delivered, status: outcome.status, attempts: outcome.attempts }, { delivered: true, status: 200, attempts: 2 });
  assert.equal(calls.length, 2);
  const { init } = calls[1];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["X-ClosedLoop-Event"], "notes.ready");
  assert.equal(init.headers["X-ClosedLoop-Meeting"], "m1");
  assert.equal(init.headers["X-ClosedLoop-Signature"], `sha256=${createHmac("sha256", "s3cret").update(init.body).digest("hex")}`);
  assert.equal(sign("s3cret", init.body), init.headers["X-ClosedLoop-Signature"]);
  const body = JSON.parse(init.body);
  assert.equal(body.event, "notes.ready");
  assert.equal(body.meeting_id, "m1");
  assert.ok(body.sent_at);
  const events = readFileSync(join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.length, 1);
  assert.equal(events[0].delivered, true);
  assert.deepEqual(notifier.events("m1").map((e) => e.event), ["notes.ready"]);
  assert.deepEqual(notifier.events("other"), []);
  await assert.rejects(() => notifier.notify("nope", { meeting_id: "m1" }), /unknown loop event/);
});

test("notifier: no URL → logged only, 4xx → no retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "loop-cb-"));
  let logged = "";
  const quiet = createNotifier({ log: (l) => (logged = l), eventsPath: join(dir, "events.jsonl") });
  const skipped = await quiet.notify("survey.sent", { meeting_id: "m2" });
  assert.equal(skipped.skipped, true);
  assert.match(logged, /no LOOP_CALLBACK_URL/);
  let calls = 0;
  const bad = createNotifier({ url: "http://x", log: () => {}, eventsPath: join(dir, "events.jsonl"), fetchImpl: async () => { calls++; return { ok: false, status: 404 }; }, backoffMs: 0 });
  const outcome = await bad.notify("results.ready", { meeting_id: "m2" });
  assert.equal(outcome.delivered, false);
  assert.equal(calls, 1);
  assert.equal(quiet.events("m2").length, 2);
});
