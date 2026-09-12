import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { pathToFileURL } from "node:url";

export const root = process.cwd();
const indexPath = resolve(root, "data/meetings.json");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}
export const records = () => existsSync(indexPath) ? readJson(indexPath) : {};
// RTMS stream IDs identify recordings uniquely, including repeated Zoom meetings.
export function notesPaths(id) {
  if (typeof id !== "string" || !id.length) throw new Error("Meeting ID is required");
  const filename = encodeURIComponent(id);
  return { notesPath: resolve(root, "notes", `${filename}.md`), loopStatePath: resolve(root, "notes", `${filename}.loop.json`) };
}
export function getMeetingNotes(id) {
  const record = records()[id];
  if (!record) throw new Error(`Unknown meeting ID: ${id}`);
  if (record.status !== "complete") throw new Error(`Notes for ${id} are not ready (${record.status})`);
  return { meeting_id: id, notesPath: record.notesPath, loopStatePath: record.loopStatePath,
    notes: readFileSync(record.notesPath, "utf8") };
}
export function updateRecord(id, patch) {
  const all = records();
  all[id] = { ...all[id], ...patch };
  saveJson(indexPath, all);
  return all[id];
}

export function startRecord(id, transcriptPath, meetingId) {
  const config = readJson(resolve(root, "meeting-config.json"));
  const startedAt = new Date().toISOString();
  const seedDirectory = resolve(root, config.seed_notes_directory);
  const seedHistory = readdirSync(seedDirectory).filter(f => f.endsWith(".md")).sort().map(file => {
    const path = resolve(seedDirectory, file);
    return { path, notes: readFileSync(path, "utf8") };
  });
  const previous = Object.values(records()).filter(r => r.seriesId === config.series_id && r.status === "complete" && r.startedAt < startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const predecessor = previous.at(-1);
  const history = predecessor
    ? [{ path: predecessor.notesPath, notes: readFileSync(predecessor.notesPath, "utf8"), loopState: readJson(predecessor.loopStatePath) }]
    : seedHistory.slice(-1);
  const contextPath = resolve(root, "data/contexts", `${basename(transcriptPath, ".txt")}.json`);
  saveJson(contextPath, { config, history });
  return updateRecord(id, { meeting_id: id, streamId: id, zoomMeetingId: meetingId ?? null, seriesId: config.series_id, startedAt,
    transcriptPath, contextPath, predecessor: history.at(-1)?.path ?? null, status: "recording" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(getMeetingNotes(process.argv[2]), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
