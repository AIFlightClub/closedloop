# RTMS Live Transcripts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run the existing Zoom RTMS proof of concept from this repository and continuously save a separate transcript file for each meeting.

**Architecture:** Replace the current application files with the working RTMS POC while retaining this repository's Git history and planning docs. Track each active RTMS stream as an object containing its client and transcript write stream; write transcript callbacks immediately and close resources when Zoom signals that the stream stopped.

**Tech Stack:** Node.js, ES modules, `@zoom/rtms`, Node `fs` streams

---

### Task 1: Import the working POC

**Files:**
- Replace: `index.js`, `package.json`, `package-lock.json`, `.env.example`, `.gitignore`, `README.md`
- Create locally: `.env`, `ngrok.yml`
- Remove: `index.ts`, `tsconfig.json`

**Steps:**

1. Copy the POC contents, excluding its `.git` directory and `node_modules`.
2. Preserve the current repository's `.git` directory and tracked `docs/` files.
3. Confirm `.env` and `node_modules` remain ignored.

### Task 2: Persist live transcripts

**Files:**
- Modify: `index.js`
- Modify: `.gitignore`
- Modify: `README.md`

**Steps:**

1. Import `createWriteStream`, `mkdirSync`, and `join` from Node's standard library.
2. Create `transcripts/` on startup and generate a sanitized, unique filename for each meeting.
3. Store `{ client, transcriptStream, transcriptPath }` by RTMS stream ID.
4. Write each callback immediately as `[timestamp] Speaker: text`.
5. Close the file on `meeting.rtms_stopped`, handle stream errors, and ignore generated transcript text files in Git.
6. Document the transcript output location.

### Task 3: Sanity-check the hackathon build

**Files:**
- Verify: `index.js`, `package.json`, `.gitignore`

**Steps:**

1. Run `npm install` so dependencies match the imported lockfile.
2. Run `node --check index.js`; expect exit code 0.
3. Start the app briefly with the copied local environment and confirm it reaches the webhook listener without an immediate exception.
4. Inspect `git diff` and `git status` to confirm credentials, dependencies, and generated transcripts are not staged.

No automated tests are added, per the hackathon requirement.
