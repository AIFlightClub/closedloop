import test from "node:test";
import assert from "node:assert/strict";
import { createDetector, validateExtraction } from "../detector.js";
import { Engine } from "../../shared/engine.js";
import config from "../../fixtures/config.json" with { type: "json" };
test("strict extraction rejects unsupported owners, invented evidence and invalid dates", () => {
  const a = {
    actionId: "x",
    item: "Review",
    owner: null,
    due: null,
    evidence: "We should review.",
  };
  const window = [{ text: a.evidence }];
  assert.equal(validateExtraction(a, window, config.required).item, "Review");
  assert.throws(() =>
    validateExtraction({ ...a, owner: "invented" }, window, config.required),
  );
  assert.throws(() =>
    validateExtraction({ ...a, evidence: "not said" }, window, config.required),
  );
  assert.throws(() =>
    validateExtraction({ ...a, due: "next sprint" }, window, config.required),
  );
});
test("detector queues evidence during extraction and retains known action identity", async () => {
  let now = 0;
  const e = new Engine(config, { now: () => now });
  e.roster(config.required);
  const calls = [];
  const d = createDetector(e, {
    extractor: async (input) => {
      calls.push(input);
      return [
        {
          actionId: "review",
          item: "Review launch",
          owner: null,
          due: "2026-09-18",
          evidence: "We should review launch by Friday.",
        },
      ];
    },
    now: () => now,
  });
  await d.push({
    speaker: "Obaid",
    text: "We should review launch by Friday.",
  });
  assert.equal(e.state.loops.length, 1);
  now = 61000;
  e.tick();
  assert.equal(e.state.activeLoopId, "L-01");
  await d.push({ speaker: "Zaid", text: "I will take review launch." });
  assert.equal(calls[1].actions[0].actionId, "review");
});
test("in-flight extraction coalesces queued transcript windows", async () => {
  const e = new Engine(config);
  e.roster(config.required);
  let release;
  const gate = new Promise((r) => (release = r));
  const spans = [];
  const d = createDetector(e, {
    extractor: async (i) => {
      spans.push(i.transcript);
      if (spans.length === 1) await gate;
      return [];
    },
  });
  const first = d.push({ speaker: "Obaid", text: "We should review." });
  await new Promise((r) => setImmediate(r));
  for (let n = 0; n < 15; n++)
    d.push({ speaker: "Zaid", text: "We should review " + n });
  release();
  await first;
  await d.flush();
  assert.equal(spans.length, 2);
  assert.equal(spans[1].at(-1).text, "We should review 14");
});
