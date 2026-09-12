# ClosedLoop — Polly module

Sends the polls the meeting loop asks for through **Polly's MCP server**, watches them
until they close, and hands the answers back as files for the notes-enrichment step and
the Slack-app lane (canvas). It runs **inside the main server** (`npm start`) next to the
Zoom RTMS webhook — one process, one port.

```
meeting-loop-notes ─▶ gaps ─▶ meeting-loop-polly ─▶ survey JSON + question_map
                                                          │
                              POST /polls · polly/inbox/*.json · polly.run() in-process
                                                          │
                                   Polly MCP: draft_polly → create_polly     (survey lands in Slack)
                                                          │
                                   watch get_polly_results until closed
                                                          │
   polly/results/<meeting_id>/  poll_round.json (gaps · ratification · ranking · rating)
                                summary.md · <record>.json ─▶ notes enrichment · Slack-app canvas
```

- Input contract: [INPUT.md](INPUT.md) — the skill's `create_survey` JSON + `question_map`
  (preferred), or the raw `gaps` array, or generic polls.
- Output contract: [OUTPUT.md](OUTPUT.md) — `poll_round.json` keyed by `gap_id` /
  decision id / item id, plus per-record JSON and `summary.md`.
- Examples: [examples/survey-request.json](examples/survey-request.json) (the skill's
  sync #6 worked example), [examples/gaps-request.json](examples/gaps-request.json),
  [examples/poll-request.json](examples/poll-request.json). Demo project data:
  [examples/project/](examples/project/).

## Setup (once)

```bash
nvm use                 # Node 24
npm install
cp .env.example .env    # Zoom creds for RTMS; POLLY_CHANNEL=#closed-loop-project
npm run polly:auth      # browser: sign in to Polly, click Allow → .polly-mcp-token.json
npm run polly -- tools  # should list draft_polly, create_polly, get_polly_results, close_polly, …
```

`polly:auth` is a standard OAuth PKCE flow against `app.polly.ai`; the token refreshes
itself. Polly must be installed in the Slack workspace that owns the channel, the person
authorising needs a Polly account there, and MCP access must be enabled for that org.

## Run

```bash
npm start                                                   # main server: Zoom webhook + POST /polls + inbox
npm run polly -- run polly/examples/survey-request.json     # one survey, end to end, from the CLI
npm run polly -- run polly/examples/gaps-request.json       # one poll per gap
npm run polly -- test-poll --channel=#closed-loop-project   # throwaway poll; vote once, it closes itself
```

Other commands: `send <file>`, `watch <file>` (resume after a restart), `results <meeting_id> [id]`,
`close <meeting_id> <id>`, `tools`.

## Inside the main server

`index.js` builds one Express app: the Zoom webhook is mounted with the SDK's
`createWebhookHandler` on `ZM_RTMS_PATH` (default `/`, port `ZM_RTMS_PORT`, default 8080),
so the ngrok URL registered in the Zoom app keeps working; the Polly router is mounted at
`/polls`; the inbox watcher runs alongside. `POLLY_ENABLED=false` turns the Polly half off.

From the handler code, skip HTTP entirely:

```js
import { createPolly } from "./polly/index.js";
const polly = createPolly();
await polly.accept(requestJson);          // send now, watch in the background
const { record, summary } = await polly.run(requestJson);   // or wait for the answers
```

| method | path                                  | purpose                                                   |
| ------ | ------------------------------------- | --------------------------------------------------------- |
| POST   | `/polls`                              | request JSON (survey / gaps / polls) → sends, watches (202) |
| GET    | `/polls/:meeting_id`                  | all records for the meeting                               |
| GET    | `/polls/:meeting_id/poll_round.json`  | readback for the enrich step                              |
| GET    | `/polls/:meeting_id/summary.md`       | Markdown summary                                          |
| GET    | `/polls/:meeting_id/:id`              | one record (live counts while open)                       |
| POST   | `/polls/:meeting_id/:id/close`        | close now + finalize (surveys: send the request JSON as body) |
| GET    | `/polls/health`                       | liveness                                                  |

## Polly plan note

Multi-question pollys (surveys) are a premium Polly type. If the org is on the Free plan,
`create_polly` refuses the survey with a plan-limit message; the module records that on the
survey record and, unless `fallback_to_polls: false`, **automatically sends one
single-question polly per readable question instead** — the gap questions, the decision
ratification (multi-select) and the priority ranking, with the same roles in `meta` — so
`poll_round.json` reads back identically (`fallback: true` marks it). Rating and open-ended
questions are dropped in that mode. Lifting the org's plan makes the real survey go out.

## How closing works

A survey/poll closes on the first of: Polly's own `closeAt`, auto-close (at least
`min_votes` respondents and no new response for `settle_seconds`), a manual close, or a
timeout. Closing finalises the record and writes `poll_round.json` + `summary.md`.

## Safety properties

- **No duplicates.** The survey's `draftId` (or each poll's `id`) is the Polly draft id;
  re-running a request reuses what was already sent, even after a crash.
- **Resumable.** Records are persisted on every read; `watch <file>` picks up open ones.
- **Files are the interface.** Plain JSON + Markdown on disk; nothing else has to be
  running to read them. Nothing is posted to Slack by this module (opt-in only via
  `POLLY_POST_RESULTS=true` + `SLACK_BOT_TOKEN`).

## Layout

```
polly/
  index.js            createPolly(): router, inbox, run/accept — the entry point for index.js and the handler
  src/mcp.js          Polly MCP client (draft_polly → create_polly → get_polly_results → close_polly)
  src/oauth.js        PKCE public-client flow + token refresh
  src/survey.js       survey request (skill JSON + question_map), readback per role, SurveyRunner
  src/request.js      gaps / generic polls input schema
  src/runner.js       per-poll send / watch / finalize
  src/results.js      records, ranking, gap resolution, poll_round, JSON + Markdown files
  src/server.js       Express router (/polls) + inbox watcher
  src/slack.js        optional results message
  src/cli.js          commands
  __tests__/          node:test suites — npm run test:polly
```
