/**
 * Hands each stage of the loop to the Slack lane: POST JSON to LOOP_CALLBACK_URL
 * (signed with LOOP_CALLBACK_SECRET when set) and append it to data/events.jsonl
 * so a consumer that missed the webhook can catch up via GET /loop/:id/events.
 */
import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { root } from "../meeting-records.js";

export const EVENTS = ["notes.ready", "survey.sent", "survey.skipped", "results.ready", "notes.enriched", "live.poll_sent", "live.poll_closed", "loop.failed"];

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export function sign(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function createNotifier({ url, secret, log = () => {}, eventsPath = resolve(root, "data/events.jsonl"), fetchImpl = globalThis.fetch, retries = 3, timeoutMs = 10_000, backoffMs = 1500 } = {}) {
  const readEvents = (meetingId) => {
    if (!existsSync(eventsPath)) return [];
    return readFileSync(eventsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => !meetingId || event.meeting_id === meetingId);
  };

  const record = (entry) => {
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, `${JSON.stringify(entry)}\n`);
  };

  const deliver = async (body, headers) => {
    let lastError = "";
    for (let attempt = 1; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
        if (response.ok) return { delivered: true, status: response.status, attempts: attempt };
        lastError = `HTTP ${response.status}`;
        if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) break;
      } catch (error) {
        lastError = error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : (error?.message ?? String(error));
      } finally {
        clearTimeout(timer);
      }
      if (attempt < retries) await sleep(backoffMs * attempt);
    }
    return { delivered: false, status: null, attempts: retries, error: lastError };
  };

  return {
    url,
    events: readEvents,
    /** @returns {Promise<{ delivered: boolean, status: number|null, attempts: number, error?: string, skipped?: boolean }>} */
    async notify(event, payload) {
      if (!EVENTS.includes(event)) throw new Error(`unknown loop event: ${event}`);
      const message = { event, sent_at: new Date().toISOString(), ...payload };
      const body = JSON.stringify(message);
      let outcome;
      if (!url) {
        outcome = { delivered: false, status: null, attempts: 0, skipped: true };
      } else {
        const headers = { "Content-Type": "application/json", "User-Agent": "closedloop-loop/1.0", "X-ClosedLoop-Event": event, "X-ClosedLoop-Meeting": String(payload.meeting_id ?? "") };
        if (secret) headers["X-ClosedLoop-Signature"] = sign(secret, body);
        outcome = await deliver(body, headers);
      }
      record({ ts: message.sent_at, event, meeting_id: payload.meeting_id ?? null, delivered: outcome.delivered, status: outcome.status, attempts: outcome.attempts, error: outcome.error, url: url ?? null, summary: payload.summary ?? undefined });
      if (url) log(`${payload.meeting_id ?? "-"}: ${event} → ${url} ${outcome.delivered ? `delivered (${outcome.status})` : `NOT delivered (${outcome.error})`}`);
      else log(`${payload.meeting_id ?? "-"}: ${event} (no LOOP_CALLBACK_URL — logged to ${eventsPath})`);
      return outcome;
    },
  };
}
