/**
 * Poll records, ranking, and the results files (JSON + Markdown).
 * One record per poll in <results dir>/<meeting_id>/<poll id>.json; a
 * summary.json + summary.md per meeting once polls close.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();
/**
 * Order the poll's options by the votes Polly reports. Matches by normalised
 * text, falls back to position when the counts line up, and keeps option
 * order on ties so the result is deterministic.
 */
export function rankChoices(options, choices) {
    const byText = new Map(choices.map((c) => [normalize(c.text), c]));
    const positional = choices.length === options.length;
    const scored = options.map((option, index) => {
        const hit = byText.get(normalize(option)) ?? (positional ? choices[index] : undefined);
        return { option, index, score: hit?.votes ?? 0, percentage: hit?.percentage ?? 0 };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.map((entry, i) => ({
        rank: i + 1,
        option: entry.option,
        score: entry.score,
        percentage: entry.percentage,
    }));
}
const ESCAPE_PATTERN = /\b(not decided|someone else|no date needed|not sure|don'?t know|unknown|skip|decide (later|next time|on )?\w*(day|morning)?)\b/i;
export function isEscapeOption(option, record) {
    if (record.escape_options?.some((e) => e.toLowerCase() === option.toLowerCase()))
        return true;
    return ESCAPE_PATTERN.test(option);
}
/** Skill rules: winner fills; tie stays missing; escape hatch wins → retire; nothing → still open. */
export function resolveGap(record) {
    const meta = record.meta;
    const base = {
        gap_id: typeof meta.gap_id === "string" ? meta.gap_id : record.id,
        item: typeof meta.item === "string" ? meta.item : undefined,
        field: typeof meta.field === "string" ? meta.field : undefined,
        votes: record.votes,
        counts: Object.fromEntries(record.ranking.map((r) => [r.option, r.score])),
        poll_id: record.polly?.id,
        status: record.status,
    };
    const [top, second] = record.ranking;
    if (!record.votes || !top || top.score === 0) {
        return { ...base, winning_option: null, resolution: "no_responses" };
    }
    if (second && second.score === top.score) {
        return {
            ...base,
            winning_option: null,
            resolution: "tie",
            detail: record.ranking
                .filter((r) => r.score === top.score)
                .map((r) => `${r.option} ${r.score}`)
                .join(", "),
        };
    }
    if (isEscapeOption(top.option, record)) {
        return { ...base, winning_option: top.option, resolution: "escape_hatch" };
    }
    return { ...base, winning_option: top.option, resolution: "filled" };
}
/** Ratification from a fallback (single) poll: choices align with meta.decisions. */
function ratificationFromPoll(record) {
    const decisions = record.meta?.decisions ?? [];
    const respondents = record.votes;
    const counts = Object.fromEntries(record.ranking.map((r) => [r.option, r.score]));
    const rows = decisions.map((decision, i) => {
        const votes = counts[record.options[i]] ?? 0;
        return { decision, choice: record.options[i], votes, status: votes > respondents / 2 && votes > 0 ? "confirmed" : votes > 0 ? "partial" : "unchecked" };
    });
    const none = record.options.find((o) => /^none of these/i.test(o));
    return {
        index: record.meta?.index,
        respondents,
        decisions: rows,
        confirmed: rows.filter((d) => d.status === "confirmed").map((d) => d.decision),
        partial: rows.filter((d) => d.status === "partial").map((d) => d.decision),
        none_of_these: none ? (counts[none] ?? 0) : 0,
    };
}
/** Priority order from a fallback ranked poll: choices align with meta.items. */
function rankingFromPoll(record) {
    const items = record.meta?.items ?? [];
    const scale = record.meta?.scale ?? ["P0", "P1", "P2"];
    const n = record.ranking.length;
    const bucket = Math.max(1, Math.ceil(n / scale.length));
    return {
        index: record.meta?.index,
        respondents: record.votes,
        order: record.ranking.map((r, i) => ({
            rank: r.rank,
            choice: r.option,
            item: items[record.options.indexOf(r.option)] ?? null,
            score: r.score,
            priority: scale[Math.min(Math.floor(i / bucket), scale.length - 1)],
        })),
        scale,
        note: "rank buckets mapped onto the scale (top third first); a rank is not literally a priority label",
    };
}
export function buildPollRound(meetingId, records) {
    const sentAt = records.map((r) => r.polly?.sent_at).filter((v) => !!v).sort();
    const closedAt = records.map((r) => r.closed_at).filter((v) => !!v).sort();
    const role = (r) => r.meta?.role;
    const polls = records.filter((r) => r.kind !== "survey" && role(r) !== "ratification" && role(r) !== "ranking");
    const surveys = records.filter((r) => r.kind === "survey" && r.status !== "failed");
    const readback = surveys.map((s) => s.readback ?? {});
    const ratPoll = records.find((r) => role(r) === "ratification" && r.status === "closed");
    const rankPoll = records.find((r) => role(r) === "ranking" && r.status === "closed");
    return {
        meeting_id: meetingId,
        fired_at: sentAt[0] ?? null,
        closed_at: closedAt.at(-1) ?? null,
        respondents: Math.max(0, ...records.map((r) => r.votes)),
        complete: records.length > 0 && records.every((r) => r.status === "closed" || r.status === "failed"),
        // Gap answers — from single polls and from survey gap questions alike.
        results: [...polls.map(resolveGap), ...readback.flatMap((rb) => rb.gaps ?? [])],
        // meeting-loop-polly roles: from the survey, or from the fallback polls.
        ratification: readback.find((rb) => rb.ratification)?.ratification ?? (ratPoll ? ratificationFromPoll(ratPoll) : null),
        ranking: readback.find((rb) => rb.ranking)?.ranking ?? (rankPoll ? rankingFromPoll(rankPoll) : null),
        meeting_rating: readback.find((rb) => rb.meeting_rating)?.meeting_rating ?? null,
        human_only: readback.flatMap((rb) => rb.human_only ?? []),
        surveys: records.filter((r) => r.kind === "survey").map((s) => ({ id: s.id, polly_id: s.polly?.id ?? null, status: s.status, votes: s.votes, results_url: s.polly?.results_url ?? null, error: s.error ?? null })),
        fallback: !!(ratPoll || rankPoll || polls.some((r) => role(r) === "gap")) && records.some((r) => r.kind === "survey" && r.status === "failed"),
    };
}
export function summarizeRecord(record) {
    const top = record.ranking
        .slice(0, 3)
        .map((r) => `${r.rank}. ${r.option} (${r.score})`)
        .join(", ");
    return `${record.id} [${record.status}${record.closed_by ? `/${record.closed_by}` : ""}] ${record.votes} votes${top ? ` — ${top}` : ""}`;
}
function renderSurveyMarkdown(record) {
    const rb = record.readback ?? {};
    const lines = [`### ${record.question}`];
    lines.push(`_${record.meeting_id} · survey · ${record.status}${record.closed_by ? ` (${record.closed_by})` : ""} · ${record.votes} respondent${record.votes === 1 ? "" : "s"}${record.polly?.results_url ? ` · [results](${record.polly.results_url})` : ""}_`);
    if (rb.ratification) {
        const r = rb.ratification;
        lines.push("", "**Decisions**");
        for (const d of r.decisions) {
            const mark = d.status === "confirmed" ? "✅" : d.status === "partial" ? "🟡" : "⬜";
            lines.push(`- ${mark} ${d.decision} — ${d.votes}/${r.respondents}`);
        }
        if (r.none_of_these)
            lines.push(`- ⚠️ "None of these" picked by ${r.none_of_these}`);
    }
    for (const gap of rb.gaps ?? []) {
        lines.push("", `**${gap.question ?? gap.gap_id}**`);
        lines.push(`Resolution: ${gap.resolution}${gap.winning_option ? ` → ${gap.winning_option}` : ""}${gap.detail ? ` (${gap.detail})` : ""}`);
        for (const [option, votes] of Object.entries(gap.counts))
            lines.push(`- ${option} — ${votes}`);
    }
    if (rb.ranking) {
        lines.push("", "**Priority ranking**");
        for (const entry of rb.ranking.order)
            lines.push(`${entry.rank}. **${entry.item ?? entry.choice}** → ${entry.priority} (${entry.score})`);
    }
    if (rb.meeting_rating)
        lines.push("", `**Meeting rating:** ${rb.meeting_rating.average ?? "—"} (${rb.meeting_rating.responses} responses)`);
    for (const h of rb.human_only ?? [])
        lines.push("", `_${h.role}: ${h.responses} response${h.responses === 1 ? "" : "s"} — read on the results card_`);
    if (record.error)
        lines.push(`\n**Error:** ${record.error}`);
    return lines.join("\n");
}
export function renderRecordMarkdown(record) {
    if (record.kind === "survey")
        return renderSurveyMarkdown(record);
    const lines = [`### ${record.question}`];
    lines.push(`_${record.meeting_id} · ${record.kind} · ${record.status}${record.closed_by ? ` (${record.closed_by})` : ""} · ${record.votes} vote${record.votes === 1 ? "" : "s"}${record.polly?.results_url ? ` · [results](${record.polly.results_url})` : ""}_`);
    if (record.context)
        lines.push(`> ${record.context}`);
    if (record.status === "closed") {
        const gap = resolveGap(record);
        lines.push(`**Resolution:** ${gap.resolution}${gap.winning_option ? ` → ${gap.winning_option}` : ""}${gap.detail ? ` (${gap.detail})` : ""}`);
    }
    if (record.ranking.length) {
        lines.push("");
        for (const entry of record.ranking) {
            lines.push(`${entry.rank}. **${entry.option}** — ${entry.score}${entry.percentage ? ` (${Math.round(entry.percentage)}%)` : ""}`);
        }
    }
    else if (record.choices.length) {
        lines.push("");
        for (const choice of record.choices)
            lines.push(`- ${choice.text} — ${choice.votes}`);
    }
    if (record.error)
        lines.push(`\n**Error:** ${record.error}`);
    return lines.join("\n");
}
export function renderSummaryMarkdown(meetingId, records) {
    const stamp = new Date().toISOString();
    const closed = records.filter((r) => r.status === "closed").length;
    const lines = [
        `# ClosedLoop poll results — ${meetingId}`,
        `_${closed} of ${records.length} closed · generated ${stamp}_`,
        "",
    ];
    for (const record of records) {
        lines.push(renderRecordMarkdown(record), "");
    }
    return lines.join("\n");
}
export class ResultsStore {
    dir;
    constructor(dir) {
        this.dir = dir;
    }
    meetingDir(meetingId) {
        return join(this.dir, meetingId);
    }
    path(meetingId, pollId) {
        return join(this.meetingDir(meetingId), `${pollId}.json`);
    }
    read(meetingId, pollId) {
        const path = this.path(meetingId, pollId);
        if (!existsSync(path))
            return undefined;
        return JSON.parse(readFileSync(path, "utf8"));
    }
    write(record) {
        record.updated_at = new Date().toISOString();
        const path = this.path(record.meeting_id, record.id);
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(record, null, 2));
        renameSync(tmp, path);
        return record;
    }
    list(meetingId) {
        const dir = this.meetingDir(meetingId);
        if (!existsSync(dir))
            return [];
        return readdirSync(dir)
            .filter((name) => name.endsWith(".json") && !name.startsWith("summary") && name !== "poll_round.json")
            .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")))
            .sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    writeSummary(meetingId) {
        const records = this.list(meetingId);
        const dir = this.meetingDir(meetingId);
        mkdirSync(dir, { recursive: true });
        const json = join(dir, "summary.json");
        const md = join(dir, "summary.md");
        const round = join(dir, "poll_round.json");
        writeFileSync(json, JSON.stringify({ meeting_id: meetingId, generated_at: new Date().toISOString(), polls: records }, null, 2));
        writeFileSync(md, renderSummaryMarkdown(meetingId, records));
        writeFileSync(round, JSON.stringify(buildPollRound(meetingId, records), null, 2));
        return { json, md, round, records };
    }
}
