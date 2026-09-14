import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { slackCanvas } from "./canvas.js";

const root = process.cwd();
const statePath = resolve(root, "data/slack-canvas.json");
const initialCanvasId = process.env.SLACK_CANVAS_ID;
const channelId = process.env.SLACK_CHANNEL_ID;

const readState = () =>
  existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};

const canvasId = () => readState().canvas_id || initialCanvasId;

const saveState = async (state) => {
  const { mkdir, rename, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2) + "\n");
  await rename(`${statePath}.tmp`, statePath);
};

const requireCanvasId = () => {
  const id = canvasId();
  if (!id) throw new Error("SLACK_CANVAS_ID must be set");
  return id;
};

export const readProjectCanvas = () => slackCanvas.readMarkdown(requireCanvasId());

/** Appends completed, generated meeting notes to the active project Canvas. */
export const postMeetingNotes = async ({ meeting_id: meetingId, notes }) => {
  const id = requireCanvasId();
  await slackCanvas.append(id, `\n---\n\n## Meeting notes — ${meetingId}\n\n${notes.trim()}\n`);
  return id;
};

/** Recreates the channel Canvas with the provided baseline and persists its new ID. */
export const resetProjectCanvas = async (markdown) => {
  if (!channelId) throw new Error("SLACK_CHANNEL_ID must be set to reset the project Canvas");
  const oldCanvasId = requireCanvasId();
  await slackCanvas.deleteCanvas(oldCanvasId);
  const created = await slackCanvas.createChannelCanvas(channelId, "closed-loop-project", markdown);
  await saveState({ canvas_id: created.canvas_id, channel_id: channelId, reset_at: new Date().toISOString() });
  return created.canvas_id;
};

export { canvasId as slackCanvasId };
