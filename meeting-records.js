import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";

export const root = process.cwd();
const indexPath = resolve(root, "data/meetings.json");
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n");
  renameSync(`${path}.tmp`, path);
}
export const records = () => existsSync(indexPath) ? readJson(indexPath) : {};
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
  const history = readdirSync(seedDirectory).filter(f => f.endsWith(".md")).sort().map(file => {
    const path = resolve(seedDirectory, file);
    return { path, notes: readFileSync(path, "utf8") };
  });
  const previous = Object.values(records()).filter(r => r.seriesId === config.series_id && r.status === "complete" && r.startedAt < startedAt)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const record of previous) history.push({ path: record.notesPath, notes: readFileSync(record.notesPath, "utf8"), loopState: readJson(record.loopStatePath) });
  const contextPath = resolve(root, "data/contexts", `${basename(transcriptPath, ".txt")}.json`);
  saveJson(contextPath, { config, history });
  return updateRecord(id, { streamId: id, meetingId: meetingId ?? null, seriesId: config.series_id, startedAt,
    transcriptPath, contextPath, predecessor: history.at(-1)?.path ?? null, status: "recording" });
}
