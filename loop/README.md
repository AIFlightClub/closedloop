# Loop module — notes → survey → results → enriched notes

The part of ClosedLoop that runs after (and during) the meeting. It sits on
Zaid's RTMS server (`index.js`) and the Polly module (`polly/`):

```
meeting.rtms_started ─► live detector watches the transcript
                          └─ "let's poll this" / A-or-B with no call / no owner ─► quick poll in Slack (Polly)
meeting.rtms_stopped ─► generate-notes.js (skill 1, Codex) ─► notes/<id>.md + <id>.loop.json
                          └─ notes.ready ─► survey built from decisions + gaps + open items (skill 2 shape)
                                             └─ polly.run(): posted in #closed-loop-project, watched until it closes
                                                └─ results.ready (poll_round.json)
                                                   └─ skill 1 Enrich mode (Codex) ─► notes rewritten, previous kept as .v1
                                                      └─ notes.enriched
```

Every arrow on the right is a callback to the Slack lane — see
[CALLBACK.md](CALLBACK.md). The Slack app builds the canvas; nothing here posts
to Slack except the Polly survey/polls themselves.

## Files

| File | Role |
|---|---|
| `index.js` | `createLoop({ polly, port })` → `{ router, run, afterNotes, live, demo, close, status }` |
| `run.js` | the state machine (stages in `data/meetings.json` → `loop`), `demo()` from a transcript file |
| `survey-builder.js` | deterministic survey from notes + loop state (skill 2's fixed shape); optional Codex builder |
| `enrich.js` | skill 1 Enrich mode through Codex; keeps `.vN` copies of notes + loop state |
| `live.js` | rolling-window trigger + Codex (or heuristic) extractor → one quick poll, cooldown + cap |
| `callback.js` | signed webhook + `data/events.jsonl` |
| `codex.js` | one `codex exec` with an output schema (shared with `generate-notes.js`) |
| `router.js` | HTTP surface at `/loop` |
| `cli.js` / `receiver.js` | terminal driver / dev callback receiver |

## HTTP

```
GET  /loop                      meetings + stage
GET  /loop/:id                  status, files, urls, live polls
GET  /loop/:id/notes.md | loop.json | transcript.txt | poll_round.json | summary.md | survey-request.json | events
POST /loop/:id/run    {"from":"all|notes|survey|enrich"}   survey = a new round (re-asks what is still open)
POST /loop/:id/close            close the survey + open polls now → results + enrichment follow
POST /loop/:id/live   {"speaker":"Obaid","text":"let's take a quick poll…"}
POST /loop/demo       {"transcript":"demo/transcripts/sync-07-2026-09-12.txt","live":true,"speed_ms":300}
```

`:id` is the RTMS stream id (Zaid's `meeting_id`). The Polly results store uses
the same id sanitized to `[A-Za-z0-9._-]` (`loop.polly_meeting_id`).

## Running it

```bash
npm install
npm run polly:auth                          # once: Polly MCP token
cp .env.example .env                        # Zoom + LOOP_CALLBACK_URL + PUBLIC_BASE_URL (ngrok)
npm start                                   # one process: Zoom webhook, /polls, /loop
```

Codex: the ChatGPT desktop app's bundled CLI is used automatically when present
(`/Applications/ChatGPT.app/Contents/Resources/codex`), else `codex` on PATH or
`CODEX_BIN`. It must be logged in (`codex login status`).

Demo without Zoom (recorded fallback):

```bash
npm run loop:receiver                       # optional: see the callbacks
npm run loop -- demo demo/transcripts/sync-07-2026-09-12.txt --live --speed-ms=300 --wait
npm run loop -- close <meeting_id>          # don't wait for the survey to settle
npm run loop -- run <meeting_id> --from=survey   # ask again (round 2) for what is still open
```

## Timing knobs (`.env`)

`LOOP_SURVEY_CLOSE_AT=+30m` (Polly closes it), `LOOP_SURVEY_MIN_VOTES=1` +
`LOOP_SURVEY_SETTLE_SECONDS=90` (auto-close once votes settle),
`LOOP_LIVE_COOLDOWN_SECONDS=120`, `LOOP_LIVE_MAX_POLLS=3`,
`LOOP_LIVE_POLL_MINUTES=5`. `LOOP_SURVEY_BUILDER=codex` runs
`skills/meeting-loop-polly.md` through Codex instead of the local builder.
`LOOP_LIVE_EXTRACTOR=heuristic` avoids Codex for live polls (explicit "A or B"
requests only).

## Tests

```bash
npm test                                    # polly + loop suites (no network, no Codex)
```
