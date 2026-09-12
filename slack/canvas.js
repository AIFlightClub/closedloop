import { WebClient } from "@slack/web-api";

const botToken = () => {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN must be set to use Slack Canvas");
  return token;
};

// Created on first use, so importing this module never needs the token.
let webClient;
const client = () => (webClient ??= new WebClient(botToken()));
const maxMarkdownChars = 900_000;

const splitMarkdown = (markdown) => {
  const chunks = [];
  let remaining = markdown;

  while (remaining.length > maxMarkdownChars) {
    let splitAt = remaining.lastIndexOf("\n", maxMarkdownChars);
    if (splitAt <= 0) splitAt = maxMarkdownChars;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
};

// Slack Free requires a Canvas to be attached to a channel. Save canvas_id in
// your database; it is needed for future reads and edits.
const createChannelCanvas = (channelId, title, markdown) =>
  client().canvases.create({
    channel_id: channelId,
    title,
    document_content: { type: "markdown", markdown },
  });

const deleteCanvas = (canvasId) => client().canvases.delete({ canvas_id: canvasId });

const decodeHtml = (value) =>
  value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

// Slack returns Canvas files as authenticated HTML downloads. Convert enough
// structure to Markdown/plain text for the meeting-notes prompt.
const canvasHtmlToMarkdown = (html) =>
  decodeHtml(
    html
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "# $1\n\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "## $1\n\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "### $1\n\n")
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/blockquote>|<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );

const readMarkdown = async (canvasId) => {
  const { file } = await client().files.info({ file: canvasId });
  if (!file?.url_private_download) throw new Error(`Canvas ${canvasId} has no readable download URL`);

  const response = await fetch(file.url_private_download, {
    headers: { authorization: `Bearer ${botToken()}` },
  });
  if (!response.ok) throw new Error(`Slack Canvas download failed: ${response.status} ${response.statusText}`);
  return canvasHtmlToMarkdown(await response.text());
};

// Slack looks up matching sections rather than returning a whole document.
// Use returned section IDs for replace/insert_before/insert_after edits.
const findSections = (canvasId, criteria) =>
  client().canvases.sections.lookup({ canvas_id: canvasId, criteria });

const append = async (canvasId, markdown) => {
  const responses = [];
  for (const chunk of splitMarkdown(markdown)) {
    responses.push(
      await client().canvases.edit({
        canvas_id: canvasId,
        changes: [
          {
            operation: "insert_at_end",
            document_content: { type: "markdown", markdown: chunk },
          },
        ],
      })
    );
  }
  return responses;
};

export const slackCanvas = { createChannelCanvas, deleteCanvas, findSections, readMarkdown, append };
