# LoopIn

A Zoom side panel that closes missing-owner and missing-date loops in the meeting. Includes a local scene player that works without Zoom, RTMS, an LLM, Polly or internet access after installation.

**tokens.css is binding, the .dc.html is reference only, the screenshots are the target.**

UI reference: [the user's Claude design project](https://claude.ai/code/artifact/29a57b2b-8e72-4062-9b7f-5b8eba4dabaf). The original exported prototype is preserved under `design/`. Production UI is independently implemented in React; its runtime does not execute the prototype or download scripts/fonts from a CDN.

## Run the fallback demo

Use Node 24 or later (the root repo requirement).

```sh
npm ci
npm --prefix loopin ci
npm run loopin:build
npm run loopin:serve
```

Open `http://127.0.0.1:9798/loopin/`. Development with hot reload: `npm run loopin:dev`, then `http://127.0.0.1:5173/loopin/`.

Click **Skip ahead** to show the owner-missing card. **Ask the room → Send → Give input → Zaid**, then **Simulate Zaid’s response** demonstrates the vote majority and closed loop. Continue to the date scenes. **Resolve verbally** exercises supersession while a poll is active. Back/Restart reset the scene deterministically. **Play accelerated scenes** is explicitly a scripted presentation, not a claim of real-time detector timing.

The role switches and simulated answers only exist in demo mode. The Zoom End label is decorative and never ends a meeting. Live mode does not show simulated participant tiles or role switches.

## Detector replay and tests

```sh
npm run loopin:replay
npm test
npm run loopin:build
```

Replay uses the seven-minute `fixtures/transcript.jsonl`, recorded strict extraction outputs and a virtual clock. It asserts `fixtures/expected-events.json`: owner surfaces at 110s, is verbally resolved at 140s, and date surfaces at 410s. Agenda coverage advances from repeated topical evidence. It does not invoke an LLM or send any external poll. The separate engine tests exercise both-missing, transient gaps, majority, escape, timeout, duplicate votes, supersession, privacy and production cap/cooldown. HTTP/WebSocket tests bind local loopback ports.

The existing `npm run loop -- demo ...` command belongs to the legacy Slack/Polly flow and can send external polls. It is not the offline LoopIn replay.

## Live Zoom setup

The code is wired; account-level acceptance must be performed on real Zoom clients.

1. Copy `loopin/meeting.example.json` to `loopin/meeting.local.json` (ignored). Set the exact **Zoom meeting UUID**, actual meeting start, scheduled end, timezone, roster and agenda. Instant meetings still require a scheduled end. These timestamps are supplied configuration, not extracted from speech. The code reports overtime after the end.
2. Set each person's `zoomUserId` to their account user ID used by encrypted Zoom context. This is distinct from meeting participant UUID. Optional verified `email` supports email-first matching; otherwise exact unique display names match. Add non-required people to `identities` with `id`, `name`, `zoomUserId` (and optional email). They remain extras in attendance. Unmapped people appear in the roster but are disabled as poll recipients. Duplicate names are never guessed; configure email or unique Zoom display names for those users.
3. Set these locally in `.env`:

```dotenv
LOOPIN_CONFIG=loopin/meeting.local.json
ZOOM_APP_CLIENT_ID=your_zoom_apps_client_id
ZOOM_APP_CLIENT_SECRET=your_zoom_apps_client_secret
```

4. Retain the existing RTMS variables in root `.env.example` and verify RTMS entitlement, consent and `meeting:read:meeting_transcript` scope in the Zoom app. Keep Zoom's content-access disclosure enabled.
5. Build the frontend and start the root RTMS server with `npm start`. Expose that server through the team's configured HTTPS development domain. Set the Zoom App Home URL to `https://YOUR_DOMAIN/loopin/?mode=live`; add the same origin to the app's allowlist. The standalone server is for preview only; the root server ingests RTMS.
6. Configure/allow the SDK capabilities listed in `src/zoomAdapter.ts`. They include participant snapshot/events, encrypted app context, consent-based email, role changes, notifications, expand/pop-out/close and RTMS start. Hosts and co-hosts render the organizer view; account and client restrictions can limit roster access. If email consent is declined, unique-name matching remains available.
7. Install/open the app for every intended voter. Click **Start listening** in the organizer footer to request RTMS. `LoopIn is listening` only appears once the backend receives the matching RTMS stream start. Native-panel mode suppresses legacy Slack live polls for this configured meeting only. Other meetings keep their prior behavior. Post-meeting legacy notes/Polly behavior is unchanged; set `POLLY_ENABLED=false` if rehearsing only the native panel.
8. Verify on one organizer and two participant clients: silent attendee is present, leave/rejoin reconciles, absent required person is named, attendee cannot fetch dashboard state, poll appears within two seconds on the demo network, votes update, spoken resolution supersedes the poll, and role demotion removes privileges.

The server decrypts and verifies the Zoom context (issuer, audience, meeting, identity, expiry, issuance freshness), rather than trusting client-supplied roles. Clients refresh context every ten seconds. Older claims cannot undo a newer role update. An authenticated host's participant snapshot is the roster source. Participant panels receive only their own prompt/answer status; organizer panels receive aggregate counts, not a raw voter-response ledger. Guest mode without a verified mapped Zoom account is not supported by this initial live integration.

## Behavior

- Owner and date gaps are separate records linked by stable action ID.
- A gap is eligible after 60 seconds unresolved; suppression/early resolution cancels it. Only one automatic card is active, with a five-minute separation and three cards per rolling 30 minutes. Manual review is organizer-initiated and does not create a new detection.
- Votes use stable option IDs. A unique strict majority of the frozen audience closes the gap. Ties/no majority expire after two minutes and remain reviewable. Escape answers defer; they never invent an owner. Deferred items can still resolve verbally or by organizer action.
- Spoken commitments outrank an active poll. Superseded/expired poll IDs reject late votes. Later changes after a closed resolution are not automatically interpreted as corrections.
- Date choices are three concrete dates (tomorrow, +3 days, +7 days) in the meeting timezone, plus No date needed. Relative dates extracted by the LLM are validated as ISO dates; unsupported identities/evidence/schema are rejected.
- Agenda needs repeated topic evidence for 45 seconds, then 30 seconds without topic evidence to mark covered. Manual correction stays authoritative for the meeting.
- Poll and organizer resolutions update the extractor's known action context, preventing it from forgetting earlier commitments.

## Current limits

Live account entitlement, installation, real role transitions, notification behavior and the two-second venue latency target have not been tested in an actual Zoom meeting. Live extraction uses the repo's existing configured Codex CLI runner; replay tests recorded extraction outputs, not live model accuracy. The extractor coalesces pending windows instead of accumulating a backlog. The active state is in memory: browser/network reconnect recovers it, RTMS restart keeps the meeting state, but a backend process restart resets it. Keep one backend process for the demo.

Slack context is seeded from the supplied project files in this build, so the UI says Project context loaded. The follow-up checkbox is retained as intent; this panel does not itself send absent-person surveys or publish Slack notes. The existing root post-meeting pipeline remains separate. Native chat escalation, a full Slack handoff and advanced decision/agenda-risk detectors are outside the four core milestones.

## Browser acceptance harness

`e2e/browser-checks.js` is the shared, browser-driven acceptance scenario. It was executed through the Codex browser surface; `e2e/results.json` records that run and `design/screens/` holds its captures. It interacts through visible UI rather than mutating React state. A Playwright wrapper is also supplied for CI/local reruns:

```sh
cd loopin
npx playwright install chromium
npm run test:ui
```

That wrapper requires a Playwright-managed browser; the recorded run used Codex's browser instead. Capture viewport: 1280 × 720. A poll majority received while prior transcript evidence is being extracted waits for that evidence to settle, so the already-spoken verbal resolution can supersede it.
