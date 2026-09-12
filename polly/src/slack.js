/**
 * Optional: posting a plain results message into Slack. Not part of the
 * agreed flow (the Slack-app lane renders results as a canvas from our files);
 * kept as an opt-in for demos without that lane. Needs a Slack bot token.
 */
import { LogLevel, WebClient } from "@slack/web-api";
export function renderResultsMrkdwn(record) {
    const lines = [
        `:ballot_box_with_check: *Poll closed — ${record.question}*  (${record.votes} vote${record.votes === 1 ? "" : "s"})`,
    ];
    if (record.context)
        lines.push(`_${record.context}_`);
    for (const entry of record.ranking) {
        lines.push(`${entry.rank}. *${entry.option}* — ${entry.score}${entry.percentage ? ` (${Math.round(entry.percentage)}%)` : ""}`);
    }
    if (!record.ranking.length) {
        for (const choice of record.choices)
            lines.push(`• ${choice.text} — ${choice.votes}`);
    }
    const tail = [`ClosedLoop · ${record.meeting_id} · ${record.id}`];
    if (record.polly?.results_url)
        tail.push(`<${record.polly.results_url}|full results>`);
    lines.push(`_${tail.join(" · ")}_`);
    return lines.join("\n");
}
export class SlackResultsPoster {
    channelOverride;
    slack;
    channelIds = new Map();
    constructor(token, 
    /** Post results here instead of the poll's own channel (optional). */
    channelOverride) {
        this.channelOverride = channelOverride;
        this.slack = new WebClient(token, { logLevel: LogLevel.WARN });
    }
    async resolve(ref) {
        const name = ref.replace(/^#/, "").trim();
        if (/^[CG][A-Z0-9]{8,}$/.test(name))
            return name;
        const cached = this.channelIds.get(name);
        if (cached)
            return cached;
        let cursor;
        do {
            const res = await this.slack.conversations.list({
                types: "public_channel,private_channel",
                exclude_archived: true,
                limit: 1000,
                cursor,
            });
            for (const channel of res.channels ?? []) {
                if (channel.id && channel.name)
                    this.channelIds.set(channel.name, channel.id);
            }
            cursor = res.response_metadata?.next_cursor || undefined;
        } while (cursor && !this.channelIds.has(name));
        const id = this.channelIds.get(name);
        if (!id)
            throw new Error(`Slack channel not found: #${name}`);
        return id;
    }
    async post(record) {
        const channel = await this.resolve(this.channelOverride ?? record.channel);
        const res = await this.slack.chat.postMessage({
            channel,
            text: renderResultsMrkdwn(record),
            unfurl_links: false,
            unfurl_media: false,
        });
        if (!res.ts)
            throw new Error("chat.postMessage returned no ts");
        return { channel, ts: res.ts };
    }
}
/**
 * Opt-in only: results are handed to the Slack app lane as files, which
 * renders the canvas. Set POLLY_POST_RESULTS=true and SLACK_BOT_TOKEN to have
 * this module post a plain results message itself.
 */
export function posterFromEnv() {
    const token = process.env.SLACK_BOT_TOKEN;
    if (process.env.POLLY_POST_RESULTS !== "true" || !token)
        return undefined;
    return new SlackResultsPoster(token, process.env.POLLY_RESULTS_CHANNEL || undefined);
}
