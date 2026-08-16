// =============================================================================
// Claude Code CLI runner — spawns `claude -p` with session management
// =============================================================================
// Auth: `claude login` (Claude.ai 订阅，推荐) or optional ANTHROPIC_API_KEY.
//
// Headless:
//   claude -p PROMPT --output-format stream-json --verbose
//          --dangerously-skip-permissions --include-partial-messages
//          [--resume SESSION] [--model ID] [--add-dir DIR]
//
// Stream JSON (NDJSON):
//   {"type":"system","subtype":"init","session_id":"...","model":"..."}
//   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
//   {"type":"result","result":"...","session_id":"...","usage":{...}}
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, ClaudeConfig } from "../types";
import { findBinary } from "../config";
import {
  collectFilesFromText,
  collectImagesFromText,
  HARD_TIMEOUT_MS,
  normalizeUsage,
  STALL_TIMEOUT_MS,
  stripAnsi,
} from "./helpers";

const DEFAULT_BIN = findBinary("claude", [
  `${process.env.HOME || "/root"}/.local/bin/claude`,
  `${process.env.HOME || "/root"}/.claude/local/claude`,
  "/opt/homebrew/bin/claude",
  "/usr/local/bin/claude",
]);

const sessions = new Map<string, string>();

export function getClaudeSession(chatId: string): string | undefined {
  return sessions.get(chatId);
}
export function setClaudeSession(chatId: string, sid: string): void {
  sessions.set(chatId, sid);
}
export function clearClaudeSession(chatId: string): void {
  sessions.delete(chatId);
}

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

export function stopClaudeRun(runKey: string): boolean {
  const run = activeRuns.get(runKey);
  if (!run) return false;
  run.cancelled = true;
  try { run.child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { run.child.kill("SIGKILL"); } catch {} }, 5000);
  return true;
}

/** Common Claude Code model aliases for `/model`. Full IDs (claude-*) also accepted. */
export const CLAUDE_MODEL_ALIASES = [
  "sonnet",
  "opus",
  "haiku",
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-haiku-4-5",
];

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  result?: string;
  is_error?: boolean;
  error?: string;
  usage?: Record<string, unknown>;
  message?: { content?: Array<{ type?: string; text?: string }> | string };
  event?: { type?: string; delta?: { type?: string; text?: string } };
}

function assistantTextOf(ev: StreamEvent): string {
  const content = ev.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

export interface RunClaudeOptions {
  prompt: string;
  chatId: string;
  config: ClaudeConfig;
  workspace: string;
  addDirs?: string[];
  claudeBin?: string;
  model?: string;
  onStreamUpdate?: (text: string) => void;
}

export function runClaude(opts: RunClaudeOptions): Promise<AiResult> {
  const { prompt, chatId, config, workspace } = opts;
  const bin = opts.claudeBin || DEFAULT_BIN;
  const addDirs = [...new Set((opts.addDirs || []).filter(Boolean))];

  async function attempt(resume: boolean): Promise<AiResult | null> {
    const sid = resume ? sessions.get(chatId) : undefined;
    const args = [
      "-p", prompt,
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--include-partial-messages",
    ];
    if (sid) args.push("--resume", sid);
    if (opts.model) args.push("--model", opts.model);
    for (const dir of addDirs) args.push("--add-dir", dir);

    console.log(`[claude] spawn chat=${chatId.slice(0, 8)} session=${sid?.slice(0, 8) || "(new)"}`);

    const env = { ...process.env };
    if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;

    return new Promise<AiResult | null>((resolve) => {
      const child = spawn(bin, args, {
        cwd: workspace,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const activeRun: ActiveRun = { child, cancelled: false };
      activeRuns.set(chatId, activeRun);
      const clearRun = () => { if (activeRuns.get(chatId) === activeRun) activeRuns.delete(chatId); };

      let stderr = "";
      let resultText = "";
      let lastSegment = "";
      let streamBuf = "";
      let lineBuf = "";
      let outSessionId: string | undefined;
      let outModel: string | undefined;
      let usage: AiResult["usage"];
      let settled = false;
      const images: AiResult["images"] = [];
      const files: NonNullable<AiResult["files"]> = [];
      const seenPaths = new Set<string>();
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      let timedOut = false;

      const finish = (result: AiResult) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        clearRun();
        if (result.sessionId) sessions.set(chatId, result.sessionId);
        resolve({
          ...result,
          model: result.model || outModel,
          sessionId: result.sessionId || outSessionId,
          images: result.images ?? images,
          files: result.files ?? files,
        });
      };

      const watchdog = setInterval(() => {
        if (settled || child.exitCode != null) return;
        const now = Date.now();
        if (STALL_TIMEOUT_MS > 0 && now - lastOutputAt >= STALL_TIMEOUT_MS) {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
        }
        if (HARD_TIMEOUT_MS > 0 && now - startedAt >= HARD_TIMEOUT_MS) {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
        }
      }, 60_000);

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let ev: StreamEvent;
        try { ev = JSON.parse(trimmed); } catch { return; }

        if (ev.session_id && !outSessionId) outSessionId = ev.session_id;
        if (ev.model && !outModel) outModel = ev.model;

        if (ev.type === "system" && ev.subtype === "init") {
          if (ev.session_id) outSessionId = ev.session_id;
          if (ev.model) outModel = ev.model;
        }

        if (ev.type === "stream_event") {
          const delta = ev.event?.delta;
          if (delta?.type === "text_delta" && delta.text) {
            streamBuf += delta.text;
            opts.onStreamUpdate?.(stripAnsi(streamBuf));
          }
        }

        if (ev.type === "assistant") {
          const t = assistantTextOf(ev);
          if (t) {
            lastSegment = lastSegment ? `${lastSegment}\n${t}` : t;
            streamBuf = lastSegment;
            opts.onStreamUpdate?.(stripAnsi(lastSegment));
          }
        }

        if (ev.type === "result") {
          if (typeof ev.result === "string" && ev.result) resultText = ev.result;
          if (ev.is_error && ev.error) resultText = String(ev.error);
          if (ev.usage) usage = normalizeUsage(ev.usage) ?? usage;
          if (ev.session_id) outSessionId = ev.session_id;
          if (ev.model) outModel = ev.model;
        }
      };

      child.stdout!.on("data", (chunk: Buffer) => {
        lastOutputAt = Date.now();
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop()!;
        for (const line of lines) processLine(line);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        lastOutputAt = Date.now();
        stderr += chunk.toString();
      });

      child.on("close", (code: number | null) => {
        if (lineBuf.trim()) processLine(lineBuf);

        if (activeRun.cancelled) {
          const partial = stripAnsi(streamBuf || lastSegment) || resultText;
          finish({
            text: partial ? `⏹️ Stopped. Partial output:\n${partial}` : "⏹️ Stopped by user.",
            sessionId: outSessionId,
            model: outModel,
            usage,
          });
          return;
        }

        const output = stripAnsi(resultText || lastSegment || streamBuf);
        if (!output) {
          if (timedOut) {
            finish({
              text: `⚠️ Claude Code timed out.\n${stripAnsi(stderr).slice(0, 500)}`,
              sessionId: outSessionId,
              model: outModel,
              usage,
            });
            return;
          }
          if (sid) {
            console.warn(`[claude] session ${sid} stale, retrying`);
            sessions.delete(chatId);
            settled = true;
            clearInterval(watchdog);
            clearRun();
            resolve(null);
            return;
          }
          finish({
            text: `⚠️ No output from Claude Code.\n${stripAnsi(stderr).slice(0, 500) || (code != null ? `exit ${code}` : "")}`,
          });
          return;
        }

        for (const img of collectImagesFromText(output, seenPaths)) images!.push(img);
        for (const f of collectFilesFromText(output, seenPaths)) files.push(f);
        if (outSessionId) sessions.set(chatId, outSessionId);
        finish({ text: output, model: outModel, sessionId: outSessionId, usage, images, files });
      });

      child.on("error", (err) => {
        finish({ text: `⚠️ Failed to spawn Claude Code: ${err.message}` });
      });
    });
  }

  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[claude] retrying without session for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
