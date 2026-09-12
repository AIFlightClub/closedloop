---
name: meeting-loop-notes
description: >
  Turn a speaker-labelled meeting transcript into structured meeting notes with
  attendance reconciliation, numbered decisions, and prioritized action items —
  carrying forward unresolved commitments from prior meetings, flagging every
  missing owner, date, and priority, and enriching the notes from poll results
  once people answer. Use this skill whenever someone provides a live or recorded
  transcript feed (Zoom RTMS stream, .vtt, JSONL of speaker + utterance) and wants
  notes written up, or says "write up this meeting", "generate notes from the
  transcript", "summarise the call", "turn this feed into notes", "who was missing
  from the meeting", "what's still open from last time", "fill in the gaps from the
  poll", "enrich the notes with the poll results", or "what should the agent flag
  in this meeting". Also use it to drive live in-meeting interventions — missing
  owner, ambiguous decision, uncovered agenda item, stale commitment, absent
  stakeholder. This skill is project-agnostic: it makes no assumptions about which
  product, team, or workspace the meeting belongs to. It outputs Slack-Canvas-safe
  markdown plus a machine-readable loop-state object that downstream automation
  uses to intervene and to decide whether to fire a poll. Always use this skill
  rather than free-forming meeting notes — the attendance diff, the stable item
  IDs, the missing-metadata contract, and the enrichment merge rules are the whole
  point.
---

# Meeting Loop — Notes

> **Half one of two.** `meeting-loop-notes` reads the meeting and writes the record;
> `meeting-loop-polly` asks the humans and sends the survey. The handoff is the
> `gaps` array this skill emits. Enrichment — merging poll answers back into the
> notes — happens **here**, not in the Polly skill.

Transcript in → structured notes out, with every missing piece of metadata named
explicitly so an agent can go get it, and every unresolved item from last time
carried forward so nothing quietly dies between meetings.

## Inputs

| Input | Required | Shape |
|---|---|---|
| `transcript` | yes | Speaker-labelled utterances: RTMS stream/JSONL, .vtt, or pasted text with names |
| `required_attendees` | yes | The expected roster — names, optionally with role and handle |
| `agenda` | no | Ordered list of items the meeting is meant to cover |
| `loop_state` | no | Prior meetings' open items: action register, open decisions, commitments |
| `poll_results` | no | Results from a poll fired to close gaps from a previous run |

If `required_attendees` is not supplied, **ask for it before writing.** It is the
only way to compute missing attendees, and missing attendees are what trigger the
poll. Do not infer the roster from who spoke — that defeats the purpose.

Three modes:

- **Generate** (transcript + roster) → notes, gaps, updated loop state.
- **Enrich** (prior notes + `poll_results`) → same notes with gaps filled.
- **Live** (streaming transcript + agenda + loop state) → intervention decisions while the meeting is still running. See *Live interventions* below.

---

## Item identity — read this before anything else

Action items, decisions, and open questions get **stable IDs that survive across
meetings**: `A-01`, `D-03`, `Q-02`, prefixed per project if the caller supplies a
prefix (`CL-A-01`).

- If `loop_state` is supplied, an item discussed again keeps its original ID. Never re-mint.
- New items continue the sequence from the highest existing ID.
- Match by substance, not wording — "the canvas fallback" and "fallback path for canvas writes" are the same item.
- `gap_id` is `<item_id>.<field>` (`A-03.owner`), so a poll fired on Tuesday still merges cleanly into Thursday's notes.

Position in a list is never an identifier.

---

## Generate the notes

### Step 1: Reconcile attendance

Match transcript speaker labels against `required_attendees`:

- Normalize before matching: lowercase, strip parenthetical suffixes (`Zaid (Polly)`), strip titles, match on first name when unambiguous, full name when not.
- **Present** — on the roster and spoke in the transcript.
- **Missing** — on the roster, never appears in the transcript.
- **Additional** — spoke but is not on the roster. List separately; never silently promote them onto the roster.
- Ambiguous match (two roster members share a first name, label is just "Ali") → list under Additional and flag it in Open questions rather than guessing.

Attendance is inferred from **speaking**, not from joining. Someone who joined and stayed silent reads as missing — say so with 🔇 if the feed carries a participant list that contradicts the transcript.

If `loop_state` shows the same person missing from prior meetings, say how many in a row: `Missing: Sharjeel (3rd consecutive)`. A repeat absence is a different problem from a one-off and should read as one.

### Step 2: Carry forward the loop

Before classifying anything new, walk every open item in `loop_state` and mark each one:

- **Updated** — someone reported progress. Record it.
- **Closed** — done, or explicitly dropped.
- **Slipped** — a new due date was given. Keep the slip history: `due 2026-09-11 (slipped from 09-08, 09-03 — 2nd slip)`. Never overwrite a date silently; a date that has moved twice is a risk signal and the notes are where it has to be visible.
- **Stale** — open, never mentioned in this meeting. Carry it forward unchanged and list it under *Carried over, no update*. This is the most commonly dropped category and the most useful one.

### Step 3: Classify every substantive item

Read the whole transcript end to end, including the last third — late-meeting items carry real calls and are the most commonly missed. Sort every substantive item into exactly one of:

1. **Decision** — a call was made and was affirmed by someone other than the proposer. Casual phrasing still counts.
2. **Action item** — someone will do something after the meeting.
3. **Open question** — raised, unresolved, no call made.
4. **Context** — discussion that supports the above but isn't itself any of them.

A proposal nobody affirmed is not a decision. A topic discussed at length with two options on the table and no call is an **open question**, not a decision — write what the options were and that no call was made. Attribute by name.

### Step 4: Extract action-item metadata

Every action item carries three fields. Extract each only if the transcript actually states it — never infer, never assign a plausible owner:

- **owner** — a named person.
- **due date** — an absolute date. Resolve relative language ("by Friday", "end of sprint") against the meeting date and show the resolved date.
- **priority** — P0 / P1 / P2, or whatever scale the meeting uses, captured verbatim.

Anything not stated is written as `⚠️ MISSING` and recorded in the gaps object. `⚠️ MISSING` is a feature, not a failure — it is the signal the runtime polls on. Do not paper over it with "TBD", "team", or a guessed date.

### Step 5: Check agenda coverage

If an `agenda` was supplied, mark each item ✅ covered / 🟡 partially covered / ⬜ not covered, and list the not-covered ones explicitly. An agenda item that was never reached is an output of the meeting, not an oversight to be quiet about.

### Step 6: Write the notes

Slack Canvas markdown. Canvas flattens tables past ~3 columns, so action items go as a numbered list with inline metadata, never as a table.

```
# 📋 [Meeting title] — YYYY-MM-DD

**Date:** YYYY-MM-DD
**Meeting:** [#N in series, if known]

## Attendees

**Present (N of M):** [names]
**Missing:** [names, with consecutive-absence count] — or "none"
**Also attended (not on roster):** [names] — omit this line if empty

## Summary

[2–4 sentences. What the meeting was for and what came out of it.]

## Agenda coverage

✅ [item]
✅ [item]
⬜ [item] — not reached

## Decisions

1. **[D-04]** [Decision, one sentence, stated as a call.] — proposed by [name], affirmed by [name]

## Action items

1. **[A-07] [Action]** — @[owner] · due [YYYY-MM-DD] · [P1]
2. **[A-03] [Action]** — owner ⚠️ MISSING · due [YYYY-MM-DD] · [P1] · *carried from [date]*
3. **[A-09] [Action]** — @[owner] · due ⚠️ MISSING · ⚠️ MISSING

## Carried over, no update

- **[A-05]** [Action] — @[owner] · due [date] · *no update for 2 meetings*

## Open questions

1. **[Q-02]** [Question] — raised by [name]

## Needs input

- **A-03** — no owner named for 3 meetings; asking all attendees
- **A-09** — priority and due date unknown; asking @zaid
- @sharjeel missed this meeting (2nd consecutive); asking for input on D-04
```

Ordering rules:

- Decisions before action items. Numbered, never bulleted.
- Action items ordered by priority (P0 → P1 → P2 → missing-priority last).
- Keep nesting to one level; canvas mangles deeper nesting.
- Bold with `**double asterisks**` inside canvas markdown. If the same content goes out as a Slack *message*, convert to `*single asterisks*`.

### Step 7: Emit the loop state

Alongside the notes, emit this machine-readable block. Emit it even when there are no gaps — `"gaps": []` tells the caller not to poll.

```json
{
  "meeting_id": "sync-12",
  "meeting_date": "2026-09-12",
  "attendance": {
    "present": ["zaid", "nouman"],
    "missing": [{"name": "sharjeel", "consecutive": 2}],
    "additional": []
  },
  "agenda_coverage": {"covered": ["rtms"], "partial": [], "not_covered": ["launch comms"]},
  "open_items": [
    {
      "id": "A-03",
      "item": "Launch-readiness review",
      "owner": null,
      "due": "2026-09-11",
      "due_history": ["2026-09-08", "2026-09-11"],
      "priority": "P1",
      "status": "open",
      "meetings_without_update": 0,
      "first_raised": "2026-09-03"
    }
  ],
  "gaps": [
    {
      "gap_id": "A-03.owner",
      "item": "Launch-readiness review",
      "field": "owner",
      "ask": "Who owns the launch-readiness review?",
      "options": ["Zaid", "Nouman", "Sharjeel", "Obaid", "Someone else / not decided"],
      "audience": ["zaid", "nouman", "sharjeel", "obaid"],
      "rounds_asked": 1
    }
  ]
}
```

Rules for building it:

- **Audience** — the named owner if there is one; otherwise every required attendee, present *and* missing. People who missed the meeting are explicitly in scope.
- **Options** — always offer a real escape hatch ("Not decided", "Someone else"), so a poll can return "still unknown" instead of forcing a wrong answer.
- **Options are mandatory, not decorative.** Every gap must be answerable by picking from a list. Free-text answers to a poll cannot be read back programmatically, so a gap with no enumerated options is a gap the loop can never close by itself.
- Option sets by field:
  - *priority* → the scale used in the meeting, plus a drop option.
  - *due date* → concrete dates resolved from the meeting date (this Friday → `Fri 18 Sep`), not relative phrases, plus "No date needed".
  - *owner* → required attendees by name, plus "Someone else / not decided".
- One gap per missing field, not one per action item.
- Cap at 8 gaps per poll round; keep the highest-priority items' gaps and note the rest as deferred.
- `rounds_asked` increments each time a gap survives a poll. At 3, stop polling and escalate it to a human as a named blocker instead — a question the group has dodged three times is not a data problem.

---

## Enrich from poll results

Input is the prior notes (or loop state) plus results keyed by `gap_id`.

Merge rules, in order:

1. **Only fill `⚠️ MISSING`.** A poll never overwrites something the transcript established. If a result contradicts a stated fact, leave the original and add an open question naming the conflict.
2. **Winning option fills the field**, marked with its source: `due 2026-09-18 ᵖ` — footnote `ᵖ` once at the bottom as "from poll". Readers need to know which facts came from a vote rather than the room.
3. **Tie → stays missing.** Record it as an open question: "tied vote, needs a call".
4. **Escape-hatch option wins → stays missing**, gap retired rather than re-polled. Re-asking a question the group declined to answer is noise.
5. **No responses → stays missing**, gap stays live, `rounds_asked` increments.
6. Re-sort action items after enrichment — newly-assigned priorities change the order.

Then update the notes:

- Rewrite the affected action-item lines in place.
- Replace **Needs input** with a one-line reconciliation: `Enriched 3 of 5 gaps from the poll (7 respondents). 2 still open — see Open questions.`
- If every gap closed, drop the section.
- Add `**Last enriched:** YYYY-MM-DD HH:MM` under the date.
- Emit the updated loop state with closed gaps removed.

---

## Live interventions

When running against a live feed with an `agenda` and `loop_state`, the same
extraction runs continuously and produces intervention candidates. The point is a
copilot with judgment, not a bot that interrupts every thirty seconds.

**Accumulate quietly. Escalate rarely.** Everything goes to the passive surface
(side panel, pinned card) as it's detected. Only the following get pushed into
meeting chat or Slack:

| Trigger | Fires when | Intervention |
|---|---|---|
| Owner missing | An action item has been captured and ~60s of conversation has moved past it with no owner named | "I captured *[item]* as an action item but didn't hear an owner. Who owns it?" |
| Decision ambiguous | Two or more options were weighed, the topic has been dropped, no call detected | "You weighed [A] against [B] but I didn't capture a final decision." |
| Priority unclear | ≥3 new action items exist and none carry a priority | "Three new action items so far and no priority on any of them — which is highest?" |
| Stale commitment | An item in `loop_state` owned by someone present has had no update for ≥2 meetings | "Last meeting [name] committed to [item]. I haven't heard an update." |
| Agenda at risk | <20% of scheduled time remains and an agenda item is uncovered | "8 minutes left and *[item]* hasn't been discussed." |
| Absent stakeholder | A decision is forming that a missing required attendee owns or is required for | "[Name] is required for this decision but isn't here. I can add it to the post-meeting poll." |
| Agenda navigation | An agenda item is confirmed covered | "✅ [item] complete. Next: [item]." |

Judgment rules:

- **Max 3 pushed interventions per 30 minutes**, and never two within 5 minutes.
- **Never interrupt mid-sentence** — wait for a natural break (≥3s of silence, or a speaker change).
- **Never fire the same trigger twice for the same item.** If it was raised and ignored, it becomes a gap for the poll, not a second interruption.
- **Priority order when several are eligible**: absent stakeholder > agenda at risk > owner missing > decision ambiguous > stale commitment > priority unclear > navigation.
- **Resolution is the reward.** When a human answers an intervention, reflect it immediately on the passive surface (`✅ Owner: Sharjeel`) and say nothing further. The visible state change is the acknowledgement.
- **Disclosure is not optional.** Live transcript access must be visibly disclosed to participants (Zoom surfaces this via its participant notification / Active App Notifier). Treat the disclosure as part of the experience, not something to minimise.

---

## Pre-finalize checklist

1. ☐ Roster supplied, and present/missing/additional computed from it — not from who spoke alone?
2. ☐ Repeat absences counted and stated as consecutive?
3. ☐ Every open item from `loop_state` marked updated / closed / slipped / stale — none silently dropped?
4. ☐ Slip history preserved on every date that moved?
5. ☐ Stable IDs reused for items seen before, new IDs continuing the sequence?
6. ☐ Every action item has all three fields either filled from the transcript or marked `⚠️ MISSING`?
7. ☐ No owner, date, or priority invented, softened to "TBD", or assigned by plausibility?
8. ☐ Every `⚠️ MISSING` has a matching gap with an audience and a real escape-hatch option?
9. ☐ Two options weighed with no call written as an open question, not resolved into a decision?
10. ☐ Uncovered agenda items listed explicitly?
11. ☐ Canvas-safe: no wide tables, one level of nesting, numbered lists?
12. ☐ On enrichment — did anything from the poll overwrite a transcript-stated fact? (It should not have.)
