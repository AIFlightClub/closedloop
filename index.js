// Import the RTMS SDK
import rtms from "@zoom/rtms";
import crypto from "node:crypto";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { records, startRecord, updateRecord } from "./meeting-records.js";
import { generateNotes } from "./generate-notes.js";

const clients = new Map();
const transcriptsDirectory = join(process.cwd(), "transcripts");

mkdirSync(transcriptsDirectory, { recursive: true });

const createTranscriptPath = (streamId) => {
  const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
  const safeStreamId = String(streamId).replace(/[^a-zA-Z0-9_-]/g, "_");

  return join(transcriptsDirectory, `${startedAt}-${safeStreamId}.txt`);
};

// Set up webhook event handler to receive RTMS events from Zoom.
// Taking (payload, req, res) opts into the SDK's raw mode, which lets us answer
// Zoom's endpoint URL validation challenge ourselves.
rtms.onWebhookEvent(({ event, payload }, req, res) => {
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
        updateRecord(streamId, { stoppedAt: new Date().toISOString(), status: "pending" });
        await generateNotes(streamId);
      } catch (error) {
        updateRecord(streamId, { status: "failed", error: error.message });
        console.error(`Meeting ${streamId} failed:`, error.message);
      }
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

  const meeting = { client, transcriptStream, transcriptPath, stopping: false };
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
  });

  // Join the meeting using the webhook payload directly
  client.join(payload);
});
