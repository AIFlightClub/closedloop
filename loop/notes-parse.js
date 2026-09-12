/**
 * Small parsers for the canvas markdown the notes skill writes: decisions and
 * action items with their stable IDs. Used to build the survey without a
 * second model call.
 */
const ID = /\[([A-Za-z]+(?:-[A-Za-z]+)*-\d+)\]/;

/** Body of the first `## heading` matching `pattern`, up to the next section or rule. */
export function section(markdown, pattern) {
  const lines = String(markdown ?? "").split("\n");
  const start = lines.findIndex((line) => /^##\s+/.test(line) && pattern.test(line.replace(/^##\s+/, "").trim()));
  if (start < 0) return "";
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line) || /^---\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join("\n");
}

/** Numbered or bulleted items, with wrapped continuation lines joined. */
export function listItems(body) {
  const items = [];
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) continue;
    const start = /^\s*(?:\d+[.)]|[-*•])\s+(.*)$/.exec(line);
    if (start) items.push(start[1]);
    else if (items.length) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function parseIdLine(item) {
  const match = ID.exec(item);
  if (!match) return null;
  const text = item.replace(match[0], "").replace(/\*\*/g, "").replace(/^\s*[-–—:]\s*/, "").trim();
  return { id: match[1], text };
}

/** `## Decisions` → [{ id, text }] with the "proposed by / affirmed by" tail removed. */
export function parseDecisions(markdown) {
  return listItems(section(markdown, /^decisions/i))
    .map(parseIdLine)
    .filter(Boolean)
    .map(({ id, text }) => ({ id, text: text.replace(/\s+[—–-]+\s+proposed by.*$/i, "").replace(/\s+\(proposed by.*$/i, "").trim() }));
}

/** `## Action items` + `## Carried over` → [{ id, text }] (text before the metadata tail). */
export function parseActionItems(markdown) {
  const out = new Map();
  for (const pattern of [/^action items/i, /^carried over/i]) {
    for (const item of listItems(section(markdown, pattern))) {
      const parsed = parseIdLine(item);
      if (!parsed) continue;
      const text = parsed.text.split(/\s+[—–]\s+/)[0].split(/\s+·\s+/)[0].trim();
      if (!out.has(parsed.id)) out.set(parsed.id, text);
    }
  }
  return [...out].map(([id, text]) => ({ id, text }));
}

/** Truncate to `max` characters with an ellipsis. */
export function clip(text, max) {
  const value = String(text ?? "").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
}
