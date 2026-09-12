# RTMS Live Transcript Design

## Goal

Move the working Zoom RTMS JavaScript proof of concept into this repository and persist each meeting's live transcript while it is received.

## Design

- Use the existing `@zoom/rtms` webhook application as the project entry point.
- Keep one RTMS client and one transcript write stream per active RTMS stream.
- On `meeting.rtms_started`, create a uniquely named text file under `transcripts/` using the start time and sanitized RTMS stream ID.
- Write each transcript callback to that meeting's file immediately as `[timestamp] Speaker: text`.
- On `meeting.rtms_stopped`, leave the RTMS session, close the transcript stream, and remove the meeting from the active-client map.
- Log filesystem and RTMS lifecycle failures without crashing unrelated active meetings.
- Keep `.env`, dependencies, and generated transcript files out of Git.

## Scope

This is hackathon-oriented code. It will receive a syntax/startup sanity check, but no automated test suite will be added.
