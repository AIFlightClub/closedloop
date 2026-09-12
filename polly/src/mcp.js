/**
 * Polly MCP client — the only way this module touches Polly.
 *
 * Talks to Polly's MCP server (https://mcp.polly.ai/mcp) as an OAuth bearer
 * client, the same way any MCP host would. Per poll:
 *   draft_polly → create_polly { draftId, userConfirmed: true }
 *   (idempotent per draftId: a retried send can never double-post)
 *   → get_polly_results until closed → close_polly
 *
 * The server's confirm-before-send round only fires for hosts that advertise
 * elicitation; this client advertises none, so sends are plain tool calls.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadPollyAccessToken, mcpUrl } from "./oauth.js";
export class PollyToolError extends Error {
    tool;
    constructor(tool, message) {
        super(`${tool}: ${message}`);
        this.tool = tool;
        this.name = "PollyToolError";
    }
}
/** "This draft was already sent — … id: "abc" and type: "poll"" → the sent polly. */
export function parseAlreadySent(message) {
    const match = /id: "([^"]+)" and type: "(poll|survey)"/.exec(message);
    return match ? { id: match[1], type: match[2] } : undefined;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const str = (value) => (typeof value === "string" ? value : undefined);
const num = (value) => typeof value === "number" ? value : Number(value ?? 0) || 0;
function stripUndefined(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
function pollyTypeOf(value) {
    return typeof value === "string" && value.startsWith("survey") ? "survey" : "poll";
}
/**
 * Denials come back success-shaped: `planLimit` (a feature the plan lacks,
 * e.g. surveys) or `accessDenied` (MCP / "AI tools" switched off for the org).
 */
function assertNotDenied(tool, out) {
    const planLimit = out.planLimit;
    if (planLimit) {
        throw new PollyToolError(tool, `plan limit (${String(planLimit.reason ?? "unknown")}): ${String(planLimit.aiNote ?? out.message ?? "")}`);
    }
    const denied = out.accessDenied;
    if (denied) {
        throw new PollyToolError(tool, `access denied: ${String(denied.message ?? denied.reason ?? JSON.stringify(denied))}`);
    }
}
export function isAccessDeniedError(message) {
    return /access denied/i.test(String(message ?? ""));
}
export class PollyMcp {
    url;
    token;
    client;
    constructor(url, token) {
        this.url = url;
        this.token = token;
    }
    static async fromEnv() {
        return new PollyMcp(mcpUrl(), await loadPollyAccessToken());
    }
    async connect() {
        if (this.client)
            return;
        const transport = new StreamableHTTPClientTransport(new URL(this.url), {
            requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
        });
        const client = new Client({ name: "closedloop-polly", version: "0.1.0" }, { capabilities: {} });
        await client.connect(transport);
        this.client = client;
    }
    async disconnect() {
        const client = this.client;
        this.client = undefined;
        await client?.close();
    }
    async listTools() {
        await this.connect();
        const res = await this.client.listTools();
        return res.tools.map((tool) => tool.name);
    }
    /** One tool call; tool errors surface immediately, transport failures reconnect + retry. */
    async call(name, args, attempts = 1) {
        for (let attempt = 1;; attempt++) {
            try {
                await this.connect();
                const res = (await this.client.callTool({ name, arguments: args }));
                const text = (res.content ?? [])
                    .filter((block) => block.type === "text")
                    .map((block) => block.text ?? "")
                    .join("\n")
                    .trim();
                if (res.isError)
                    throw new PollyToolError(name, text || "tool returned an error");
                if (res.structuredContent && typeof res.structuredContent === "object") {
                    return res.structuredContent;
                }
                try {
                    return JSON.parse(text);
                }
                catch {
                    throw new PollyToolError(name, `unparseable result: ${text.slice(0, 400)}`);
                }
            }
            catch (err) {
                if (err instanceof PollyToolError || attempt >= attempts)
                    throw err;
                await this.disconnect().catch(() => undefined);
                await sleep(500 * attempt);
            }
        }
    }
    async createPoll(input) {
        const question = stripUndefined({
            title: input.question,
            type: input.type,
            choices: input.options?.length ? input.options : undefined,
            rankCount: input.type === "ranked" ? (input.rankCount ?? input.options?.length) : undefined,
            allowMultipleAnswers: input.type === "multipleChoice" ? input.allowMultipleAnswers : undefined,
        });
        const people = input.audience;
        const hasPeople = !!(people?.emails?.length || people?.ids?.length || people?.names?.length);
        let draft;
        try {
            draft = await this.call("draft_polly", stripUndefined({
                draftId: input.draftId,
                channelNames: hasPeople ? undefined : [input.channel.replace(/^#/, "")],
                userEmails: people?.emails?.length ? people.emails : undefined,
                userIds: people?.ids?.length ? people.ids : undefined,
                userNames: people?.names?.length ? people.names : undefined,
                questions: [question],
                appeal: input.appeal,
                resultsVisibility: "realTime",
                anonymityLevel: input.anonymous ? "anonymous" : undefined,
                closeAt: input.closeAt,
            }), 3);
        }
        catch (err) {
            // Same draftId sent earlier (e.g. a re-run after a crash): recover the polly.
            const sent = err instanceof PollyToolError ? parseAlreadySent(err.message) : undefined;
            if (!sent)
                throw err;
            return { ...sent, alreadySent: true, raw: {} };
        }
        assertNotDenied("draft_polly", draft);
        const sent = await this.call("create_polly", { draftId: input.draftId, userConfirmed: true }, 3);
        assertNotDenied("create_polly", sent);
        const id = str(sent.id);
        if (!id) {
            throw new PollyToolError("create_polly", `no polly id in result: ${JSON.stringify(sent).slice(0, 400)}`);
        }
        return {
            id,
            type: pollyTypeOf(sent.type),
            resultsUrl: str(sent.resultsUrl),
            webVotingUrl: str(sent.webVotingUrl),
            deliveredVia: str(sent.deliveredVia),
            closeAt: sent.closeAt ?? null,
            alreadySent: sent.alreadySent === true,
            raw: sent,
        };
    }
    async getResults(id, type) {
        const out = await this.call("get_polly_results", { id, type }, 3);
        assertNotDenied("get_polly_results", out);
        const results = out.results;
        const question = (Array.isArray(results) ? results[0] : results);
        const rawChoices = question?.choices ?? [];
        return {
            id,
            type,
            status: str(out.status),
            active: typeof out.active === "boolean" ? out.active : undefined,
            closeAt: out.closeAt ?? null,
            totalVotes: num(question?.totalVotes),
            responseCount: num(question?.responseCount ?? out.responseCount),
            choices: rawChoices.map((choice) => ({
                text: String(choice.text ?? ""),
                votes: num(choice.votes),
                percentage: num(choice.percentage),
            })),
            raw: out,
        };
    }
    /**
     * Multi-question polly (a survey). `input` is the create_survey argument
     * object the meeting-loop-polly skill builds — title, appeal, questions,
     * audience, closeAt, visibility, reminders — passed through untouched.
     */
    async createSurvey(input) {
        const { draftId, ...rest } = input;
        if (!draftId)
            throw new Error("createSurvey: draftId is required");
        let draft;
        try {
            draft = await this.call("draft_polly", stripUndefined({ draftId, ...rest }), 3);
        }
        catch (err) {
            const sent = err instanceof PollyToolError ? parseAlreadySent(err.message) : undefined;
            if (!sent)
                throw err;
            return { ...sent, alreadySent: true, raw: {} };
        }
        assertNotDenied("draft_polly", draft);
        const sent = await this.call("create_polly", { draftId, userConfirmed: true }, 3);
        assertNotDenied("create_polly", sent);
        const id = str(sent.id);
        if (!id) {
            throw new PollyToolError("create_polly", `no polly id in result: ${JSON.stringify(sent).slice(0, 400)}`);
        }
        return {
            id,
            type: pollyTypeOf(sent.type),
            resultsUrl: str(sent.resultsUrl),
            webVotingUrl: str(sent.webVotingUrl),
            deliveredVia: str(sent.deliveredVia),
            closeAt: sent.closeAt ?? null,
            alreadySent: sent.alreadySent === true,
            raw: sent,
        };
    }
    /** Every question's aggregate: one entry for a poll, one per question for a survey. */
    async getAllResults(id, type) {
        const out = await this.call("get_polly_results", { id, type }, 3);
        assertNotDenied("get_polly_results", out);
        const list = Array.isArray(out.results) ? out.results : out.results ? [out.results] : [];
        const questions = list.map((q, index) => ({
            index,
            id: str(q?.id),
            title: str(q?.title),
            type: str(q?.type),
            totalVotes: num(q?.totalVotes),
            responseCount: num(q?.responseCount),
            averageScore: typeof q?.averageScore === "number" ? q.averageScore : undefined,
            npsScore: typeof q?.npsScore === "number" ? q.npsScore : undefined,
            choices: (q?.choices ?? []).map((c) => ({
                text: String(c?.text ?? ""),
                votes: num(c?.votes),
                percentage: num(c?.percentage),
            })),
        }));
        return {
            id,
            type,
            status: str(out.status),
            active: typeof out.active === "boolean" ? out.active : undefined,
            closeAt: out.closeAt ?? null,
            responseCount: num(out.responseCount) || Math.max(0, ...questions.map((q) => q.responseCount)),
            questions,
            raw: out,
        };
    }
    async closePoll(id, type) {
        await this.call("close_polly", { id, type }, 2);
    }
}
