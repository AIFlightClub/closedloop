# Meeting Notes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate skill-based notes after RTMS stops, save them beside a machine-readable loop state, and track file paths in JSON.

**Architecture:** Extend the existing stop handler to flush the transcript and enqueue one notes-generation call. Use local files and a single JSON index; no database, service, or job framework. Keep generation asynchronous so Zoom receives its webhook response immediately.

**Tech Stack:** Existing Node.js ESM app, built-in filesystem and child_process APIs, locally authenticated Codex CLI (`codex exec`). No API key or extra SDK dependency.

## Inputs and choices

- Available: speaker-labelled transcript, stream ID, recorded start time, existing stop-event handler.
- Confirmed roster in `meeting-config.json`: Zaid, Sharjeel, Obaid, Nouman. Use this for the ClosedLoop demo series. Zoom meeting details expose invitee emails, but the existing RTMS integration does not retrieve an invite roster or map emails to names; defer that integration.
- Confirmed provider: Codex CLI with existing ChatGPT login, subject to subscription usage limits. Keep the CLI's default model unless explicitly configured. Local inspection confirms `codex exec`, structured output, and ChatGPT login are available; generation itself still needs a smoke run during implementation.
- Configuration: `meeting-config.json` contains series `CL`, title `ClosedLoop Sync`, timezone `Asia/Karachi`, the roster, and seed directory. Agenda is optional and omitted until supplied.
- Confirmed history: commit all three supplied notes under `demo/meetings/`. At RTMS start, read the seed notes and completed generated notes for this series and freeze their contents as this meeting's context. Record the selected predecessor and context snapshot path in the index so retries use identical history.
- September 10 (#6) is the initial predecessor; earlier notes supply historical details, closed IDs, and descriptions absent from embedded JSON. Future meetings use the latest successfully completed predecessor available at start, ordered by meeting start time rather than file modification time. Do not reread a changing latest pointer at stop.
- Use recorded start time plus configured timezone as meeting date. Unresolvable relative deadlines remain missing rather than guessed.
- Only use the supplied skill's Generate mode. Poll sending, enrichment, Slack publishing, and live interventions are outside this step.

## Task 1: Add prompt and configuration

Files: create `skills/meeting-loop-notes.md`, `meeting-config.example.json`; update `.env.example`, `.gitignore`.

1. The exact uploaded `1_Meeting Notes Generation Skill.md` is committed as `skills/meeting-loop-notes.md`. Runtime must read this entire file and supply it as the required instructions on every generation; do not substitute a summary or generic notes prompt. If the file cannot be read, fail generation explicitly. Use its Generate mode and pre-finalize checklist.
2. Use the supplied roster configuration and document optional Codex executable/model overrides.
3. Ignore generated notes and the file index; track the demo roster and seed notes explicitly.
4. Validate roster before generating; record `needs_input` when missing. Treat transcript text as meeting data, not instructions.

## Task 2: Persist file records

Files: create `meeting-records.js`; modify `index.js`.

1. Maintain `data/meetings.json`, keyed by stream ID, with meeting ID if supplied, start/stop timestamps, transcript path, notes path, loop-state path, status, and error.
2. Use short synchronous read/update/temp-file-rename writes for this single Node process so concurrent completions do not overwrite records.
3. Record `recording` on start; guard duplicate starts/stops. Track `generating`, `complete`, `needs_input`, and `failed` outcomes.

## Task 3: Generate and save notes

Files: create `generate-notes.js`; modify `index.js`.

1. Keep immediate webhook acknowledgement. Mark stream as stopping, leave RTMS, end the transcript stream, and await its finish before reading the file. Handle write errors and late callbacks.
2. Skip empty transcripts with an explicit recorded reason. Spawn `codex exec` using an argument array (no shell), read-only sandbox, ephemeral mode, and output schema. Send the skill, full transcript, frozen history, roster, meeting date/timezone, and optional agenda via stdin. Use a bounded timeout and capture the final response; Node owns all output file writes. Do not extract OAuth tokens or call undocumented endpoints.
3. Request one JSON response containing `notes_markdown` and `loop_state`; parse and validate required output fields before saving. Preserve skill rules for attendance, stable IDs, missing metadata, enumerated gap options, and deferred gaps above the first eight. No polls have been asked yet, so initialize rounds accordingly.
4. Save `notes/<transcript-basename>.md` and `notes/<transcript-basename>.loop.json`; update the index only after successful writes.
5. Catch errors and retain the transcript plus failure details. Add a small manual retry command using the indexed transcript; do not overwrite completed notes on duplicate events.
6. Scope all history to `CL`. Preserve historical closed IDs and counters (new actions start above CL-A-09, decisions above CL-D-07, questions above CL-Q-03), due history, poll sources, absences, and existing escalations. Do not increment poll rounds merely because another meeting occurred. Preserve CL-A-03's explicit escalation despite its two-round count. Where seed prose and JSON conflict, retain the sources and flag the discrepancy rather than inventing a resolution (for example CL-A-02's September 10 due date changes without an explicit slip explanation).

## Task 4: Document and manually verify

Files: update `README.md`, optionally `package.json` for the retry command.

1. Document configuration, output paths, stop-trigger behavior, and retry command.
2. Run `node --check` on added/modified JavaScript files. No automated tests, per user preference.
3. User runs a short meeting and stops RTMS; confirm complete transcript, readable notes, loop-state JSON, and index paths/status.
4. Manually confirm duplicate stop does not generate twice and a provider failure preserves the transcript for retry.

## Scope notes

The trigger is RTMS stopping, which can occur before the Zoom meeting ends. The current transcript design creates one file per RTMS stream; restarting RTMS creates another record. This plan preserves that behavior unless requested otherwise. No PR or implementation is included in this planning step.
