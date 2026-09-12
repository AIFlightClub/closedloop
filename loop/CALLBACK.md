# Loop → Slack lane: the callback contract

The server tells the Slack app what happened after every stage of a meeting by
`POST`ing JSON to `LOOP_CALLBACK_URL`. Nothing is posted to Slack from here —
the Slack app owns the canvas.

```
POST <LOOP_CALLBACK_URL>
Content-Type: application/json
X-ClosedLoop-Event: notes.ready
X-ClosedLoop-Meeting: <meeting_id>
X-ClosedLoop-Signature: sha256=<hex HMAC-SHA256 of the raw body, key = LOOP_CALLBACK_SECRET>   (only when the secret is set)
```

Reply with any 2xx. Non-2xx and timeouts (10 s) are retried 3× (1.5 s, 3 s
backoff); 4xx other than 408/429 is not retried. Every attempt is also appended
to `data/events.jsonl` and served at `GET /loop/:meeting_id/events`, so a
missed webhook can be replayed by re-reading the files/URLs in the payload.

## Events, in order

| Event | When | Extra fields |
|---|---|---|
| `live.poll_sent` | during the meeting: a quick poll went to the channel | `poll` {id, question, kind, options, item, field, polly{id,type,results_url,web_voting_url}} |
| `live.poll_closed` | that poll closed | `poll` (+ `result` {resolution, winning_option, counts}) |
| `notes.ready` | first notes exist (`notes/<id>.md`) → **create the canvas** | `notes_markdown`, `loop_state`, `gaps` |
| `survey.sent` | the post-meeting survey is live in the channel | `survey` {channel, question_count, fallback, pollys[{id,type,results_url,web_voting_url,close_at}]}, `question_map`, `deferred_gaps`, `escalated_gaps` |
| `survey.skipped` | nothing to ask (no decisions, gaps or ranking) | `reason` |
| `results.ready` | survey (and every live poll) closed; `poll_round.json` written | `poll_round`, `summary_markdown`, `results` {respondents, gaps_asked, filled, tie, escape_hatch, no_responses, live_polls, decisions_confirmed, …} |
| `notes.enriched` | notes rewritten with the answers → **update the canvas** | `notes_markdown`, `loop_state`, `enrichment` (same shape as `results`), `version`, `previous_versions` |
| `loop.failed` | a stage threw | `error` |

## Common envelope

```json
{
  "event": "notes.ready",
  "sent_at": "2026-09-12T10:31:04.120Z",
  "meeting_id": "<RTMS stream id — the key everywhere>",
  "series_id": "CL",
  "title": "ClosedLoop Sync",
  "meeting_date": "2026-09-12",
  "stage": "notes",
  "summary": "notes ready (5 gaps)",
  "files": { "transcript": "…/transcripts/….txt", "notes": "…/notes/<id>.md", "loop_state": "…/notes/<id>.loop.json", "survey_request": null, "poll_round": null, "summary": null },
  "urls":  { "status": "<PUBLIC_BASE_URL>/loop/<id>", "notes": "…/loop/<id>/notes.md", "loop_state": "…/loop/<id>/loop.json", "poll_round": "…/loop/<id>/poll_round.json", "summary": "…/loop/<id>/summary.md", "transcript": "…/loop/<id>/transcript.txt", "events": "…/loop/<id>/events" }
}
```

`notes_markdown` is Slack-Canvas-safe markdown (the notes skill's format:
numbered decisions and action items, one level of nesting, `**bold**`).
`loop_state` is the skill's machine-readable block (`open_items`, `gaps`, …).

## What the canvas should do

1. `notes.ready` → create the meeting canvas from `notes_markdown`.
2. `survey.sent` → optional: add a line with the voting link (`survey.pollys[0].web_voting_url`).
3. `notes.enriched` → replace the canvas body with the new `notes_markdown`
   (values filled from the poll carry the `ᵖ` mark; `enrichment.filled` /
   `enrichment.gaps_asked` say how many gaps closed).

Everything is idempotent per `meeting_id`; a re-run of a stage sends the same
event again with newer content.

## Trying it

```bash
npm run loop:receiver                 # prints + saves every callback (data/callbacks/)
# in .env: LOOP_CALLBACK_URL=http://localhost:8090/closedloop
npm start
npm run loop -- demo demo/transcripts/sync-07-2026-09-12.txt --live --wait
```
