/**
 * npm run polly -- <command>
 *
 *   auth                          connect to Polly (browser consent, one time)
 *   tools                         list the Polly MCP tools we can see (connectivity check)
 *   run <file.json>               send every poll in the file, watch until closed, write results
 *   send <file.json>              send only (watch later with `watch`)
 *   watch <file.json>             resume watching the open polls of that file
 *   results <meeting_id> [id]     print stored results
 *   close <meeting_id> <id>       close a poll now and finalize it
 *   test-poll [--channel=#x]      throwaway 3-option poll; vote once and it closes itself
 *   (the HTTP API + inbox run inside the main server: `npm start`)
 */
import { existsSync, readFileSync } from "node:fs";
import { createPolly } from "../index.js";
import { authorizeInteractive, readStoredToken, tokenPath } from "./oauth.js";
import { parsePollRequest } from "./request.js";
import { ResultsStore, renderRecordMarkdown } from "./results.js";
if (existsSync(".env"))
    process.loadEnvFile(".env");
const [command = "help", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest
    .filter((arg) => arg.startsWith("--"))
    .map((arg) => {
    const [key, value] = arg.slice(2).split("=");
    return [key, value ?? "true"];
}));
const args = rest.filter((arg) => !arg.startsWith("--"));
const env = process.env;
const defaultChannel = flags.channel || env.POLLY_CHANNEL || undefined;
const resultsDir = env.POLLY_RESULTS_DIR || "polly/results";
const pollEveryMs = Number(env.POLLY_POLL_EVERY_MS || 5000);
function help() {
    console.log(`ClosedLoop Polly module

  npm run polly:auth                          connect to Polly (one-time browser consent)
  npm run polly -- tools                      connectivity check
  npm run polly -- run polly/examples/survey-request.json     (survey from the meeting-loop-polly skill)
  npm run polly -- run polly/examples/gaps-request.json       (one poll per gap)
  npm run polly -- send <file>  |  watch <file>  |  close <meeting_id> <id>
  npm run polly -- results <meeting_id> [id]
  npm run polly -- test-poll --channel=#closed-loop-project
  npm start                                   main server: Zoom webhook + POST /polls + inbox ${env.POLLY_INBOX_DIR || "polly/inbox"}
`);
}
function makePolly() {
    const polly = createPolly({ channel: defaultChannel, resultsDir, pollEveryMs });
    return { polly, runner: polly.runner, store: polly.store, mcp: polly.mcp };
}
function loadRaw(file) {
    if (!file)
        throw new Error("usage: <command> <request.json>");
    return JSON.parse(readFileSync(file, "utf8"));
}
function loadRequest(file) {
    return parsePollRequest(loadRaw(file), { channel: defaultChannel });
}
async function main() {
    switch (command) {
        case "auth": {
            await authorizeInteractive({ openBrowser: flags.open !== "false" });
            return;
        }
        case "tools": {
            const stored = readStoredToken();
            console.log(stored
                ? `token: ${tokenPath()} (scope: ${stored.scope ?? "?"}, expires ${new Date(stored.expires_at).toISOString()})`
                : env.POLLY_MCP_TOKEN
                    ? "token: POLLY_MCP_TOKEN from env"
                    : "no token — run: npm run polly:auth");
            const { mcp } = makePolly();
            console.log((await mcp.listTools()).join("\n"));
            await mcp.disconnect();
            return;
        }
        case "run": {
            const raw = loadRaw(args[0]);
            const { polly, mcp } = makePolly();
            const outcome = await polly.run(raw);
            const records = outcome.records ?? [outcome.record];
            for (const record of records)
                console.log(renderRecordMarkdown(record), "\n");
            console.log(`summary: ${outcome.summary.md}\npoll round (for enrich): ${outcome.summary.round}`);
            await mcp.disconnect();
            return;
        }
        case "send": {
            const raw = loadRaw(args[0]);
            const { polly, runner, mcp } = makePolly();
            const { kind, request } = polly.parse(raw);
            const records = kind === "survey" ? [await polly.surveys.send(request)] : await runner.send(request);
            console.log(JSON.stringify(records.map((r) => ({ id: r.id, status: r.status, polly: r.polly ?? null, error: r.error })), null, 2));
            await mcp.disconnect();
            return;
        }
        case "watch": {
            const raw = loadRaw(args[0]);
            const { polly, store, mcp } = makePolly();
            const { request } = polly.parse(raw);
            const resumed = await polly.resume(raw);
            const records = Array.isArray(resumed) ? resumed : resumed ? [resumed] : [];
            if (!records.length)
                console.log("nothing open to watch");
            const summary = store.writeSummary(request.meeting_id);
            console.log(`summary: ${summary.md}`);
            await mcp.disconnect();
            return;
        }
        case "results": {
            const [meetingId, pollId] = args;
            if (!meetingId)
                throw new Error("usage: results <meeting_id> [poll id]");
            const store = new ResultsStore(resultsDir);
            const records = pollId ? [store.read(meetingId, pollId)].filter(Boolean) : store.list(meetingId);
            if (!records.length) {
                console.log("no results yet");
                return;
            }
            for (const record of records)
                console.log(JSON.stringify(record, null, 2));
            return;
        }
        case "close": {
            const [meetingId, pollId] = args;
            if (!meetingId || !pollId)
                throw new Error("usage: close <meeting_id> <poll id>");
            const { runner, mcp } = makePolly();
            const record = await runner.close(meetingId, pollId);
            console.log(renderRecordMarkdown(record));
            await mcp.disconnect();
            return;
        }
        case "test-poll": {
            if (!defaultChannel)
                throw new Error("set --channel=#name or POLLY_CHANNEL");
            const request = parsePollRequest({
                meeting_id: `test_${Date.now().toString(36)}`,
                channel: defaultChannel,
                polls: [
                    {
                        id: "hello",
                        kind: "ranked",
                        question: "ClosedLoop test — rank these (throwaway, closes after your vote)",
                        options: ["Alpha", "Bravo", "Charlie"],
                        context: "Connectivity test from the ClosedLoop build. One vote is enough.",
                        close_after_minutes: Number(flags.minutes ?? 5),
                        min_votes: Number(flags.votes ?? 1),
                        settle_seconds: Number(flags.settle ?? 10),
                    },
                ],
            });
            const { runner, mcp } = makePolly();
            const { records } = await runner.run(request);
            console.log(renderRecordMarkdown(records[0]));
            await mcp.disconnect();
            return;
        }
        default:
            help();
    }
}
main().catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
