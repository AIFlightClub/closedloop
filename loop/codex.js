/**
 * Headless Codex CLI runner shared by notes generation, the survey builder,
 * enrichment and live detection: one `codex exec` per call, structured output
 * enforced with --output-schema, prompt on stdin.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, saveJson } from "../meeting-records.js";

const CHATGPT_APP_CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex";

/** CODEX_BIN, else the CLI bundled with the ChatGPT desktop app, else `codex` on PATH. */
export function codexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  return existsSync(CHATGPT_APP_CODEX) ? CHATGPT_APP_CODEX : "codex";
}

/**
 * Run one prompt through Codex and return the JSON object it produced.
 * Defaults match generate-notes.js: the fast model with reasoning off
 * (CODEX_MODEL / CODEX_REASONING_EFFORT override them).
 */
export async function runCodex(prompt, schema, { timeoutMs = 300_000, label = "codex", log, model, reasoningEffort } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "closedloop-codex-"));
  const schemaPath = join(directory, "schema.json");
  const outputPath = join(directory, "response.json");
  saveJson(schemaPath, schema);
  const startedAt = Date.now();
  try {
    const args = ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "-C", directory,
      "--output-schema", schemaPath, "--output-last-message", outputPath];
    args.push("--model", model ?? process.env.CODEX_MODEL ?? "gpt-5.6-luna");
    args.push("--config", `model_reasoning_effort=${JSON.stringify(reasoningEffort ?? process.env.CODEX_REASONING_EFFORT ?? "none")}`);
    args.push("--config", 'model_verbosity="low"');
    args.push("-");
    await new Promise((resolvePromise, reject) => {
      const child = spawn(codexBin(), args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
      child.stdin.on("error", () => {});
      child.on("error", (error) => { clearTimeout(timeout); reject(error); });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolvePromise();
        else reject(new Error(timedOut ? `${label}: Codex timed out after ${Math.round(timeoutMs / 1000)}s` : `${label}: Codex exited ${code}: ${stderr}`));
      });
      child.stdin.end(prompt);
    });
    const result = readJson(outputPath);
    log?.(`${label}: Codex answered in ${Math.round((Date.now() - startedAt) / 1000)}s`);
    return result;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
