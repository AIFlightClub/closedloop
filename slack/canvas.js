import { WebClient } from "@slack/web-api";

const botToken = process.env.SLACK_BOT_TOKEN;
if (!botToken) throw new Error("SLACK_BOT_TOKEN must be set to use Slack Canvas");

const client = new WebClient(botToken);

// Slack Free requires a Canvas to be attached to a channel. Save canvas_id in
// your database; it is needed for future reads and edits.
const createChannelCanvas = (channelId, title, markdown) =>
  client.canvases.create({
    channel_id: channelId,
    title,
    document_content: { type: "markdown", markdown },
  });

// Slack looks up matching sections rather than returning a whole document.
// Use returned section IDs for replace/insert_before/insert_after edits.
const findSections = (canvasId, criteria) =>
  client.canvases.sections.lookup({ canvas_id: canvasId, criteria });

const append = (canvasId, markdown) =>
  client.canvases.edit({
    canvas_id: canvasId,
    changes: [
      {
        operation: "insert_at_end",
        document_content: { type: "markdown", markdown },
      },
    ],
  });

export const slackCanvas = { createChannelCanvas, findSections, append };
