/**
 * The input contract — the document the processing side hands us (see ../INPUT.md).
 *
 * Two accepted shapes, both normalised to a PollRequest:
 *   1. Loop-state gaps — what the meeting-notes skill emits: one gap per missing
 *      owner / priority / due date / decision, each with `ask`, `options`,
 *      `audience`, `rounds_asked`. Every gap becomes one single-choice poll.
 *   2. Generic polls — `{ meeting_id, channel, polls: [...] }` for anything else
 *      (ranked priorities, yes/no, free text).
 */
import { z } from "zod";
export const POLL_KINDS = ["ranked", "single", "multiple", "yes_no", "open"];
export const DELIVERY_MODES = ["auto", "channel", "dm"];
const NEEDS_OPTIONS = new Set(["ranked", "single", "multiple"]);
const ID = /^[A-Za-z0-9._-]{1,64}$/;
/** People keys (as used in `audience`) → how to reach them in Slack. */
export const RosterSchema = z.record(z.string(), z.object({
    email: z.string().email().optional(),
    slack_id: z.string().regex(/^[UW][A-Z0-9]{8,}$/).optional(),
    name: z.string().optional(),
}));
export const PollSchema = z
    .object({
    /** Stable per poll; becomes the Polly draftId, so re-sends never duplicate. */
    id: z.string().regex(ID, "id: letters, digits, . _ and - only (max 64)"),
    kind: z.enum(POLL_KINDS).default("ranked"),
    question: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(300)).default([]),
    /** Why we're asking — shown above the question. */
    context: z.string().trim().max(1000).optional(),
    close_after_minutes: z.number().int().min(1).max(24 * 60).default(15),
    /** Auto-close needs at least this many voters … */
    min_votes: z.number().int().min(1).default(1),
    /** … and no new vote for this long. 0 = close as soon as min_votes is reached. */
    settle_seconds: z.number().int().min(0).default(30),
    auto_close: z.boolean().default(true),
    anonymous: z.boolean().default(false),
    /** People keys (see roster) who should answer. Empty = the channel. */
    audience: z.array(z.string()).default([]),
    /** auto: channel when the audience is everyone (or empty), DM when it's specific people. */
    delivery: z.enum(DELIVERY_MODES).default("auto"),
    /** Options that mean "still unknown" (e.g. "Someone else / not decided"); heuristics apply otherwise. */
    escape_options: z.array(z.string()).optional(),
    /** Anything the caller wants echoed back in the results (action ids, etc.). */
    meta: z.record(z.string(), z.unknown()).default({}),
})
    .superRefine((poll, ctx) => {
    if (NEEDS_OPTIONS.has(poll.kind) && poll.options.length < 2) {
        ctx.addIssue({ code: "custom", path: ["options"], message: `${poll.kind} polls need at least 2 options` });
    }
    if (poll.kind === "ranked" && poll.options.length > 20) {
        ctx.addIssue({ code: "custom", path: ["options"], message: "ranked polls take at most 20 options" });
    }
    if (new Set(poll.options.map((o) => o.toLowerCase())).size !== poll.options.length) {
        ctx.addIssue({ code: "custom", path: ["options"], message: "options must be unique" });
    }
});
const RequestBase = {
    meeting_id: z.string().regex(ID, "meeting_id: letters, digits, . _ and - only"),
    meeting_date: z.string().optional(),
    /** Slack channel to post the poll (and results) in. Falls back to POLLY_CHANNEL. */
    channel: z.string().trim().min(1).optional(),
    requested_by: z.string().optional(),
    required_attendees: z.array(z.string()).default([]),
    roster: RosterSchema.default({}),
    delivery: z.enum(DELIVERY_MODES).default("auto"),
};
export const PollRequestSchema = z
    .object({
    ...RequestBase,
    polls: z.array(PollSchema).min(1),
})
    .superRefine((file, ctx) => {
    const ids = file.polls.map((p) => p.id);
    if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", path: ["polls"], message: "poll ids must be unique within a file" });
    }
});
/** One gap from the meeting-notes skill's loop state. */
export const GapSchema = z.object({
    gap_id: z.string().regex(ID, "gap_id: letters, digits, . _ and - only"),
    item: z.string().optional(),
    /** owner | priority | due_date | status_update | decision | absent_signoff | … */
    field: z.string().optional(),
    ask: z.string().trim().min(1).max(500),
    options: z.array(z.string().trim().min(1).max(300)).min(2).max(20),
    audience: z.array(z.string()).default([]),
    rounds_asked: z.number().int().min(0).default(0),
    escape_options: z.array(z.string()).optional(),
});
export const GapsRequestSchema = z.object({
    ...RequestBase,
    close_after_minutes: z.number().int().min(1).max(24 * 60).default(15),
    min_votes: z.number().int().min(1).default(1),
    settle_seconds: z.number().int().min(0).default(30),
    auto_close: z.boolean().default(true),
    anonymous: z.boolean().default(false),
    gaps: z.array(GapSchema).min(1),
});
const FIELD_LABELS = {
    owner: "owner",
    priority: "priority",
    due_date: "due date",
    status_update: "status",
    decision: "decision",
    absent_signoff: "sign-off",
};
/** channel when everyone (or nobody specific) should answer; DM when it's named people. */
export function resolveDelivery(mode, audience, required) {
    if (mode !== "auto")
        return mode;
    if (audience.length === 0)
        return "channel";
    const wanted = new Set(audience.map((a) => a.toLowerCase()));
    const everyone = required.length > 0 && required.every((r) => wanted.has(r.toLowerCase()));
    return everyone ? "channel" : "dm";
}
function gapsToPolls(doc) {
    return doc.gaps.map((gap) => PollSchema.parse({
        id: gap.gap_id,
        kind: "single",
        question: gap.ask,
        options: gap.options,
        context: gap.item ? `${gap.item}${gap.field ? ` — ${FIELD_LABELS[gap.field] ?? gap.field}` : ""}` : undefined,
        close_after_minutes: doc.close_after_minutes,
        min_votes: doc.min_votes,
        settle_seconds: doc.settle_seconds,
        auto_close: doc.auto_close,
        anonymous: doc.anonymous,
        audience: gap.audience,
        delivery: doc.delivery,
        escape_options: gap.escape_options,
        meta: {
            gap_id: gap.gap_id,
            item: gap.item,
            field: gap.field,
            audience: gap.audience,
            rounds_asked: gap.rounds_asked,
        },
    }));
}
const FILE_KEYS = new Set(["meeting_id", "meeting_date", "channel", "requested_by", "required_attendees", "roster", "delivery", "polls", "gaps"]);
/**
 * Parse a request document: loop-state gaps, generic polls, or the single-poll
 * shorthand `{ meeting_id, channel?, id, question, options, … }`.
 */
export function parsePollRequest(raw, defaults = {}) {
    let shaped = raw;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const obj = raw;
        if (Array.isArray(obj.gaps) && !Array.isArray(obj.polls)) {
            const doc = GapsRequestSchema.parse(obj);
            const { gaps: _gaps, close_after_minutes: _c, min_votes: _m, settle_seconds: _s, auto_close: _a, anonymous: _an, ...rest } = doc;
            shaped = { ...rest, polls: gapsToPolls(doc) };
        }
        else if (!Array.isArray(obj.polls) && typeof obj.question === "string") {
            const poll = Object.fromEntries(Object.entries(obj).filter(([key]) => !FILE_KEYS.has(key)));
            shaped = { ...Object.fromEntries(Object.entries(obj).filter(([key]) => FILE_KEYS.has(key))), polls: [poll] };
        }
    }
    const parsed = PollRequestSchema.parse(shaped);
    const channel = parsed.channel ?? defaults.channel;
    if (!channel)
        throw new Error("channel missing — set it in the file or via POLLY_CHANNEL");
    return { ...parsed, channel };
}
/** Turn audience keys into Polly-addressable people via the roster. */
export function resolveAudience(audience, roster) {
    const out = { emails: [], ids: [], names: [] };
    for (const key of audience) {
        const entry = roster[key] ?? roster[key.toLowerCase()];
        if (entry?.email)
            out.emails.push(entry.email);
        else if (entry?.slack_id)
            out.ids.push(entry.slack_id);
        else
            out.names.push(entry?.name ?? key);
    }
    return out;
}
export function toPollyQuestion(poll) {
    switch (poll.kind) {
        case "ranked":
            return { type: "ranked", options: poll.options, rankCount: poll.options.length };
        case "single":
            return { type: "multipleChoice", options: poll.options };
        case "multiple":
            return { type: "multipleChoice", options: poll.options, allowMultipleAnswers: true };
        case "yes_no":
            return { type: "yesNo" };
        case "open":
            return { type: "openEnded" };
    }
}
/** Polly draft ids allow letters, digits, hyphen, underscore only. */
export function draftIdFor(meetingId, pollId) {
    return `closedloop_${meetingId}_${pollId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
}
