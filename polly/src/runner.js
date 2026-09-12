import { draftIdFor, resolveAudience, resolveDelivery, toPollyQuestion, } from "./request.js";
import { rankChoices, summarizeRecord } from "./results.js";
export class PollRunner {
    mcp;
    store;
    poster;
    pollEveryMs;
    graceMs;
    log;
    now;
    sleep;
    watching = new Map();
    constructor(deps) {
        this.mcp = deps.mcp;
        this.store = deps.store;
        this.poster = deps.poster;
        this.pollEveryMs = deps.pollEveryMs ?? 5000;
        this.graceMs = deps.graceMs ?? 90_000;
        this.log = deps.log ?? ((line) => console.log(`[polly] ${line}`));
        this.now = deps.now ?? Date.now;
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }
    newRecord(request, poll) {
        const stamp = new Date().toISOString();
        return {
            id: poll.id,
            meeting_id: request.meeting_id,
            kind: poll.kind,
            question: poll.question,
            options: poll.options,
            context: poll.context,
            channel: request.channel,
            audience: poll.audience,
            delivery: resolveDelivery(poll.delivery, poll.audience, request.required_attendees),
            escape_options: poll.escape_options,
            meta: poll.meta,
            status: "sending",
            votes: 0,
            choices: [],
            ranking: [],
            created_at: stamp,
            updated_at: stamp,
        };
    }
    /** Create every poll in the request. Re-running is safe: sent polls are reused. */
    async send(request) {
        const records = [];
        for (const poll of request.polls) {
            const existing = this.store.read(request.meeting_id, poll.id);
            if (existing?.polly && existing.status !== "failed") {
                this.log(`${poll.id}: already sent as ${existing.polly.type} ${existing.polly.id} (${existing.status}) — reusing`);
                records.push(existing);
                continue;
            }
            const record = existing ?? this.newRecord(request, poll);
            record.status = "sending";
            record.error = undefined;
            this.store.write(record);
            const draftId = draftIdFor(request.meeting_id, poll.id);
            try {
                const question = toPollyQuestion(poll);
                let audience;
                if (record.delivery === "dm") {
                    audience = resolveAudience(poll.audience, request.roster);
                    if (!audience.emails.length && !audience.ids.length && !audience.names.length) {
                        this.log(`${poll.id}: DM delivery requested but nobody resolvable — posting in ${request.channel}`);
                        record.delivery = "channel";
                        audience = undefined;
                    }
                }
                const created = await this.mcp.createPoll({
                    draftId,
                    question: poll.question,
                    type: question.type,
                    options: question.options,
                    rankCount: question.rankCount,
                    allowMultipleAnswers: question.allowMultipleAnswers,
                    channel: request.channel,
                    audience,
                    appeal: poll.context,
                    closeAt: `+${poll.close_after_minutes}m`,
                    anonymous: poll.anonymous,
                });
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
                this.log(`${poll.id}: sent ${record.delivery === "dm" ? `by DM to ${poll.audience.join(", ")}` : `to ${request.channel}`} as ${created.type} ${created.id}${created.alreadySent ? " (was already sent)" : ""}`);
            }
            catch (err) {
                record.status = "failed";
                record.error = err instanceof Error ? err.message : String(err);
                this.log(`${poll.id}: send FAILED — ${record.error}`);
            }
            this.store.write(record);
            records.push(record);
        }
        return records;
    }
    /** Watch one open poll until it closes; returns the finalized record. */
    watch(record, poll) {
        const key = `${record.meeting_id}/${record.id}`;
        const inflight = this.watching.get(key);
        if (inflight)
            return inflight;
        const promise = this.watchLoop(record, poll).finally(() => this.watching.delete(key));
        this.watching.set(key, promise);
        return promise;
    }
    async watchLoop(record, poll) {
        if (!record.polly)
            throw new Error(`${record.id}: nothing to watch — not sent`);
        if (record.status === "closed")
            return record;
        const { id, type } = record.polly;
        const start = this.now();
        const deadline = start + poll.close_after_minutes * 60_000 + this.graceMs;
        let lastVotes = -1;
        let lastChange = start;
        let failures = 0;
        for (;;) {
            try {
                const results = await this.mcp.getResults(id, type);
                failures = 0;
                record.votes = results.responseCount || results.totalVotes;
                record.choices = results.choices;
                if (results.closeAt !== undefined && record.polly)
                    record.polly.close_at = results.closeAt;
                const at = this.now();
                if (record.votes !== lastVotes) {
                    lastVotes = record.votes;
                    lastChange = at;
                    this.log(`${record.id}: ${record.votes} vote${record.votes === 1 ? "" : "s"}`);
                }
                this.store.write(record);
                if (results.status === "closed" || results.active === false) {
                    return this.finalize(record, "polly_close_at");
                }
                const settled = at - lastChange >= poll.settle_seconds * 1000;
                if (poll.auto_close && record.votes >= poll.min_votes && settled) {
                    await this.tryClose(record, id, type);
                    return this.finalize(record, "settled");
                }
            }
            catch (err) {
                failures++;
                this.log(`${record.id}: read failed (${failures}) — ${err instanceof Error ? err.message : String(err)}`);
            }
            if (this.now() >= deadline) {
                await this.tryClose(record, id, type);
                return this.finalize(record, "timeout");
            }
            await this.sleep(this.pollEveryMs);
        }
    }
    async tryClose(record, id, type) {
        try {
            await this.mcp.closePoll(id, type);
        }
        catch (err) {
            this.log(`${record.id}: close_polly failed — ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    /** Manual close (CLI / HTTP): closes in Polly, reads the final numbers, finalizes. */
    async close(meetingId, pollId) {
        const record = this.store.read(meetingId, pollId);
        if (!record?.polly)
            throw new Error(`${pollId}: no sent poll for ${meetingId}`);
        if (record.status === "closed")
            return record;
        await this.tryClose(record, record.polly.id, record.polly.type);
        try {
            const results = await this.mcp.getResults(record.polly.id, record.polly.type);
            record.votes = results.responseCount || results.totalVotes;
            record.choices = results.choices;
        }
        catch (err) {
            this.log(`${pollId}: final read failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        return this.finalize(record, "manual");
    }
    async finalize(record, closedBy) {
        record.ranking = rankChoices(record.options, record.choices);
        record.winner = record.ranking[0]?.option;
        record.status = "closed";
        record.closed_by = closedBy;
        record.closed_at = new Date().toISOString();
        this.store.write(record);
        this.log(summarizeRecord(record));
        if (this.poster) {
            try {
                const posted = await this.poster.post(record);
                record.slack = { posted: true, ...posted };
                this.log(`${record.id}: results posted to ${posted.channel}`);
            }
            catch (err) {
                record.slack = { posted: false, error: err instanceof Error ? err.message : String(err) };
                this.log(`${record.id}: Slack post failed — ${record.slack.error}`);
            }
            this.store.write(record);
        }
        return record;
    }
    /** send + watch everything in the request, then write the meeting summary. */
    async run(request, hooks = {}) {
        const sent = await this.send(request);
        await hooks.onSent?.(sent);
        const byId = new Map(request.polls.map((poll) => [poll.id, poll]));
        const records = await Promise.all(sent.map((record) => record.status === "open" ? this.watch(record, byId.get(record.id)) : Promise.resolve(record)));
        const summary = this.store.writeSummary(request.meeting_id);
        this.log(`summary → ${summary.md} · poll round → ${summary.round}`);
        return { records, summary: { json: summary.json, md: summary.md, round: summary.round } };
    }
    /** Resume watching every open record of a meeting (after a restart). */
    async resume(request) {
        const byId = new Map(request.polls.map((poll) => [poll.id, poll]));
        const open = this.store.list(request.meeting_id).filter((r) => r.status === "open" && byId.has(r.id));
        return Promise.all(open.map((record) => this.watch(record, byId.get(record.id))));
    }
}
