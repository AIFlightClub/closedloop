# Polly module — what comes out

Everything lands under `polly/results/<meeting_id>/`. Nothing is posted to Slack by this
module; the notes-enrichment step and the Slack-app lane read these files (or the same data
over HTTP while the server runs).

```
polly/results/CL-sync-07/
  survey_closedloop-sync-7-….json   the survey record — updated live while open, final once closed
  poll_round.json                   the readback: gaps · ratification · ranking · rating (enrich input)
  summary.json                      { meeting_id, generated_at, polls: [ …records… ] }
  summary.md                        the same, human-readable, canvas-safe markdown
```

HTTP while the server runs: `GET /polls/<meeting_id>` (records), `GET /polls/<meeting_id>/poll_round.json`,
`GET /polls/<meeting_id>/summary.md`, `GET /polls/<meeting_id>/<record id>`.

## poll_round.json — for the enrich step

`results` is one entry per gap (the shape the notes skill records under `poll_round`),
whether the gap was asked inside the survey or as its own poll. The survey's other roles
sit next to it:

```json
{
  "meeting_id": "CL-sync-07",
  "fired_at": "…", "closed_at": "…", "respondents": 4, "complete": true,
  "results": [
    { "gap_id": "CL-A-03.owner", "item": "Launch-readiness review and dry run", "field": "owner",
      "winning_option": "Sharjeel", "resolution": "filled", "votes": 4,
      "counts": { "Obaid": 0, "Zaid": 1, "Nouman": 0, "Sharjeel": 3, "Someone else / not yet decided": 0 } }
  ],
  "ratification": { "respondents": 4, "confirmed": ["CL-D-08"], "partial": ["CL-D-09"], "none_of_these": 1,
                    "decisions": [{ "decision": "CL-D-08", "votes": 4, "status": "confirmed" }, { "decision": "CL-D-09", "votes": 2, "status": "partial" }] },
  "ranking": { "order": [{ "rank": 1, "item": "CL-A-01", "choice": "CL-A-01 — …", "score": 18, "priority": "P0" },
                         { "rank": 2, "item": "CL-A-03", "choice": "CL-A-03 — …", "score": 15, "priority": "P0" },
                         { "rank": 3, "item": "CL-A-07", "choice": "CL-A-07 — …", "score": 12, "priority": "P1" }],
               "scale": ["P0", "P1", "P2"] },
  "meeting_rating": { "average": 4.25, "responses": 4 },
  "human_only": [{ "role": "missed_items", "responses": 2 }, { "role": "next_agenda", "responses": 3 }],
  "surveys": [{ "id": "survey_closedloop-sync-7-…", "polly_id": "68c3…", "status": "closed", "votes": 4, "results_url": "https://…" }]
}
```

Readback rules (from the skill): a decision checked by a **majority** of respondents is
`confirmed`, checked by some is `partial`, and any `None of these` vote is counted;
rank positions map onto the priority scale in thirds (top third `P0`, then `P1`, rest `P2`),
and a rank is not literally a priority label; open-ended answers never come back through the
API — `human_only` lists how many responses to read on the results card.

`fallback: true` means the survey was refused by the Polly plan and the same questions went out as single pollys; the readback above is built from those instead. Single-poll (Shape A/B) records keep the shape below.

Gap result fields:

```json
{
  "meeting_id": "CL-sync-07",
  "fired_at": "2026-09-12T13:40:02.120Z",
  "closed_at": "2026-09-12T13:51:10.400Z",
  "respondents": 4,
  "complete": true,
  "results": [
    { "gap_id": "CL-A-03.owner", "item": "Launch-readiness review and dry run", "field": "owner",
      "winning_option": "Sharjeel", "resolution": "filled", "votes": 4,
      "counts": { "Sharjeel": 3, "Nouman": 1, "Zaid": 0, "Obaid": 0, "Someone else / not decided": 0 },
      "poll_id": "68c3…", "status": "closed" },
    { "gap_id": "CL-A-08.due", "item": "Intervention cooldown logic", "field": "due_date",
      "winning_option": null, "resolution": "tie", "detail": "Fri 11 Sep 1, Sat 12 Sep — before the demo 1",
      "votes": 2, "counts": { "Fri 11 Sep": 1, "Sat 12 Sep — before the demo": 1, "After the hackathon": 0, "No date needed": 0 },
      "poll_id": "68c4…", "status": "closed" }
  ]
}
```

| `resolution`   | meaning (skill merge rules)                                                     |
| -------------- | ------------------------------------------------------------------------------- |
| `filled`       | a real option won outright → fill the field, mark it ᵖ                          |
| `tie`          | top options tied (`detail` says which) → stays missing, becomes an open question |
| `escape_hatch` | "Someone else / not decided", "No date needed", … won → stays missing, retire the gap |
| `no_responses` | nobody answered → stays missing, `rounds_asked` + 1                              |

Escape hatches are recognised by phrasing ("not decided", "someone else", "no date needed",
"decide Saturday…") or listed explicitly per gap in `escape_options`.

## A record

```json
{
  "id": "priorities",
  "meeting_id": "sync_12",
  "kind": "ranked",
  "question": "Rank these action items — what do we do first?",
  "options": ["Event discovery: search filters", "Registration flow: confirmation emails",
              "Partner integration: sandbox access", "Analytics: dashboard v1"],
  "context": "4 new actions, all have owners, none have agreed priority",
  "channel": "#closed-loop-project",
  "meta": { "action_ids": ["a1", "a2", "a3", "a4"] },
  "polly": {
    "id": "68c3…", "type": "poll", "draft_id": "closedloop_sync_12_priorities",
    "results_url": "https://…", "sent_at": "2026-09-12T13:40:02.120Z", "close_at": "2026-09-12T13:50:02.000Z"
  },
  "status": "closed",
  "closed_by": "settled",
  "closed_at": "2026-09-12T13:44:31.008Z",
  "votes": 14,
  "choices": [
    { "text": "Event discovery: search filters", "votes": 41, "percentage": 32.0 },
    { "text": "Partner integration: sandbox access", "votes": 35, "percentage": 27.3 }
  ],
  "ranking": [
    { "rank": 1, "option": "Event discovery: search filters", "score": 41, "percentage": 32.0 },
    { "rank": 2, "option": "Partner integration: sandbox access", "score": 35, "percentage": 27.3 }
  ],
  "winner": "Event discovery: search filters",
  "created_at": "2026-09-12T13:40:01.900Z",
  "updated_at": "2026-09-12T13:44:31.010Z"
}
```

| field       | meaning                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| `status`    | `sending` → `open` → `closed`; or `failed` (see `error`)                                             |
| `closed_by` | `polly_close_at` (Polly's timer) · `settled` (min votes in, count stopped changing) · `manual` · `timeout` |
| `votes`     | number of people who responded                                                                       |
| `choices`   | Polly's raw per-option numbers, in Polly's order                                                     |
| `ranking`   | best-first. For `ranked` polls `score` is Polly's weighted rank score; for `single`/`multiple` it's the vote count |
| `winner`    | `ranking[0].option`                                                                                  |
| `meta`      | whatever the request carried (action ids etc.), untouched                                            |
| `polly`     | the Polly ids + results link, in case the canvas wants to link back                                  |

For the canvas, the useful bits are `question`, `ranking`, `votes`, `winner`, `meta` and
`polly.results_url`. `summary.md` already renders a section per poll if that's easier to embed.
