/**
 * Survey path — the meeting-loop-polly skill's design: ONE Polly survey per
 * meeting (decision ratification, one question per gap, a ranked question
 * over the open action items, feedback), plus a `question_map` so the answers
 * merge back by position.
 *
 * The processing side hands us exactly the create_survey JSON the skill builds
 * (plus the map); this module sends it, watches it, and reads the answers back
 * per role: gaps → filled/tie/escape_hatch/no_responses, ratification →
 * confirmed/partial, ranking → priority order, rating → average, free text →
 * "read it on the results card".
 */
import { z } from "zod";
import { isEscapeOption, summarizeRecord } from "./results.js";
import { draftIdFor } from "./request.js";

const ID = /^[A-Za-z0-9._-]{1,64}$/;

const QuestionSchema = z
  .object({
    type: z.enum([
      "multipleChoice", "openEnded", "nps", "1To5", "1To10", "agreeDisagree",
      "yesNo", "wordCloud", "ranked", "pointAllocation", "emojiRank",
    ]),
    title: z.string().trim().min(1).max(500),
    choices: z.array(z.string().trim().min(1).max(300)).optional(),
    allowMultipleAnswers: z.boolean().optional(),
    rankCount: z.number().int().min(2).max(20).optional(),
    points: z.number().int().min(2).max(100).optional(),
    required: z.boolean().optional(),
  })
  .loose();

/** The create_survey arguments, as the skill builds them. Extra keys pass through. */
export const SurveyArgsSchema = z
  .object({
    draftId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/).optional(),
    title: z.string().trim().min(1).max(200),
    appeal: z.string().trim().max(1000).optional(),
    questions: z.array(QuestionSchema).min(2),
    userEmails: z.array(z.string()).optional(),
    userIds: z.array(z.string()).optional(),
    userNames: z.array(z.string()).optional(),
    channelNames: z.array(z.string()).optional(),
    sendAt: z.string().optional(),
    closeAt: z.string().optional(),
    anonymityLevel: z.string().optional(),
    resultsVisibility: z.string().optional(),
    commentsVisibility: z.string().optional(),
    reminderCount: z.number().int().min(0).max(10).optional(),
    daysBetweenReminders: z.number().int().min(1).max(30).optional(),
  })
  .loose();

export const QuestionMapEntrySchema = z
  .object({
    index: z.number().int().min(0),
    role: z.enum(["ratification", "missed_items", "gap", "ranking", "meeting_rating", "next_agenda", "other"]),
    decisions: z.array(z.string()).optional(),
    gap_id: z.string().optional(),
    item: z.string().optional(),
    field: z.string().optional(),
    items: z.array(z.string()).optional(),
    readback: z.string().optional(),
    escape_options: z.array(z.string()).optional(),
  })
  .loose();

export const SurveyRequestSchema = z.object({
  meeting_id: z.string().regex(ID, "meeting_id: letters, digits, . _ and - only"),
  meeting_date: z.string().optional(),
  channel: z.string().trim().min(1).optional(),
  requested_by: z.string().optional(),
  survey: SurveyArgsSchema,
  question_map: z.array(QuestionMapEntrySchema).default([]),
  /** Auto-close needs at least this many respondents … */
  min_votes: z.number().int().min(1).default(1),
  /** … and no new response for this long (seconds). */
  settle_seconds: z.number().int().min(0).default(60),
  auto_close: z.boolean().default(true),
  /** How long to keep watching before giving up; default derived from closeAt (+ grace). */
  timeout_minutes: z.number().int().min(1).optional(),
  /** Rank positions → priority labels, top third first. */
  priority_scale: z.array(z.string().min(1)).min(1).default(["P0", "P1", "P2"]),
  /** If the Polly plan refuses multi-question pollys, send one poll per readable question instead. */
  fallback_to_polls: z.boolean().default(true),
});

export function isPlanLimitError(message) {
  return /plan limit/i.test(String(message ?? ""));
}

/**
 * Degrade a survey to single-question pollys (what the Free plan allows):
 * gap questions, the ratification question and the ranking question keep
 * their roles in `meta` so poll_round.json reads back the same way; rating
 * and open-ended questions are dropped (never read back anyway).
 */
export function surveyToPolls(request) {
  const emails = request.survey.userEmails ?? [];
  const ids = request.survey.userIds ?? [];
  const names = request.survey.userNames ?? [];
  const people = [...emails, ...ids, ...names];
  const roster = Object.fromEntries([
    ...emails.map((e) => [e, { email: e }]),
    ...ids.map((i) => [i, { slack_id: i }]),
    ...names.map((n) => [n, { name: n }]),
  ]);
  const channel = request.survey.channelNames?.[0] ? `#${String(request.survey.channelNames[0]).replace(/^#/, "")}` : request.channel;
  const map = request.question_map.length
    ? request.question_map
    : request.survey.questions.map((q, index) => ({ index, role: "other" }));
  const base = {
    close_after_minutes: minutesUntilClose(request.survey.closeAt),
    min_votes: request.min_votes,
    settle_seconds: request.settle_seconds,
    auto_close: request.auto_close,
    audience: people,
    delivery: people.length ? "dm" : "channel",
  };
  const polls = [];
  for (const entry of map) {
    const q = request.survey.questions[entry.index];
    if (!q || !q.choices?.length) continue;
    if (entry.role === "gap" && q.type === "multipleChoice") {
      polls.push({
        ...base,
        id: entry.gap_id ?? `q${entry.index}`,
        kind: q.allowMultipleAnswers ? "multiple" : "single",
        question: q.title,
        options: q.choices,
        escape_options: entry.escape_options,
        meta: { role: "gap", index: entry.index, gap_id: entry.gap_id ?? `q${entry.index}`, item: entry.item, field: entry.field },
      });
    } else if (entry.role === "ratification" && q.type === "multipleChoice") {
      polls.push({
        ...base,
        id: "ratification",
        kind: "multiple",
        question: q.title,
        options: q.choices,
        meta: { role: "ratification", index: entry.index, decisions: entry.decisions ?? [] },
      });
    } else if (entry.role === "ranking" && q.type === "ranked") {
      polls.push({
        ...base,
        id: "ranking",
        kind: "ranked",
        question: q.title,
        options: q.choices,
        meta: { role: "ranking", index: entry.index, items: entry.items ?? [], scale: request.priority_scale },
      });
    }
  }
  if (!polls.length) throw new Error("survey has no choice-based question to fall back to");
  return { meeting_id: request.meeting_id, channel, required_attendees: [], roster, delivery: base.delivery, polls };
}

export function isSurveyRequest(raw) {
  return !!raw && typeof raw === "object" && !Array.isArray(raw) && !!raw.survey && typeof raw.survey === "object";
}

export function parseSurveyRequest(raw, defaults = {}) {
  const parsed = SurveyRequestSchema.parse(raw);
  const channel = parsed.channel ?? defaults.channel;
  const hasAudience = ["userEmails", "userIds", "userNames", "channelNames"].some((k) => parsed.survey[k]?.length);
  if (!hasAudience && !channel) throw new Error("audience missing — set userEmails/userNames on the survey, or channel / POLLY_CHANNEL");
  for (const entry of parsed.question_map) {
    if (entry.index >= parsed.survey.questions.length) {
      throw new Error(`question_map index ${entry.index} is out of range (${parsed.survey.questions.length} questions)`);
    }
  }
  return { ...parsed, channel };
}

/** Minutes until Polly closes the survey: "+18h" | ISO | default 24h. */
export function minutesUntilClose(closeAt, now = Date.now()) {
  if (!closeAt) return 24 * 60;
  const relative = /^\+(\d+)([mhd])$/i.exec(closeAt.trim());
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    return unit === "m" ? n : unit === "h" ? n * 60 : n * 24 * 60;
  }
  const at = Date.parse(closeAt);
  if (Number.isFinite(at)) return Math.max(1, Math.round((at - now) / 60_000));
  return 24 * 60;
}

const normalize = (text) => text.toLowerCase().replace(/\s+/g, " ").trim();

function orderChoices(question) {
  return [...question.choices]
    .map((c, index) => ({ ...c, index }))
    .sort((a, b) => b.votes - a.votes || a.index - b.index);
}

/** Read one survey's answers back per question_map role. */
export function readbackSurvey(request, results) {
  const questions = results.questions ?? [];
  const respondents = results.responseCount || Math.max(0, ...questions.map((q) => q.responseCount));
  const map = request.question_map.length
    ? request.question_map
    : questions.map((q, index) => ({ index, role: "other" }));
  const out = { respondents, gaps: [], human_only: [] };

  for (const entry of map) {
    const spec = request.survey.questions[entry.index];
    const q = questions[entry.index];
    if (!spec) continue;
    const answered = q?.responseCount ?? 0;

    switch (entry.role) {
      case "ratification": {
        const choices = q?.choices ?? [];
        const majority = respondents / 2;
        const decisions = (entry.decisions ?? []).map((decision, i) => {
          const choice = choices[i] ?? spec.choices?.[i] ? { votes: choices[i]?.votes ?? 0 } : { votes: 0 };
          const votes = choice.votes;
          return {
            decision,
            choice: spec.choices?.[i] ?? decision,
            votes,
            status: votes > majority && votes > 0 ? "confirmed" : votes > 0 ? "partial" : "unchecked",
          };
        });
        const noneIdx = (spec.choices ?? []).findIndex((c) => /^none of these/i.test(c));
        out.ratification = {
          index: entry.index,
          respondents,
          decisions,
          confirmed: decisions.filter((d) => d.status === "confirmed").map((d) => d.decision),
          partial: decisions.filter((d) => d.status === "partial").map((d) => d.decision),
          none_of_these: noneIdx >= 0 ? (choices[noneIdx]?.votes ?? 0) : 0,
        };
        break;
      }
      case "gap": {
        const choices = q?.choices ?? [];
        const ordered = orderChoices({ choices });
        const [top, second] = ordered;
        const counts = Object.fromEntries((spec.choices ?? choices.map((c) => c.text)).map((text) => [text, choices.find((c) => normalize(c.text) === normalize(text))?.votes ?? 0]));
        const base = {
          index: entry.index,
          gap_id: entry.gap_id ?? `q${entry.index}`,
          item: entry.item,
          field: entry.field,
          question: spec.title,
          votes: answered,
          counts,
        };
        let result;
        if (!answered || !top || top.votes === 0) {
          result = { ...base, winning_option: null, resolution: "no_responses" };
        } else if (second && second.votes === top.votes) {
          result = {
            ...base,
            winning_option: null,
            resolution: "tie",
            detail: ordered.filter((c) => c.votes === top.votes).map((c) => `${c.text} ${c.votes}`).join(", "),
          };
        } else if (isEscapeOption(top.text, { escape_options: entry.escape_options })) {
          result = { ...base, winning_option: top.text, resolution: "escape_hatch" };
        } else {
          result = { ...base, winning_option: top.text, resolution: "filled" };
        }
        out.gaps.push(result);
        break;
      }
      case "ranking": {
        const choices = q?.choices ?? [];
        const ordered = orderChoices({ choices });
        const n = ordered.length;
        const scale = request.priority_scale;
        const bucket = Math.max(1, Math.ceil(n / scale.length));
        const specChoices = spec.choices ?? [];
        const order = ordered.map((c, rank) => {
          const specIndex = specChoices.findIndex((text) => normalize(text) === normalize(c.text));
          return {
            rank: rank + 1,
            choice: c.text,
            item: entry.items?.[specIndex >= 0 ? specIndex : c.index] ?? null,
            score: c.votes,
            priority: scale[Math.min(Math.floor(rank / bucket), scale.length - 1)],
          };
        });
        out.ranking = { index: entry.index, respondents: answered, order, scale, note: "rank buckets mapped onto the scale (top third first); a rank is not literally a priority label" };
        break;
      }
      case "meeting_rating": {
        out.meeting_rating = { index: entry.index, average: q?.averageScore ?? null, responses: answered };
        break;
      }
      case "missed_items":
      case "next_agenda":
      case "other":
      default: {
        if (spec.type === "openEnded" || spec.type === "wordCloud" || entry.readback === "human_only" || entry.readback === "organiser_only") {
          out.human_only.push({ index: entry.index, role: entry.role, question: spec.title, responses: answered });
        } else {
          out.human_only.push({ index: entry.index, role: entry.role, question: spec.title, responses: answered, counts: Object.fromEntries((q?.choices ?? []).map((c) => [c.text, c.votes])) });
        }
      }
    }
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class SurveyRunner {
  constructor(deps) {
    this.mcp = deps.mcp;
    this.store = deps.store;
    this.pollEveryMs = deps.pollEveryMs ?? 5000;
    this.graceMs = deps.graceMs ?? 90_000;
    this.log = deps.log ?? ((line) => console.log(`[polly] ${line}`));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleep;
    this.watching = new Map();
  }

  static recordId(request) {
    return request.survey.draftId ? `survey_${request.survey.draftId}` : "survey";
  }

  buildArgs(request) {
    const draftId = request.survey.draftId ?? draftIdFor(request.meeting_id, "survey");
    const hasAudience = ["userEmails", "userIds", "userNames", "channelNames"].some((k) => request.survey[k]?.length);
    const args = {
      ...request.survey,
      draftId,
      channelNames: hasAudience ? request.survey.channelNames : [String(request.channel).replace(/^#/, "")],
      anonymityLevel: request.survey.anonymityLevel ?? "nonAnonymous",
      resultsVisibility: request.survey.resultsVisibility ?? "onClose",
    };
    return { draftId, args };
  }

  newRecord(request, draftId) {
    const stamp = new Date().toISOString();
    return {
      id: SurveyRunner.recordId(request),
      meeting_id: request.meeting_id,
      kind: "survey",
      question: request.survey.title,
      options: [],
      channel: request.channel ?? null,
      meta: { question_map: request.question_map, draft_id: draftId, question_count: request.survey.questions.length },
      status: "sending",
      votes: 0,
      choices: [],
      ranking: [],
      questions: [],
      readback: undefined,
      created_at: stamp,
      updated_at: stamp,
    };
  }

  /** Create the survey (reusing one already sent for this meeting + draftId). */
  async send(request) {
    const id = SurveyRunner.recordId(request);
    const existing = this.store.read(request.meeting_id, id);
    if (existing?.polly && existing.status !== "failed") {
      this.log(`${request.meeting_id}: survey already sent as ${existing.polly.type} ${existing.polly.id} (${existing.status}) — reusing`);
      return existing;
    }
    const { draftId, args } = this.buildArgs(request);
    const record = existing ?? this.newRecord(request, draftId);
    record.status = "sending";
    record.error = undefined;
    this.store.write(record);
    try {
      const created = await this.mcp.createSurvey(args);
      record.polly = {
        id: created.id,
        type: created.type,
        draft_id: draftId,
        results_url: created.resultsUrl,
        web_voting_url: created.webVotingUrl,
        delivered_via: created.deliveredVia,
        close_at: created.closeAt ?? null,
        sent_at: new Date().toISOString(),
      };
      record.status = "open";
      const audience = args.userEmails?.length || args.userIds?.length || args.userNames?.length
        ? `by DM to ${[...(args.userEmails ?? []), ...(args.userIds ?? []), ...(args.userNames ?? [])].join(", ")}`
        : `to #${args.channelNames?.[0]}`;
      this.log(`${request.meeting_id}: survey "${request.survey.title}" sent ${audience} as ${created.type} ${created.id}${created.alreadySent ? " (was already sent)" : ""}`);
    } catch (err) {
      record.status = "failed";
      record.error = err instanceof Error ? err.message : String(err);
      this.log(`${request.meeting_id}: survey send FAILED — ${record.error}`);
    }
    this.store.write(record);
    return record;
  }

  watch(request, record) {
    const key = `${record.meeting_id}/${record.id}`;
    const inflight = this.watching.get(key);
    if (inflight) return inflight;
    const promise = this.watchLoop(request, record).finally(() => this.watching.delete(key));
    this.watching.set(key, promise);
    return promise;
  }

  async watchLoop(request, record) {
    if (!record.polly) throw new Error(`${record.id}: nothing to watch — not sent`);
    if (record.status === "closed") return record;
    const { id, type } = record.polly;
    const start = this.now();
    const minutes = request.timeout_minutes ?? minutesUntilClose(request.survey.closeAt, start);
    const deadline = start + minutes * 60_000 + this.graceMs;
    let lastVotes = -1;
    let lastChange = start;
    let failures = 0;

    for (;;) {
      try {
        const results = await this.mcp.getAllResults(id, type);
        failures = 0;
        record.votes = results.responseCount;
        record.questions = results.questions;
        record.readback = readbackSurvey(request, results);
        if (results.closeAt !== undefined && record.polly) record.polly.close_at = results.closeAt;
        const at = this.now();
        if (record.votes !== lastVotes) {
          lastVotes = record.votes;
          lastChange = at;
          this.log(`${record.meeting_id}: ${record.votes} respondent${record.votes === 1 ? "" : "s"}`);
        }
        this.store.write(record);
        if (results.status === "closed" || results.active === false) return this.finalize(request, record, "polly_close_at");
        const settled = at - lastChange >= request.settle_seconds * 1000;
        if (request.auto_close && record.votes >= request.min_votes && settled) {
          await this.tryClose(record, id, type);
          return this.finalize(request, record, "settled");
        }
      } catch (err) {
        failures++;
        this.log(`${record.meeting_id}: survey read failed (${failures}) — ${err instanceof Error ? err.message : String(err)}`);
      }
      if (this.now() >= deadline) {
        await this.tryClose(record, id, type);
        return this.finalize(request, record, "timeout");
      }
      await this.sleep(this.pollEveryMs);
    }
  }

  async tryClose(record, id, type) {
    try {
      await this.mcp.closePoll(id, type);
    } catch (err) {
      this.log(`${record.meeting_id}: close_polly failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async close(request) {
    const record = this.store.read(request.meeting_id, SurveyRunner.recordId(request));
    if (!record?.polly) throw new Error(`${request.meeting_id}: no sent survey`);
    if (record.status === "closed") return record;
    await this.tryClose(record, record.polly.id, record.polly.type);
    try {
      const results = await this.mcp.getAllResults(record.polly.id, record.polly.type);
      record.votes = results.responseCount;
      record.questions = results.questions;
      record.readback = readbackSurvey(request, results);
    } catch (err) {
      this.log(`${request.meeting_id}: final survey read failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.finalize(request, record, "manual");
  }

  finalize(request, record, closedBy) {
    record.status = "closed";
    record.closed_by = closedBy;
    record.closed_at = new Date().toISOString();
    record.winner = undefined;
    this.store.write(record);
    const gaps = record.readback?.gaps ?? [];
    this.log(`${summarizeRecord(record)} · ${gaps.length} gap${gaps.length === 1 ? "" : "s"}: ${gaps.map((g) => `${g.gap_id}=${g.resolution}`).join(", ") || "none"}`);
    return record;
  }

  /** send + watch + summary (poll_round.json, summary.md). */
  async run(request, hooks = {}) {
    const sent = await this.send(request);
    await hooks.onSent?.([sent]);
    const record = sent.status === "open" ? await this.watch(request, sent) : sent;
    const summary = this.store.writeSummary(request.meeting_id);
    this.log(`summary → ${summary.md} · poll round → ${summary.round}`);
    return { record, summary };
  }

  async resume(request) {
    const record = this.store.read(request.meeting_id, SurveyRunner.recordId(request));
    if (!record || record.status !== "open") return record;
    return this.watch(request, record);
  }
}
