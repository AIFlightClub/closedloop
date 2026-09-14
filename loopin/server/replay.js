import { readFileSync } from "node:fs";
import { Engine } from "../shared/engine.js";
import config from "../fixtures/config.json" with { type: "json" };
import extractions from "../fixtures/extractions.json" with { type: "json" };
import expected from "../fixtures/expected-events.json" with { type: "json" };
import { validateExtraction } from "./detector.js";
import assert from "node:assert/strict";
const transcript = readFileSync(
  new URL("../fixtures/transcript.jsonl", import.meta.url),
  "utf8",
)
  .trim()
  .split("\n")
  .map(JSON.parse);
let t = 0;
const engine = new Engine(config, { now: () => t });
engine.roster(config.required.slice(0, 3));
const events = [],
  seen = new Set();
for (t = 0; t <= 420000; t += 1000) {
  for (const entry of transcript.filter((e) => e.t === t))
    engine.topic(entry.text);
  for (const a of extractions.filter((e) => e.t === t)) {
    const { t: _, ...value } = a;
    engine.extract(
      validateExtraction(
        value,
        transcript.filter((e) => e.t <= t && t - e.t <= 90000),
        config.required,
      ),
    );
  }
  engine.tick();
  for (const loop of engine.state.loops) {
    if (loop.surfacedAt !== null && !seen.has(loop.id + "surface")) {
      seen.add(loop.id + "surface");
      events.push({ t, kind: loop.kind, event: "surfaced" });
    }
    if (loop.status === "closed" && !seen.has(loop.id + "closed")) {
      seen.add(loop.id + "closed");
      events.push({
        t,
        kind: loop.kind,
        event: "closed",
        source: loop.resolution.source,
      });
      engine.command(
        { type: "continue", loopId: loop.id },
        { id: "obaid", role: "organizer" },
      );
    }
  }
}
assert.deepEqual(events, expected);
console.log(
  JSON.stringify(
    {
      mode: "offline fixture with virtual clock",
      events,
      agenda: engine.state.agenda.map((a) => ({
        label: a.label,
        status: a.status,
      })),
    },
    null,
    2,
  ),
);
