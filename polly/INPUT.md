# Polly module — how we receive poll requests

The processing side hands the Polly module **one JSON document per meeting**. Three ways to
deliver it, same content:

| way        | how                                                                   |
| ---------- | --------------------------------------------------------------------- |
| in-process | `import { createPolly } from "./polly/index.js"` → `polly.accept(json)` / `polly.run(json)` |
| HTTP       | `POST http://localhost:8080/polls` with the JSON as the body           |
| file       | drop it into `polly/inbox/` (picked up within 2s, moved to `done/`)    |

Command line for testing: `npm run polly -- run path/to/request.json`.

## Shape S — the survey (preferred: what the meeting-loop-polly skill builds)

Send the **exact `create_survey` argument object the skill produces**, plus its
`question_map`, under `meeting_id`. Nothing is re-authored here: the questions, choices,
audience, close time and visibility go to Polly as-is; the map is how the answers come
back by position.

```json
{
  "meeting_id": "CL-sync-07",
  "meeting_date": "2026-09-12",
  "channel": "#closed-loop-project",
  "min_votes": 1,
  "settle_seconds": 60,
  "survey": {
    "draftId": "closedloop-sync-7-1757700000",
    "title": "ClosedLoop Sync — confirm and close the loop",
    "appeal": "Three minutes. Confirm today's decisions and fill the blanks the meeting left open.",
    "questions": [
      { "type": "multipleChoice", "allowMultipleAnswers": true, "required": false,
        "title": "Confirm the decisions from today's sync — check every one you agree with",
        "choices": ["CL-D-08 — …", "CL-D-09 — …", "None of these — see my comment"] },
      { "type": "openEnded", "required": false, "title": "Anything the notes missed, or anything captured wrong?" },
      { "type": "multipleChoice", "required": true,
        "title": "Who should own \"CL-A-03 — Launch-readiness review and dry run\"?",
        "choices": ["Obaid", "Zaid", "Nouman", "Sharjeel", "Someone else / not yet decided"] },
      { "type": "ranked", "required": true, "rankCount": 3,
        "title": "Rank the open action items by priority — most urgent first",
        "choices": ["CL-A-01 — …", "CL-A-03 — …", "CL-A-07 — …"] },
      { "type": "1To5", "required": false, "title": "Rate this meeting" },
      { "type": "openEnded", "required": false, "title": "Anything we should cover next time?" }
    ],
    "userEmails": ["obaid@…", "zaid@…", "nouman@…", "sharjeel@…"],
    "closeAt": "+18h",
    "anonymityLevel": "nonAnonymous",
    "resultsVisibility": "onClose",
    "reminderCount": 0
  },
  "question_map": [
    { "index": 0, "role": "ratification", "decisions": ["CL-D-08", "CL-D-09"] },
    { "index": 1, "role": "missed_items", "readback": "human_only" },
    { "index": 2, "role": "gap", "gap_id": "CL-A-03.owner", "item": "Launch-readiness review and dry run", "field": "owner" },
    { "index": 3, "role": "ranking", "items": ["CL-A-01", "CL-A-03", "CL-A-07"] },
    { "index": 4, "role": "meeting_rating", "readback": "organiser_only" },
    { "index": 5, "role": "next_agenda", "readback": "human_only" }
  ]
}
```

| field                   | required | notes                                                                                     |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `meeting_id`            | yes      | letters, digits, `.`, `_`, `-`; results are filed under it                                |
| `survey`                | yes      | the skill's `create_survey` args verbatim: `title`, `questions` (≥ 2), audience (`userEmails` / `userIds` / `userNames` / `channelNames`), `closeAt`, `appeal`, visibility, reminders. `draftId` optional (derived from `meeting_id` if absent) — **the same draftId never sends twice** |
| `question_map`          | yes (for readback) | zero-based `index` per question; `role` ∈ `ratification` (+`decisions`), `gap` (+`gap_id`, `item`, `field`), `ranking` (+`items`, aligned with the choices), `meeting_rating`, `missed_items`, `next_agenda` |
| `channel`               | no       | used only when the survey names no audience; default `POLLY_CHANNEL`                      |
| `min_votes`             | no       | 1 — auto-close needs at least this many respondents …                                     |
| `settle_seconds`        | no       | 60 — … and no new response for this long                                                  |
| `auto_close`            | no       | true; `false` waits for Polly's `closeAt`                                                 |
| `priority_scale`        | no       | `["P0","P1","P2"]` — rank buckets map onto these, top third first                          |
| `fallback_to_polls`     | no       | true — if the Polly plan refuses surveys (premium type), send one single-question polly per readable question with the same readback |

Skill rules the module relies on: gap and ranking answers must be choice-based (free text
never comes back through the API); ratification carries `None of these — see my comment`;
ranked choices are ID-prefixed (`CL-A-03 — …`) so `items[i]` lines up with `choices[i]`.

Full example (the skill's sync #6 worked example): [examples/survey-request.json](examples/survey-request.json).

## Shape A — loop-state gaps (one single-choice poll per gap)

The skill's loop state already carries a `gaps` array: one entry per missing owner,
priority, due date, decision or sign-off, with the question to ask, the options, and who
should answer. Send that, plus the meeting id and the roster. **Every gap becomes one
single-choice Polly.**

```json
{
  "meeting_id": "CL-sync-07",
  "meeting_date": "2026-09-12",
  "channel": "#closed-loop-project",
  "required_attendees": ["obaid", "zaid", "nouman", "sharjeel"],
  "roster": {
    "zaid":   { "email": "zaid@example.com" },
    "nouman": { "slack_id": "U0C09GK0UAZ" },
    "obaid":  { "name": "Obaid Khawaja" }
  },
  "delivery": "auto",
  "close_after_minutes": 10,
  "min_votes": 1,
  "settle_seconds": 30,
  "gaps": [
    {
      "gap_id": "CL-A-03.owner",
      "item": "Launch-readiness review and dry run",
      "field": "owner",
      "ask": "Who owns the launch-readiness review?",
      "options": ["Zaid", "Nouman", "Sharjeel", "Obaid", "Someone else / not decided"],
      "audience": ["obaid", "zaid", "nouman", "sharjeel"],
      "rounds_asked": 2
    },
    {
      "gap_id": "CL-A-08.due",
      "item": "Intervention cooldown logic",
      "field": "due_date",
      "ask": "When is the intervention cooldown logic due?",
      "options": ["Fri 11 Sep", "Sat 12 Sep — before the demo", "After the hackathon", "No date needed"],
      "audience": ["zaid"],
      "rounds_asked": 0
    }
  ]
}
```

| field                 | required | notes                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------------------------- |
| `meeting_id`          | yes      | letters, digits, `.`, `_`, `-`; results are filed under it                              |
| `gaps[]`              | yes      | straight from the skill's loop state: `gap_id`, `ask`, `options` (2–20) required; `item`, `field`, `audience`, `rounds_asked` echoed back |
| `channel`             | no       | default `POLLY_CHANNEL` (`#closed-loop-project`)                                        |
| `required_attendees`  | no       | people keys; used to decide channel vs DM delivery                                      |
| `roster`              | no       | people key → `email` / `slack_id` / `name`, so DMs reach the right Slack user            |
| `delivery`            | no       | `auto` (default): channel when the audience is everyone (or empty), DM when it names specific people · `channel` · `dm` |
| `close_after_minutes` | no       | 15 — Polly closes the poll itself by then at the latest                                  |
| `min_votes`           | no       | 1 — auto-close needs at least this many voters …                                        |
| `settle_seconds`      | no       | 30 — … and no new vote for this long                                                    |

`gap_id` is the correlation key: results come back keyed by it (see [OUTPUT.md](OUTPUT.md)),
ready for the skill's *enrich* step. **Re-sending the same `gap_id` for the same meeting
never creates a second poll.**

Full example from sync #6: [examples/gaps-request.json](examples/gaps-request.json).

## Shape B — generic polls

For anything that isn't a gap (a ranked "what do we do first?", a yes/no, free text):

```json
{
  "meeting_id": "sync_12",
  "channel": "#closed-loop-project",
  "polls": [
    {
      "id": "priorities",
      "kind": "ranked",
      "question": "Rank these action items — what do we do first?",
      "options": ["Event discovery: search filters", "Registration flow: confirmation emails",
                  "Partner integration: sandbox access", "Analytics: dashboard v1"],
      "context": "4 new actions, all have owners, none have agreed priority",
      "close_after_minutes": 10,
      "min_votes": 3,
      "meta": { "action_ids": ["a1", "a2", "a3", "a4"] }
    }
  ]
}
```

| per-poll field        | required | default  | notes                                                                          |
| --------------------- | -------- | -------- | ------------------------------------------------------------------------------ |
| `id`                  | yes      |          | stable per poll (letters, digits, `.`, `_`, `-`); re-sends never duplicate     |
| `kind`                | no       | `ranked` | `ranked` · `single` · `multiple` · `yes_no` · `open`                            |
| `question`            | yes      |          | ≤ 500 chars                                                                    |
| `options`             | ranked/single/multiple | | 2–20 unique strings, ≤ 75 chars each                                  |
| `context`             | no       |          | shown above the question                                                       |
| `audience`, `delivery`, `escape_options` | no | | same meaning as for gaps                                              |
| `close_after_minutes` / `min_votes` / `settle_seconds` / `auto_close` / `anonymous` | no | 15 / 1 / 30 / true / false | |
| `meta`                | no       | `{}`     | echoed back untouched                                                          |

Single-poll shorthand is also accepted: put the poll fields at the top level next to
`meeting_id`. Example: [examples/poll-request.json](examples/poll-request.json).

## What comes back

See [OUTPUT.md](OUTPUT.md) — a record per poll under `polly/results/<meeting_id>/`, plus
`poll_round.json` (gap results for the enrich step), `summary.json` and `summary.md`.
