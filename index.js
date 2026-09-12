// Import the RTMS SDK
import rtms from "@zoom/rtms";
import crypto from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import express from "express";
import { createPolly } from "./polly/index.js";
import { createLoop } from "./loop/index.js";
import { records, startRecord, updateRecord } from "./meeting-records.js";
import { generateNotes } from "./generate-notes.js";

const clients = new Map();
const transcriptsDirectory = join(process.cwd(), "transcripts");

mkdirSync(transcriptsDirectory, { recursive: true });

// The Polly module and the loop that runs on top of it. POLLY_ENABLED=false turns
// both off; LOOP_ENABLED=false keeps the Polly API but no automatic survey,
// enrichment or live polls.
const port = Number(process.env.ZM_RTMS_PORT || 8080);
const polly = process.env.POLLY_ENABLED !== "false" ? createPolly() : null;
const loop = polly && process.env.LOOP_ENABLED !== "false" ? createLoop({ polly, port }) : null;

const createTranscriptPath = (streamId) => {
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const safeStreamId = String(streamId).replace(/[^a-zA-Z0-9_-]/g, "_");

  return join(transcriptsDirectory, `${startedAt}-${safeStreamId}.txt`);
};

// Webhook event handler for RTMS events from Zoom.
// Taking (payload, req, res) opts into the SDK's raw mode, which lets us answer
// Zoom's endpoint URL validation challenge ourselves.
const handleZoomWebhook = ({ event, payload }, req, res) => {
  const respond = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Zoom calls this when you press "Validate" on the event notification endpoint.
  // The HMAC uses the app's Secret Token, not the OAuth client secret.
  if (event === "endpoint.url_validation") {
    const secretToken = process.env.ZM_RTMS_SECRET_TOKEN;

    if (!secretToken) {
      console.error("Cannot validate endpoint: ZM_RTMS_SECRET_TOKEN is not set");
      return respond(500, { error: "Secret token not configured" });
    }

    const plainToken = payload.plainToken;
    const encryptedToken = crypto
      .createHmac("sha256", secretToken)
      .update(plainToken)
      .digest("hex");

    console.log("Answered endpoint URL validation challenge");
    return respond(200, { plainToken, encryptedToken });
  }

  console.log(`Received event: ${event}`);
  respond(200, { status: "ok" });

  const streamId = payload?.rtms_stream_id;

  if (event == "meeting.rtms_stopped") {
    if (!streamId) {
      console.log("Received meeting.rtms_stopped event without stream ID");
      return;
    }

    const meeting = clients.get(streamId);
    if (!meeting) {
      console.log(`Received meeting.rtms_stopped event for unknown stream ID: ${streamId}`);
      return;
    }

    meeting.stopping = true;
    clients.delete(streamId);
    void (async () => {
      try {
        meeting.client.leave();
        const flushed = finished(meeting.transcriptStream);
        meeting.transcriptStream.end();
        await flushed;
        loop?.live.stop(streamId);
        updateRecord(streamId, { stoppedAt: new Date().toISOString(), status: "pending" });
        await generateNotes(streamId);
      } catch (error) {
        updateRecord(streamId, { status: "failed", error: error.message });
        console.error(`Meeting ${streamId} failed:`, error.message);
        return;
      }
      // Notes are in: survey → results → enriched notes, with a callback after each stage.
      if (loop) await loop.afterNotes(streamId).catch((error) => console.error(`Loop for ${streamId} failed:`, error.message));
    })();

    return;
  } else if (event !== "meeting.rtms_started") {
    console.log(`Ignoring unknown event`);
    return;
  }

  if (!streamId) {
    console.error("Received meeting.rtms_started event without stream ID");
    return;
  }

  // Create a new RTMS client for the stream if it doesn't exist
  if (clients.has(streamId) || records()[streamId]) return;
  const client = new rtms.Client();
  const transcriptPath = createTranscriptPath(streamId);
  try {
    startRecord(streamId, transcriptPath, payload?.meeting_uuid);
  } catch (error) {
    console.error("Cannot prepare meeting context:", error.message);
    return;
  }
  const transcriptStream = createWriteStream(transcriptPath, { flags: "a" });

  transcriptStream.on("error", (error) => {
    console.error(`Failed to write transcript ${transcriptPath}:`, error);
  });

  // The live detector watches the transcript for a poll-worthy moment (an explicit
  // "let's poll this", an A-or-B with no call, an action with no owner).
  const meeting = { client, transcriptStream, transcriptPath, stopping: false, live: loop?.live.start(streamId) ?? null };
  clients.set(streamId, meeting);
  transcriptStream.write(`# Zoom RTMS transcript\n# Stream: ${streamId}\n# Started: ${new Date().toISOString()}\n\n`);
  console.log(`Writing live transcript to ${transcriptPath}`);

  client.onTranscriptData((data, size, timestamp, metadata) => {
    if (meeting.stopping || transcriptStream.destroyed) return;
    const speaker = metadata?.userName || "Unknown speaker";
    const text = data.toString();
    const line = `[${timestamp}] ${speaker}: ${text}\n`;

    console.log(line.trimEnd());
    transcriptStream.write(line);
    meeting.live?.push({ speaker, text, ts: timestamp });
  });

  // Join the meeting using the webhook payload directly
  client.join(payload);
};

// One server for everything: the Zoom webhook (same port/path the SDK used, so
// the ngrok URL in the Marketplace app keeps working), the Polly module's API +
// inbox, and the loop's API. The webhook route is registered first and reads
// the raw body itself, so no body parser touches it.
const app = express();
const zoomPath = process.env.ZM_RTMS_PATH || "/";
app.post(zoomPath, rtms.createWebhookHandler(handleZoomWebhook, zoomPath));

if (polly) {
  app.use("/polls", polly.router);
  polly.startInbox();
}
if (loop) app.use("/loop", loop.router);

app.listen(port, () => {
  console.log(`Listening on http://localhost:${port} — Zoom webhook: POST ${zoomPath}${polly ? " · Polly: /polls" : ""}${loop ? ` · Loop: /loop (callback: ${loop.notifier.url ?? "none"})` : ""}`);
});
