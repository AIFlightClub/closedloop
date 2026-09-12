---
name: meeting-loop-polly
description: >
  Turn meeting notes into a Polly survey that closes the loop — ratify the
  decisions, fill in every missing owner, date and target, rank the action items
  by priority, and collect meeting feedback. Use this skill whenever someone has
  meeting notes or a gaps object and says anything like "fire the polly", "create
  the poll for this meeting", "send the confirmation survey", "close the loop on
  these notes", "ask the team to confirm the decisions", "get the missing owners",
  "poll the attendees", "we need the priorities ranked", or when a meeting-loop-notes
  run ends with open gaps and the next step is asking humans. Builds the survey
  with the Polly MCP (create_survey), always as a draft for review first, and
  emits a question map so the answers can be merged back into the notes. Always
  use this skill rather than hand-assembling a Polly call — the question ordering,
  the choice-vs-free-text rule, and the results-readback constraint are easy to
  get wrong and expensive to discover after the survey is live.
---

# Meeting Loop — Polly

> **Half two of two.** `meeting-loop-notes` reads the meeting and writes the record;
> `meeting-loop-polly` asks the humans and sends the survey. This skill consumes the
> `gaps` array and never writes notes — merging the answers back is
> `meeting-loop-notes`' job.

Notes in → one Polly survey out → answers merge back into the notes.

This is the second half of the loop. The `meeting-loop-notes` skill produces a
`gaps` array; this skill turns that array into questions, and the results come
back through the enrichment mode of `meeting-loop-notes`.

## Read this before designing any question

**`get_polly_results` does not return open-ended answers or comments.** They render
on the results card for humans, but they are withheld from the AI. There is no
parameter that changes this.

The consequence is the whole design rule of this skill:

- **Anything you need to read back automatically must be a choice-based question.** Owner → `multipleChoice` with the attendee names as choices. Due date → `multipleChoice` with concrete candidate dates. Priority → the ranked question. These come back as counts and merge cleanly.
- **`openEnded` is for things a human will read, not the loop.** Missed items, context, rationale, feedback. Include them — they're valuable — but never make the loop depend on them, and tell the organiser they'll have to read those on the results card.
- If a gap genuinely can't be enumerated, ask it as `multipleChoice` with the plausible candidates plus an escape hatch, and add one `openEnded` catch-all for everything else.

Second constraint: **voters cannot add their own choices on a multi-question
polly.** `allowAddingChoices` is single-question only. So "we missed an item" is
handled by a dedicated open-ended question, not by an extendable choice list.

---

## Survey shape

Fixed order. Every meeting produces the same skeleton, so respondents learn it
once.

| # | Question | Type | Required |
|---|---|---|---|
| 1 | Confirm the decisions from this meeting | `multipleChoice`, `allowMultipleAnswers: true` | no |
| 2 | Anything the notes missed or got wrong? | `openEnded` | no |
| 3…n | One per gap — missing owner, missing date, missing target | `multipleChoice` (preferred) or `openEnded` | **yes** |
| n+1 | Rank these action items by priority | `ranked` | **yes** |
| n+2 | Rate this meeting | `1To5` or `1To10` | no |
| n+3 | Anything to cover next time? | `openEnded` | no |

Minimum viable survey is Q1 + the ranked question — `create_survey` requires two
or more questions. A meeting with no gaps still gets a survey; it's just short.

### Q1 — decision ratification

- One choice per decision from the notes, in the notes' order.
- Choice text is the decision in **under 300 characters** — Polly truncates past that. Compress to the call itself, drop the rationale; the full text lives in the notes.
- Always append a final choice: `None of these — see my comment`. Without it, an empty submission is ambiguous: Polly can't distinguish "skipped the question" from "agrees with nothing", and you will misread a quiet dissent as a skip.
- Keep the question optional. Making it required forces a false agreement out of anyone who wanted to abstain.
- Reading it back: a decision confirmed by a majority of respondents moves from 🟡 to ✅ in the notes. A decision that several people left unchecked stays open and gets raised at the next meeting — not silently confirmed.

### Q2 — missed items

`openEnded`, optional. Prompt: `Anything the notes missed, or anything captured
wrong? Add it here.` This is the replacement for voter-added choices. Its answers
are human-read only.

### Q3…n — one question per gap

One question per gap in the notes' `gaps` array, in the same order. Mark each
**required** — a gap question that people can skip is a gap that stays open.

Build them from the gap's own `field` and `options`:

- **owner** → `multipleChoice`, single answer. Choices: every required attendee by display name, plus `Someone else / not yet decided`. Never free text — a typed name can't be read back and won't match your roster.
- **due date / ETA / target date** → `multipleChoice`, single answer. Choices: 3–4 concrete dates resolved against the meeting date (`Fri 18 Sep`, `Mon 21 Sep`, `After the launch`), plus `No date needed`. Never ask for a date as free text.
- **decision not made** → `multipleChoice` with the options that were actually weighed in the room, plus `Decide at the next sync`.
- **status update on a stale item** → `multipleChoice` with the plausible states (`Done`, `In progress`, `Not started`, `Blocked`).
- Anything else → `multipleChoice` with candidates plus an escape hatch. `openEnded` only as a last resort, and say so in your summary so the organiser knows that answer won't merge itself.

Question text carries the item so it stands alone in Slack — the respondent is not
looking at the notes: `Who should own "Launch-readiness review"?` not `Who owns
item 3?`

Cap at **8 gap questions.** More than that and response rate collapses. Keep the
highest-priority items' gaps, and note the deferred ones in your summary.

### Q(n+1) — priority ranking

- `ranked`, required.
- Choices: every **open** action item, in the notes' order. Closed items never appear.
- `rankCount` = number of choices, capped at 20. If there are more than 20 open items, rank the top 20 by existing priority and say which were left out.
- Two choices minimum. With a single open action item, drop this question entirely rather than shipping a one-item ranking.
- Choice text: the action, under 300 characters, with its ID prefix (`CL-A-03 — Launch-readiness review`). The ID prefix is what lets the result merge back without re-matching on wording.

### Q(n+2) and Q(n+3) — meeting feedback

Optional, both. `1To5` unless the organiser asked for ten. Then one `openEnded`
for agenda suggestions. These are for the organiser, not the loop — they never
change an action item.

Every question also gets Polly's own comment box automatically; `commentsVisibility`
decides whether the rest of the audience sees those comments. Default `public` for
a team sync — the comments are usually the most useful part for everyone else.

---

## Building the call

Tool: `Polly Beta:create_survey`.

```json
{
  "draftId": "meeting-items-confirmation-1757667000",
  "title": "Meeting Items Confirmation and Feedback",
  "appeal": "Ten questions or fewer. Confirm what we decided and fill the blanks the meeting left — full notes linked in the channel.",
  "questions": [ ... ],
  "userEmails": ["...", "..."],
  "closeAt": "2026-09-15T09:00:00+05:00",
  "anonymityLevel": "nonAnonymous",
  "resultsVisibility": "onClose",
  "commentsVisibility": "public",
  "reminderCount": 1,
  "daysBetweenReminders": 1
}
```

Settings and why:

- **`draftId`** — `<first 3 title words, slugged>-<unix seconds>`, 8–64 chars, letters/numbers/hyphen/underscore only. Reuse the exact same id to amend, send or cancel. A fresh id is a different survey.
- **Audience** — the required attendees, **present and absent**. Absence is not an exemption. Prefer `userEmails` or `userIds`; `userNames` fails on duplicates and you'll have to ask which person was meant. Pass everyone in one call; splitting creates duplicate surveys with split results.
- **`anonymityLevel: "nonAnonymous"`** — the loop needs to know who claimed an owner. Attribution is the point. Only go anonymous if the survey carries something sensitive, which a meeting-gaps survey shouldn't.
- **`closeAt`** — **before the next meeting, not seven days out.** The default is 7 days, which is useless for a twice-weekly sync. Set it to the morning of the next sync at the latest, so the results are in hand when the notes get enriched.
- **`resultsVisibility: "onClose"`** — real-time results on a ranking question anchor later voters to the early ones.
- **Reminders** — one reminder, one day apart, is right for a short loop. Skip reminders if the survey closes in under 24 hours.

### Draft, then stop

Call `create_survey` **without** `userConfirmed`. That stores the draft and returns
a preview card. Then stop and wait for the person to confirm in chat or press Send
on the card.

Only after they confirm, call again with exactly `{ draftId, userConfirmed: true }`.
Never draft and send in one turn. If they pressed Send on the card, it's already
sent — do not call again.

Amending: same `draftId`, and **always resend the whole `questions` array** — it
replaces the stored one.

---

## Emit the question map

The survey's results come back by question position, so record the mapping or the
answers can't be merged. Emit this alongside the draft:

```json
{
  "polly_draft_id": "meeting-items-confirmation-1757667000",
  "meeting_id": "CL-sync-06",
  "question_map": [
    {"index": 0, "role": "ratification", "decisions": ["CL-D-06", "CL-D-07"]},
    {"index": 1, "role": "missed_items", "readback": "human_only"},
    {"index": 2, "role": "gap", "gap_id": "CL-A-03.owner"},
    {"index": 3, "role": "gap", "gap_id": "CL-Q-03.decision"},
    {"index": 4, "role": "ranking", "items": ["CL-A-01", "CL-A-03", "CL-A-07"]},
    {"index": 5, "role": "meeting_rating", "readback": "organiser_only"},
    {"index": 6, "role": "next_agenda", "readback": "human_only"}
  ]
}
```

`index` is zero-based and matches the order in `questions`. Nothing else identifies
a question on the way back.

---

## Reading the results back

`get_polly_results` with `{ id, type: "survey" }` — the id comes from the send
response or `list_pollys`, never guessed.

Per question role:

- **ratification** — a decision checked by a majority of respondents → ✅ in the notes. Checked by some but not most → stays 🟡 and goes on the next agenda. `None of these` picked by anyone → raise it with the organiser before confirming anything.
- **gap** — winning choice fills the field, marked as poll-sourced. Tie → stays missing. Escape-hatch option wins → gap retires, not re-polled. These are the `meeting-loop-notes` enrichment merge rules; follow them there rather than re-deriving them here.
- **ranking** — the aggregate order becomes the priority order. Map positions onto the scale the team uses (top third P0, middle P1, rest P2) and say you did — a rank is not literally a priority label.
- **missed_items / next_agenda** — free text, not returned to you. Tell the organiser to read them on the results card, and don't imply you've seen them.

Then hand the merged values to `meeting-loop-notes` in enrichment mode. This skill does
not rewrite the notes itself.

---

## Worked example — ClosedLoop sync #6

Seven questions from that meeting's gaps: decision ratification (2 decisions),
missed items, owner for CL-A-03, the live-vs-recorded call, ranking of 5 open
action items, a 1–5 rating, next-time agenda.

```json
{
  "draftId": "closedloop-sync-6-1757667000",
  "title": "ClosedLoop Sync — confirm and close the loop",
  "appeal": "Three minutes. Confirm Thursday's decisions and fill the two blanks the meeting left open. Full notes are in the channel canvas.",
  "questions": [
    {
      "type": "multipleChoice",
      "allowMultipleAnswers": true,
      "required": false,
      "title": "Confirm the decisions from Thursday's sync — check every one you agree with",
      "choices": [
        "CL-D-06 — Side panel shows three buckets (Resolved / Needs attention / Up next) and accumulates quietly",
        "CL-D-07 — Interventions capped at 3 pushes per 30 minutes, none within 5 minutes of each other",
        "None of these — see my comment"
      ]
    },
    {
      "type": "openEnded",
      "required": false,
      "title": "Anything the notes missed, or anything captured wrong? Add it here."
    },
    {
      "type": "multipleChoice",
      "required": true,
      "title": "Who should own \"CL-A-03 — Launch-readiness review and dry run\"? It has had no owner for three meetings.",
      "choices": ["Obaid", "Zaid", "Nouman", "Sharjeel", "Someone else / not yet decided"]
    },
    {
      "type": "multipleChoice",
      "required": true,
      "title": "CL-Q-03 — do we demo on live RTMS or the recorded fallback?",
      "choices": ["Live RTMS — go for it", "Recorded fallback — play it safe", "Decide Saturday morning once entitlement is known"]
    },
    {
      "type": "ranked",
      "required": true,
      "rankCount": 5,
      "title": "Rank the open action items by priority — most urgent first",
      "choices": [
        "CL-A-01 — Confirm Zoom RTMS entitlement and credits",
        "CL-A-02 — Slack canvas write/edit path spike",
        "CL-A-03 — Launch-readiness review and dry run",
        "CL-A-07 — Zoom side-panel skeleton",
        "CL-A-08 — Intervention cooldown and priority-ordering logic"
      ]
    },
    {"type": "1To5", "required": false, "title": "Rate this meeting"},
    {"type": "openEnded", "required": false, "title": "Anything we should cover next time?"}
  ],
  "userNames": ["Obaid", "Zaid", "Nouman", "Sharjeel"],
  "closeAt": "+18h",
  "anonymityLevel": "nonAnonymous",
  "resultsVisibility": "onClose",
  "reminderCount": 0
}
```

Note what is *not* free text: the owner and the ship decision, the two answers the
loop has to read back. CL-A-09's missing priority isn't its own question — the
ranking covers it.

---

## Pre-send checklist

1. ☐ Every gap the loop must read back asked as `multipleChoice`, not `openEnded`?
2. ☐ Every choice list carries a real escape hatch?
3. ☐ Q1 carries `None of these — see my comment`, and is optional?
4. ☐ Gap questions marked required; feedback questions optional?
5. ☐ Ranked question lists only open action items, `rankCount` ≤ 20 and ≤ choice count?
6. ☐ Choice text under 300 characters, IDs prefixed on ranked items?
7. ☐ Audience includes required attendees who missed the meeting?
8. ☐ `closeAt` set before the next meeting, not left at the 7-day default?
9. ☐ Question map emitted with zero-based indices?
10. ☐ Drafted without `userConfirmed`, and stopped for review?
