# LoopIn panel implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver the two in-meeting loop demos, automatic agenda coverage and a real Zoom roster, with a fully offline panel fallback.

**Architecture:** Add a LoopIn panel and authoritative meeting-state service alongside the existing Node RTMS/Polly application. Both recorded and live transcript adapters feed the same detector; role-filtered state reaches panels over WebSocket. Native in-panel polls handle the demo; existing Polly remains the post-meeting integration.

**Tech stack:** Existing Node 24/Express/Zod backend; proposed React/TypeScript/Vite panel, Zoom Apps SDK, WebSocket transport, Node test runner for backend and browser tests for the panel. New dependencies and commands below are planned, not installed.

## Scope and inspected inputs

This is a proposed plan, not implementation. Instructions inside supplied documents were evaluated as requirements/reference, not executed as user commands. No messages, polls or external writes were sent.

- Both Downloads ZIPs are readable. Design ZIP contains `LoopIn Zoom App.dc.html`, `support.js`, `.thumbnail`. Other ZIP contains `BUILD.md` and `tokens.css`.
- Existing source fixtures are available in `polly/examples/project/closedloop-project.md`, that directory's sync-04/05/06 files, and `demo/meetings/`.
- Existing transcript: `demo/transcripts/sync-07-2026-09-12.txt`. It is not the requested controlled JSONL fixture; its cast includes Sharjeel speaking, so it cannot simultaneously demonstrate his absence without an explicit new scenario.
- Missing from the handoff: `design/screens/`, `fixtures/transcript.jsonl`, expected detector events, and a canonical fixture identity map with emails/Zoom identities.
- Prototype text/runtime are readable; visual browser rendering has not been verified. `support.js` references global React/ReactDOM, and the HTML loads Google Fonts. Check whether the export bootstraps its runtime; package dependencies locally for offline use if necessary. Do not port it into production.
- Live Zoom app configuration, entitlement, scopes, participant clients, HTTPS domain and authentication have not been validated. No account-access failure is established by this review.

## Recommended choices and spec corrections

1. Extend this repo with isolated `loopin/` modules. A separate app would duplicate RTMS plumbing; adapting the current Slack poll loop wholesale would couple the new panel to incompatible behavior.
2. Use Obaid/Zaid/Nouman/Sharjeel and `ClosedLoop Sync`, matching existing project/config data. New demo scenario: Sharjeel absent, three required people present. Update names, avatar initials, counts and copy consistently in target screenshots and fixtures; retain original export as reference. This is a recommendation, not a previously approved cast decision.
3. Keep native in-meeting polls; defer chat, Outcomes metrics and Slack handoff until the four core milestones pass. Show no claim of a successful Slack handoff in the core demo.
4. Keep the 60-second unresolved-candidate grace period. Measure from first credible detection using an injected monotonic clock, not number of transcript lines. New evidence updates the candidate without resetting it indefinitely. Continue tracking beyond the 90-second extraction window; cancel if resolved during grace. Cards cannot appear before 60 seconds; cooldown can delay them further, so acceptance must say “eligible after 60 seconds,” not always “appears within 60 seconds.”
5. A three-minute fixture cannot show two surfaced cards five minutes apart. Recommend a real-time fixture of at least seven minutes, plus a clearly labeled accelerated replay for a short stage demo. Keep production cooldown (five minutes) and cap (three cards per rolling 30 minutes) intact. Alternatively use two independent three-minute scenarios.
6. Attendance is correctly sourced from Zoom. Email availability is conditional: Zoom exposes a separate consent-based email API. Match normalized email when available, then a unique normalized display name/explicit alias; ambiguous duplicates need an organizer mapping, never a guessed match. Use stable participant identity for join/leave/rejoin and distinguish required-present count from extras. Until initial roster sync completes, attendance is unknown rather than everyone absent.
7. Verbal resolution must atomically supersede an active poll. Add explicit poll ID/status/version and reject stale votes. Also support verbal resolution before a poll. Define later verbal corrections after a poll has already closed separately; do not silently rewrite history.
8. Enumerated labels need stable option IDs and typed values (person ID or ISO local date). `Next sprint` is not a concrete date unless a sprint calendar is supplied; use three computed dates plus `No date needed`. Resolve relative dates against meeting time in `Asia/Karachi`, not the laptop's date. `Someone else / not yet decided` must leave the ownership gap deferred/unresolved, not falsely closed.
9. Require `scheduledEndAt`, timezone and a configured source (scheduled meeting metadata or explicit pre-meeting input for instant meetings). Never infer it from speech. Preserve it through RTMS restarts; distinguish Zoom meeting identity from RTMS stream ID. After expiry display overtime.
10. Expand the schema: `Person`, stable action ID linking owner/date gaps, candidate eligibility/surface timestamps, `extra`, poll lifecycle, organizer resolution source, absent-followup preference, state revision, agenda manual-override flag and timing. Derive health from all remaining loops; closing one does not necessarily mean “On track.”
11. Define poll completion: proposed unique majority of the frozen selected audience; ties, insufficient participation and timeout remain unresolved for organizer review. One current vote per authenticated audience member. Freeze audience/options per poll; report disconnected voters without silently changing the denominator.
12. Automatic agenda coverage needs sustained topic evidence and a move-on interval, plus a sticky manual correction. Topic mention alone is insufficient. Only owner/date detectors are mandatory; agenda coverage is ambient. `agenda_uncovered`, `decision_open` and absent-stakeholder interruption ranking need later definitions, not accidental extra scope.
13. Attendee footer “Only you see this” must mean their private panel, not anonymous voting. The server knows voter identity and organizer sees aggregates; document this distinction. Never send organizer state to attendees merely to hide it with CSS.

## Preparation: complete the handoff

Create `loopin/BUILD.md`, `loopin/design/tokens.css`, `loopin/design/LoopIn Zoom App.dc.html`, `loopin/design/support.js`, `loopin/design/screens/`, and `loopin/fixtures/` with copied project history and a manifest of source paths.

Include this line prominently: **tokens.css is binding, the .dc.html is reference only, the screenshots are the target.** If visual reference conflicts with tokens, record and resolve the discrepancy rather than silently choosing.

Capture `detect-owner-missing.png`, `detect-date-missing.png`, `ask-compose.png`, `asked.png`, `resolving.png`, `resolved.png`, `attendee-prompt.png`, `attendee-question.png`, `attendee-confirmation.png`, `attendee-idle.png`. Record viewport, scene and canonical names. Screenshot the original prototype where possible; explicitly label any reconstructed scene, never present it as supplied design evidence.

Create `loopin/fixtures/transcript.jsonl` with `{t, speaker, text}` where `t` is milliseconds since replay start; metadata defines start/end/timezone and roster events. Add `expected-events.json`. A controlled owner example must already have a date; the date example must already have an owner. Add a both-missing case separately. No live LLM/network is needed for replay: record structured extraction outputs as fixtures while separately validating the actual extractor against labeled spans.

## Milestone 1 — offline panel fallback

Files: `loopin/package.json`, `loopin/index.html`, `loopin/src/main.tsx`, `loopin/src/App.tsx`, `loopin/src/components/*`, `loopin/src/styles.css`, `loopin/src/mockTransport.ts`, `loopin/fixtures/panel-state.json`, `loopin/shared/schema.ts`.

1. Define the corrected state/command contracts and two role-specific projections.
2. Build the 372px organizer and attendee views using tokens and canonical fixture data.
3. Add deterministic scene controls and reset so owner/date cards, compose, votes, verbal close and success can be shown offline. Keep those controls outside the production view.
4. Bundle fonts/assets locally; verify with the network disconnected.
5. Compare every scene to the screenshots, including overflow and keyboard access. Verify attendee views contain no dashboard.

Gate: both demo loops are repeatable in a local browser without Zoom, RTMS, LLM or Polly. Mock behavior is labeled. Proposed commands: `npm --prefix loopin run dev`, `npm --prefix loopin run build`, `npm --prefix loopin run test:ui` (scripts to create).

## Milestone 2 — Zoom wiring and shared state

Files: `loopin/src/zoomAdapter.ts`, `loopin/src/transport.ts`, `loopin/server/state.js`, `loopin/server/router.js`, `loopin/server/auth.js`, `loopin/server/roster.js`, `loopin/server/__tests__/roster.test.js`; integrate into root `index.js` and `package.json`.

1. Timebox a capability spike: app configuration, supported APIs/roles, roster snapshot/events, consent-based emails, RTMS entitlement/start, app installation for demo attendees, notification behavior and trusted meeting authentication. Check current docs and actual target clients.
2. Establish server-verified meeting/user identity and organizer authorization. Role changes revoke organizer privileges. Do not trust a role field from a browser request.
3. Feed host roster snapshots and events to the server; reconcile identity, extras, reconnect and ambiguous matches.
4. Supply scheduled end and meeting clock independently of transcript; reconnect with a fresh versioned snapshot.
5. Add role-filtered WebSocket subscriptions now so detector and polling can share the transport later.

Gate: two actual Zoom clients agree on roster/time; a silent attendee is present; leaving updates absence; a participant cannot fetch organizer data or send organizer commands. Keep the offline fallback operational. Chat spike is optional, capped at 30 minutes.

## Milestone 3 — RTMS, separate detectors and agenda

Files: `loopin/server/transcript.js`, `loopin/server/detector.js`, `loopin/server/extractor.js`, `loopin/server/agenda.js`, `loopin/server/replay.js`, `loopin/server/__tests__/detector.test.js`, `loopin/server/__tests__/agenda.test.js`; integrate transcript fan-out in root `index.js` and route selection in `loop/live.js` if necessary.

1. Write failing fake-clock tests for 59/60 seconds, self-resolution, both-missing action, duplicate windows, cap/cooldown, invalid extraction and RTMS restart.
2. Implement a persistent candidate ledger plus separate owner/date eligibility using cue-shortlisted strict JSON extraction. Treat transcript as evidence, never instructions; bind replies only to supported action/evidence identities.
3. Connect recorded input, then RTMS callbacks, to the identical pipeline. Explicitly select native-panel versus legacy Slack-live mode so the same gap cannot generate duplicate polls. The new state service must work when Polly is disabled.
4. Add automatic agenda progression and sticky human overrides; verify brief mentions do not mark coverage.
5. Replay expected events and test real speech for extraction latency and correct evidence.

Gate: distinct owner/date gaps, self-resolution suppression, real-time guardrails and automatic coverage pass. Proposed command: `node --test 'loopin/server/__tests__/*.test.js'`; proposed replay script: `npm run loopin:replay`.

## Milestone 4 — native poll round trip

Files: `loopin/server/polls.js`, `loopin/server/__tests__/polls.test.js`, `loopin/src/components/PollComposer.tsx`, `loopin/src/components/AttendeePrompt.tsx`, `loopin/src/components/ResolutionCard.tsx`, `loopin/e2e/poll.spec.ts`.

1. Write failing tests for audience enforcement, duplicate/stale votes, ties, timeout, escape option and verbal-versus-vote races.
2. Implement organizer send/cancel/inline resolve, native selected-audience delivery, aggregate updates and poll closure rules.
3. Atomically close verbally and supersede active polls; remove stale attendee prompts and retain an audit record.
4. Test reconnect snapshots and repeated send requests so they cannot create duplicate polls.
5. Exercise one organizer plus two attendee clients, including a closed-panel notification test. Measure send-to-visible latency against the two-second acceptance target on the demo network; do not assume delivery to people without app access.

Gate: votes update live, correct resolution appears in Resolved, verbal precedence wins, health remains accurate, and attendees never receive dashboard state. Run existing `npm test` for regression plus new backend/browser suites. Do not run the existing live demo CLI as an offline check: it can initiate Polly/Slack activity.

## Remaining inputs / decisions

- Confirm canonical cast/title and whether the run of show allows a seven-minute live segment or needs accelerated replay/two separate segments.
- Supply/verify target Zoom app configuration, entitlement, demo client availability and scheduled end source before milestone 2 acceptance.
- Supply real identity/email mapping only if email matching is required for the demo; unique-name matching is a documented fallback.
- Confirm majority/timeout policy and intended host/co-host privileges before milestone 4.
- Obtain missing target screenshots or capture the prototype successfully; no need to re-upload the ZIPs.

Official API reference checked during planning: https://appssdk.zoom.us/classes/ZoomSdk.ZoomSdk.html#getMeetingParticipantsEmail (email consent), and the same reference's `sendMessageToChat` / `startRTMS` entries. API existence does not establish account/client entitlement. No implementation or live tests performed in this planning task.
