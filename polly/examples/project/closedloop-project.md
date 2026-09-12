# 🔁 ClosedLoop — Project Source of Truth

**Status:** Demo day — Saturday 12 September 2026
**Started:** Monday 24 August 2026
**Cadence:** Twice weekly, Tuesday and Thursday, 30 minutes
**ID prefix:** `CL`

---

## What this is

A loop runtime for recurring meetings. The agent holds persistent state across a
meeting series, intervenes live when that state is ambiguous (missing owner,
unresolved decision, uncovered agenda item), fires a poll after the meeting to
resolve what the room couldn't, and writes the confirmed outcome back to a Slack
canvas as the durable record.

The one-line pitch: **Slack knows what the meeting needs to accomplish → Zoom
makes sure it happens → Polly resolves what the meeting couldn't → Slack becomes
the durable record.**

---

## Team

| Name | Role | Lane | Handle |
|---|---|---|---|
| Obaid | PM / QA / demo | Loop content, fixtures, run of show, submission | `@obaid` |
| Zaid | Engineering | Runtime, loop-state store, extraction | `@zaid` |
| Nouman | Engineering | Zoom RTMS, side panel, interventions | `@nouman` |
| Sharjeel | Engineering | Slack canvas, Polly MCP | `@sharjeel` |

**Required attendees for every sync:** Obaid, Zaid, Nouman, Sharjeel
**Required for launch/ship decisions:** Sharjeel (owns the canvas + fallback path)

---

## Meeting series

| # | Date | Day | Attendance | Notes |
|---|---|---|---|---|
| 1 | 2026-08-25 | Tue | 4 / 4 | Kickoff, scope, lanes |
| 2 | 2026-08-27 | Thu | 4 / 4 | Integration risk review |
| 3 | 2026-09-01 | Tue | 4 / 4 | Contract freeze |
| 4 | 2026-09-03 | Thu | 4 / 4 | 📋 [sync-04 notes] — enriched from poll |
| 5 | 2026-09-08 | Tue | 3 / 4 | 📋 [sync-05 notes] — Sharjeel absent |
| 6 | 2026-09-10 | Thu | 3 / 4 | 📋 [sync-06 notes] — Sharjeel absent (2nd) |
| 7 | 2026-09-12 | Sat | — | **Demo day sync — today** |

---

## Today's agenda (sync #7)

1. RTMS entitlement — final status (`CL-A-01`)
2. Canvas write path — where did the spike land (`CL-A-02`)
3. **Decide: live RTMS or recorded fallback for the demo** (`CL-Q-03`)
4. Demo rehearsal and run of show
5. Launch communications — submission post, video, social

---

## Open decisions

| ID | Decision | Status |
|---|---|---|
| CL-D-01 | Zoom RTMS is the primary transcript source; OpenAI streaming is the fallback | ✅ Confirmed 2026-08-25 |
| CL-D-02 | Slack canvas is the durable record; the poll resolves what the meeting couldn't | ✅ Confirmed 2026-09-01 |
| CL-D-03 | Interventions land in the Zoom side panel by default; only high-value ones escalate to meeting chat | ✅ Confirmed 2026-09-03 |
| CL-D-04 | Post-meeting poll audience includes required attendees who missed the meeting | ✅ Confirmed 2026-09-08 |

---

## Action register

| ID | Item | Owner | Due | Priority | Status |
|---|---|---|---|---|---|
| CL-A-01 | Confirm Zoom RTMS entitlement and credits on the account | @nouman | 2026-09-11 *(3rd slip: 08-27 → 09-03 → 09-08 → 09-11)* | P0 | 🔴 Open |
| CL-A-02 | Slack canvas write/edit path spike — channel canvas vs standalone | @sharjeel | 2026-09-10 *(1 slip)* | P1 | 🟡 Stale — no update for 2 meetings |
| CL-A-03 | Launch-readiness review and dry run | ⚠️ MISSING *(unowned for 3 meetings, 2 poll rounds)* | 2026-09-11 ᵖ | P1 ᵖ | 🔴 Open |
| CL-A-04 | Validate Polly MCP question types against the intervention flow | @nouman | 2026-09-10 | P1 | 🟡 Stale — no update since committed |
| CL-A-05 | Seed fixtures and expected-output file | @zaid | 2026-09-08 | P2 | ✅ Closed 2026-09-10 |
| CL-A-06 | Freeze the loop-state schema | @zaid | 2026-09-08 | P0 | ✅ Closed 2026-09-08 |
| CL-A-07 | Zoom side-panel skeleton with the three-bucket layout | @nouman | 2026-09-11 | ⚠️ MISSING | 🔴 Open |
| CL-A-08 | Intervention cooldown and priority-ordering logic | @zaid | ⚠️ MISSING | ⚠️ MISSING | 🔴 Open |
| CL-A-09 | Demo script and poll question copy | @obaid | 2026-09-11 | ⚠️ MISSING | 🔴 Open |

ᵖ = filled from a poll, not stated in the meeting.

---

## Open questions

| ID | Question | Raised | By |
|---|---|---|---|
| CL-Q-01 | Can the Zoom App context send meeting chat directly, or does that need the Meeting SDK component? | 2026-09-03 | Nouman |
| CL-Q-02 | CL-A-03 owner — poll came back tied 2–2. Needs a human call. | 2026-09-08 | — (poll) |
| CL-Q-03 | Demo on live RTMS or the recorded fallback? Weighed on 09-10, no call made. Sharjeel required and absent. | 2026-09-10 | Zaid |

---

## Attendance watch

- **Sharjeel** — missed 2026-09-08 and 2026-09-10. Two consecutive. Owns `CL-A-02` (stale) and is required for `CL-Q-03`, today's ship decision.

---

## Loop state (machine-readable)

```json
{
  "project": "closedloop",
  "prefix": "CL",
  "required_attendees": ["obaid", "zaid", "nouman", "sharjeel"],
  "last_meeting": "2026-09-10",
  "attendance_streaks": {"sharjeel": {"consecutive_absences": 2}},
  "open_items": [
    {"id": "CL-A-01", "item": "Confirm Zoom RTMS entitlement and credits", "owner": "nouman", "due": "2026-09-11", "due_history": ["2026-08-27", "2026-09-03", "2026-09-08", "2026-09-11"], "priority": "P0", "status": "open", "meetings_without_update": 0, "first_raised": "2026-08-25"},
    {"id": "CL-A-02", "item": "Slack canvas write/edit path spike", "owner": "sharjeel", "due": "2026-09-10", "due_history": ["2026-09-08", "2026-09-10"], "priority": "P1", "status": "stale", "meetings_without_update": 2, "first_raised": "2026-09-01"},
    {"id": "CL-A-03", "item": "Launch-readiness review and dry run", "owner": null, "due": "2026-09-11", "due_history": ["2026-09-11"], "priority": "P1", "status": "open", "meetings_without_update": 0, "first_raised": "2026-09-03"},
    {"id": "CL-A-04", "item": "Validate Polly MCP question types", "owner": "nouman", "due": "2026-09-10", "due_history": ["2026-09-10"], "priority": "P1", "status": "stale", "meetings_without_update": 1, "first_raised": "2026-09-08"},
    {"id": "CL-A-07", "item": "Zoom side-panel skeleton", "owner": "nouman", "due": "2026-09-11", "due_history": ["2026-09-11"], "priority": null, "status": "open", "meetings_without_update": 0, "first_raised": "2026-09-10"},
    {"id": "CL-A-08", "item": "Intervention cooldown and priority-ordering logic", "owner": "zaid", "due": null, "due_history": [], "priority": null, "status": "open", "meetings_without_update": 0, "first_raised": "2026-09-10"},
    {"id": "CL-A-09", "item": "Demo script and poll question copy", "owner": "obaid", "due": "2026-09-11", "due_history": ["2026-09-11"], "priority": null, "status": "open", "meetings_without_update": 0, "first_raised": "2026-09-10"}
  ],
  "open_questions": [
    {"id": "CL-Q-01", "question": "Zoom App context vs Meeting SDK for sending meeting chat", "raised": "2026-09-03", "by": "nouman"},
    {"id": "CL-Q-02", "question": "CL-A-03 owner — poll tied 2-2", "raised": "2026-09-08", "by": "poll"},
    {"id": "CL-Q-03", "question": "Live RTMS or recorded fallback for the demo", "raised": "2026-09-10", "by": "zaid", "required": ["sharjeel"]}
  ],
  "gaps": [
    {"gap_id": "CL-A-03.owner", "item": "Launch-readiness review and dry run", "field": "owner", "ask": "Who owns the launch-readiness review?", "options": ["Zaid", "Nouman", "Sharjeel", "Obaid", "Someone else / not decided"], "audience": ["obaid", "zaid", "nouman", "sharjeel"], "rounds_asked": 2},
    {"gap_id": "CL-A-07.priority", "item": "Zoom side-panel skeleton", "field": "priority", "ask": "What priority is the Zoom side-panel skeleton?", "options": ["P0 — blocks the demo", "P1 — needed today", "P2 — nice to have", "Drop it"], "audience": ["nouman"], "rounds_asked": 0},
    {"gap_id": "CL-A-08.priority", "item": "Intervention cooldown logic", "field": "priority", "ask": "What priority is the intervention cooldown logic?", "options": ["P0 — blocks the demo", "P1 — needed today", "P2 — nice to have", "Drop it"], "audience": ["zaid"], "rounds_asked": 0},
    {"gap_id": "CL-A-08.due", "item": "Intervention cooldown logic", "field": "due_date", "ask": "When is the intervention cooldown logic due?", "options": ["Fri 11 Sep", "Sat 12 Sep — before the demo", "After the hackathon", "No date needed"], "audience": ["zaid"], "rounds_asked": 0},
    {"gap_id": "CL-A-09.priority", "item": "Demo script and poll question copy", "field": "priority", "ask": "What priority is the demo script and poll copy?", "options": ["P0 — blocks the demo", "P1 — needed today", "P2 — nice to have", "Drop it"], "audience": ["obaid"], "rounds_asked": 0}
  ]
}
```
