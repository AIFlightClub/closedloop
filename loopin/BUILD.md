> Implementation handoff: **tokens.css is binding, the .dc.html is reference only, the screenshots are the target.** See `README.md` for the built app, canonical cast, seven-minute replay, setup and verified limitations. The original supplied specification follows unchanged.

# LoopIn — Zoom App build spec

Hand this whole folder to Claude Code. Read this file first, then
`design/tokens.css`, then open `design/LoopIn Zoom App.dc.html` in a browser to
see the target.

---

## 0. What you are building

A Zoom App that runs in the meeting side panel and closes loops while the meeting
is still happening.

It listens to the live RTMS transcript, watches for four failure modes (action
item with no owner, action item with no date, agenda item not covered, decision
not made), and when it finds one it shows the **organizer** a card. The organizer
either resolves it verbally or pushes a one-question poll to the participants.
Participants answer in their own side panel. The answer lands back in the panel
and the loop closes on screen.

For the demo, two loops must work end to end:

- **Loop A — missing owner.** An action item is captured with no owner named.
- **Loop B — missing date.** An action item is captured with no due date.

Plus two ambient behaviours: agenda items tick off as they're covered, and the
attendee roster comes from the live Zoom participant list.

**The demo moment** is a loop going from ⚠️ open → organizer pushes a poll →
participants answer in the panel → ✅ closed, without anybody leaving Zoom.

---

## 1. Two views, one app

The same app renders differently by role. Role comes from the Zoom meeting role,
not a setting.

**Organizer view** — the full dashboard: meeting health, the active intervention
card, agenda progress, people, open loops, resolved. This is the screen the
audience watches.

**Attendee view** — no dashboard. Idle state reads *"Nothing needs your input.
LoopIn will prompt you here if the organizer asks the room. You won't see the
meeting dashboard."* When the organizer pushes a question it becomes a single
question with large tap targets, then a confirmation: *"Sent to LoopIn. Your vote
is counted. Results stay in the meeting."* Footer on every attendee screen:
*"Only you see this."*

Keeping the attendee view nearly empty is deliberate — it's what makes the
prompt land when it does arrive.

---

## 2. Architecture

```
Zoom client
 ├── Zoom App side panel (React, 372px)      ← this repo
 │     organizer dashboard / attendee prompt
 └── RTMS transcript stream ──► backend
                                 │
                                 ├── detector (rules over the rolling transcript)
                                 ├── loop state (single source of truth)
                                 └── WebSocket ──► both panels
```

One rule: **the panel renders loop state and nothing else.** No detection logic in
the client. Every panel in the meeting subscribes to the same state object, filtered
by role. That is what makes the organizer's screen and the attendees' screens agree
during the demo.

### Zoom surfaces

| Need | Surface |
|---|---|
| Live transcript | RTMS, scope `meeting:read:meeting_transcript`. Startable from the in-meeting JS app on current desktop clients. |
| Panel UI | Zoom Apps JS SDK — side panel, collapsed / expanded / pop-out states |
| Roster | Zoom Apps JS SDK participant list + join/leave events |
| Escalation to everyone | Meeting SDK in-meeting chat |

**Verify before you design around it:** whether your Zoom App context can send
meeting chat directly, or whether that needs the Meeting SDK component. Do not
block the demo on this — the panel prompt is the primary channel and chat is a
bonus. Timebox the spike to 30 minutes.

Zoom requires visible disclosure while an app is accessing meeting content
(participant notification / Active App Notifier). Leave it on and mention it in
the demo — it reads as trustworthy, not as a wart.

---

## 3. Attendance comes from Zoom

Previous drafts inferred attendance from who spoke. Don't. Use the participant
list.

- `required[]` — from the Slack project context loaded before the meeting.
- `present[]` — live from the Zoom participant list, updated on join/leave.
- `absent[]` — `required` minus `present`, matched on email where available, display name otherwise.
- `extra[]` — present but not required. Show them, never promote them into `required`.

Panel renders: `5 required · 4 present` and `1 absent: Sara`, absent in
`--li-open-text`.

An absent required person is not a footnote. When a loop's audience is computed,
absentees are included in the post-meeting follow-up — that's the hand-off to the
Polly survey after the call.

---

## 4. Loop state

The whole app is a projection of this object. Keep it flat, keep it serialisable.

```ts
type LoopState = {
  meeting: {
    id: string;
    title: string;
    startedAt: string;        // ISO
    scheduledEndAt: string;   // ISO — REQUIRED, drives "8 minutes remaining"
  };
  people: {
    required: Person[];       // from Slack context
    present: Person[];        // from Zoom participant list
    absent: Person[];         // derived
  };
  agenda: AgendaItem[];
  loops: Loop[];              // open + closed, in detection order
  health: 'ok' | 'open' | 'attn' | 'info';
};

type AgendaItem = {
  id: string;
  label: string;
  status: 'covered' | 'current' | 'uncovered';
  coveredAt?: string;
  confidence: number;         // 0..1 from the detector
};

type Loop = {
  id: string;                 // L-01
  kind: 'owner_missing' | 'date_missing' | 'agenda_uncovered' | 'decision_open';
  status: 'open' | 'asking' | 'awaiting' | 'closed' | 'dismissed' | 'deferred';
  item: string;               // the action item or decision, verbatim-ish
  evidence: string;           // the transcript line that triggered it
  detectedAt: string;
  question: string;           // what to ask humans
  options: string[];          // ALWAYS enumerated — never free text
  audience: string[];         // person ids
  responses: { personId: string; option: string; at: string }[];
  resolution?: { option: string; source: 'verbal' | 'poll'; at: string };
};
```

`options` is never empty and never free text. Answers have to be readable
programmatically to close a loop on screen.

---

## 5. Detection

Run the detector on a rolling window of the last ~90 seconds of transcript, every
few seconds. Three tiers, in this order — cheapest first.

1. **Cue phrases** to shortlist candidate spans: "we should", "let's", "can you", "I'll take", "by Friday", "who owns", "next week", "action item".
2. **LLM extraction** on the shortlisted span only. Return strict JSON: `{ kind, item, owner: string|null, due: string|null, evidence }`. Never let it infer an owner or a date that wasn't said — null is the correct and useful answer.
3. **Debounce before surfacing.** Wait ~60 seconds of conversation past the detection before raising a card. Half of all gaps close themselves in the next breath, and a card that fires on a gap the room is about to fill makes the agent look deaf.

### Loop A — owner missing
Fires when an action item is extracted with `owner: null` and the debounce
expires. `options` = the display names of **present** participants + `Someone
else / not yet decided`.

### Loop B — date missing
Fires when an action item is extracted with `due: null`. `options` = three
concrete dates resolved against today (`Fri 18 Sep`, `Mon 21 Sep`, `Next sprint`)
+ `No date needed`. Never ask for a date as free text — resolve relative language
in the detector, not in the respondent's head.

### Agenda coverage
For each uncovered agenda item, score the rolling window for topical overlap.
Above threshold for ~45 consecutive seconds → `current`. When the conversation
moves on → `covered`. Show `✓` green / `→` blue / `○` grey, and `N of 5 covered`
with a progress bar.

Let the organizer correct it: tapping an agenda row toggles its state. The
detector will be wrong occasionally and a human override is cheaper than better
scoring.

### Guardrails
- Max **3 surfaced cards per 30 minutes**, never two within 5 minutes.
- Never surface the same loop twice. Dismissed → it goes to the post-meeting follow-up, not back on screen.
- Priority when several are eligible: absent stakeholder > agenda at risk > owner missing > date missing > decision open.
- Everything below the bar still accumulates in **Open loops** quietly. The panel is a ledger; only the card is an interruption.

---

## 6. The intervention flow

Five states. The organizer drives; the attendees only ever see step 3.

**1 — Detected.** Card appears in the organizer panel. Status label `Open loop`
in `--li-open-text`, timestamp `just now`, the kind (`Owner missing`), the item in
quotes, and the agent's reasoning in one line: *"I heard an action item, but I
didn't hear an owner."* Health chip flips to `1 open loop`.

Actions: `Assign to ▾` (inline resolve, no poll), `Ask the room`, `Ignore`.

**2 — Compose.** If the organizer taps `Ask the room`: the suggested question
appears, editable, with the options listed. Audience selector: `Everyone` or
`Select participants` with checkboxes, defaulting to present participants.
Checkbox below: *"Also ask absent required participants after the meeting"* —
default on. That checkbox is what connects this to the post-meeting Polly survey.

Actions: `Send`, `Cancel`.

**3 — Asked.** Organizer panel shows `Asked the room · 0 of 3 responded` and
live-updating counts.

Attendees get a toast-style prompt in the panel — *"LoopIn wants your input"* +
the question + `Give input` — and, if the panel is closed, the Zoom Apps
notification badge. Tapping opens the question: one question, one option per row,
full-width buttons, nothing else on screen. On tap: confirmation state, and the
panel returns to idle.

**4 — Resolving.** Health chip reads `Resolving` in `--li-info-text`. Counts tick
up as answers land.

**5 — Closed.** Card flips to the success treatment: green ring animation,
`LOOP CLOSED`, the item title, `Decision: Friday` / `Owner: Hamza`, `Confirmed by
3 participants`, and a `Continue` button that dismisses. The item moves into
**Resolved** in the list below. Health returns to `On track`.

A verbal resolution — someone just says "Hamza will take it" — closes the loop the
same way, with `source: 'verbal'`. Watch for it while a loop is `asking` or
`awaiting`; if it lands, close the loop and mark the poll superseded rather than
waiting for votes. The room outranks the poll.

---

## 7. Panel layout — organizer

Fixed 372px. Two tabs: **Now** / **Outcomes**. Top to bottom in `Now`:

1. **Header** — LoopIn mark (blue broken ring), wordmark, expand / pop-out / close glyphs.
2. **Meeting title**, then `29:08 elapsed · 0:52 left` in `--li-text-2`.
3. **Meeting health** — full-width status chip, label right-aligned, dot + text coloured from the status set. States: `On track` (ok) · `1 open loop` (open) · `Needs attention` (attn) · `Resolving` (info) · `2 loops open` (attn).
4. **Active card** — the intervention, or nothing. At most one at a time.
5. **Agenda** — label + `4 of 5 covered`, 2px progress bar in `--li-blue`, then the rows.
6. **People** — avatar stack, `5 required · 4 present`, absent line in warning colour.
7. **Open loops** — count badge, one row per loop with a coloured dot, collapsible.
8. **Resolved** — count badge, collapsed by default.
9. **Footer** — `LoopIn is listening` with the animating bars, and `Context loaded from Slack`.

`Outcomes` tab: the metrics view — decisions confirmed, items with owners, items
with dates, agenda covered — plus the line *"LoopIn measures whether this meeting
produced complete outcomes — not just what was said."* Build it last; it's the
closing slide of the demo, not a working surface.

### Wrap-up
At ~2 minutes remaining with loops still open, the `Up next` card appears:
*"2 minutes remaining. Two loops are still open."* + `Review wrap-up`. That opens
the wrap-up list with `Close meeting & follow up`, which posts the draft notes to
Slack and fires the post-meeting survey to required stakeholders **including the
absent ones**. End state: *"Handed off to Slack — draft notes posted. Validation
poll sent to 5 required stakeholders, including Sara."*

---

## 8. Design

`design/tokens.css` has the palette, type scale, radii and animations. The rules
that matter:

- The panel is a **light surface in a dark client**. Don't theme it dark.
- Open Sans, 400 / 600 / 700. Body 12px, headings 13px, section labels 11px uppercase with .6px tracking, footer 10px.
- Radii: 10px cards, 7px controls and rows, 99px chips.
- One accent only: `#0b5cff`. Status colours are for status, never decoration.
- Cards animate in with `li-cardIn` (6px rise, fade). The closed state uses `li-ringClose` + `li-checkPop`. Nothing else animates.
- Vertical rhythm: 14px horizontal padding, 9px gaps, hairline `--li-border` between sections.

`design/LoopIn Zoom App.dc.html` is a **prototype, not source**. It's a scripted
scene player with template variables — read it for layout, spacing and copy, don't
port it. Every string in it is final copy; reuse the words verbatim.

---

## 9. Build order

Four milestones. Stop at the end of each and check it renders.

1. **Panel shell + mock state.** Both views, all sections, driven by a hardcoded `LoopState` JSON. No Zoom, no RTMS. This is your fallback demo — get it standing first.
2. **Zoom wiring.** Real participant list, real elapsed/remaining, role detection, panel open/close. Roster section goes live.
3. **RTMS + detector.** Transcript in, Loop A and Loop B firing on real speech, agenda ticking. Use a recorded transcript fixture to test so you're not re-running meetings.
4. **The poll round trip.** Organizer sends, attendees answer in-panel, counts tick, loop closes. This is the demo; leave time for it.

`Outcomes` tab, in-meeting chat escalation and the Slack hand-off are milestone 5
and genuinely optional.

---

## 10. Fixtures

Seed the mock state from the ClosedLoop project files (`closedloop-project.md`,
`sync-04/05/06`). They already contain an unowned item, a date that has slipped
three times, a stale commitment, an absent required attendee and an uncovered
agenda item.

Record one 3-minute transcript that triggers Loop A then Loop B, with a clean
natural pause after each so the debounce reads well on stage. Ship it as
`fixtures/transcript.jsonl` — `{ t, speaker, text }` per line — and make the
detector runnable against it offline. You will need this when the venue wifi
fails.

**Decision points for the team:**

- Cast: the mockup uses Omar / Ayesha / Bilal / Hamza / Sara; the fixtures use Obaid / Zaid / Nouman / Sharjeel. Pick one and make it consistent everywhere before the demo — names are data, but mismatched names on stage read as a bug.
- Demo meeting title: `Events Project Sync` (mockup) vs `ClosedLoop Sync` (fixtures).
- Whether the poll in-meeting is LoopIn-native (fast, self-contained) or goes through Polly MCP (real product tie-in, more moving parts). The panel design assumes native; the post-meeting survey is Polly either way.
- Whether to attempt in-meeting chat escalation at all today.

---

## 11. Acceptance — the demo passes if

1. ☐ The panel shows the real Zoom participant list, with the absent required person named.
2. ☐ Agenda items tick from ○ to ✓ as they're discussed, without anyone touching the panel.
3. ☐ An action item spoken with no owner raises a card within ~60 seconds, and not sooner.
4. ☐ An action item spoken with no date raises its own card.
5. ☐ `Ask the room` sends a question that appears in every attendee's panel within 2 seconds.
6. ☐ Attendee answers move the organizer's counter live.
7. ☐ The loop closes on screen with the answer shown, and moves to Resolved.
8. ☐ A loop resolved verbally closes without a poll.
9. ☐ Nothing fires more than 3 times in 30 minutes.
10. ☐ Attendees never see the dashboard.
