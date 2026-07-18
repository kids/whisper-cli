// =============================================================================
// Cursor Agent CLI runner — spawns `agent` with session management
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, CursorConfig } from "../types";
import { findBinary } from "../config";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BIN = findBinary("agent", [
  `${process.env.HOME || "/root"}/.local/bin/agent`,
  "/opt/homebrew/bin/agent",
  "/usr/local/bin/agent",
]);
const STALL_TIMEOUT_MS = 45 * 60 * 1000; // 45 min no-output
const HARD_TIMEOUT_MS = 0;               // 0 = no limit

// ---------------------------------------------------------------------------
// Session store (chat_id -> session_id)
// ---------------------------------------------------------------------------

const sessions = new Map<string, string>();

export function getCursorSession(chatId: string): string | undefined {
  return sessions.get(chatId);
}

export function setCursorSession(chatId: string, sid: string): void {
  sessions.set(chatId, sid);
}

export function clearCursorSession(chatId: string): void {
  sessions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Active run tracking (for /stop)
// ---------------------------------------------------------------------------

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

export function stopCursorRun(runKey: string): boolean {
  const run = activeRuns.get(runKey);
  if (!run) return false;
  run.cancelled = true;
  try { run.child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { run.child.kill("SIGKILL"); } catch {} }, 5000);
  return true;
}

// ---------------------------------------------------------------------------
// Parse helpers
// ---------------------------------------------------------------------------

interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  text?: string;
  result?: string;
  error?: string;
  model?: string;
  usage?: Record<string, unknown>;
  message?: { content: Array<{ type: string; text?: string }> };
}

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

function normalizeUsage(u: Record<string, unknown> | undefined): AiResult["usage"] {
  if (!u || typeof u !== "object") return undefined;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = (u as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  const input = num("inputTokens", "input_tokens");
  const output = num("outputTokens", "output_tokens");
  const cacheRead = num("cacheReadTokens", "cache_read_tokens", "cache_read_input_tokens");
  const cacheWrite = num("cacheWriteTokens", "cache_write_tokens", "cache_creation_input_tokens");
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: input + output };
}

// ---------------------------------------------------------------------------
// Serial lock per session (prevent concurrent runs on same session)
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => { release = r; });
  locks.set(key, next);
  await prev;
  try { return await fn(); } finally { release(); }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunCursorOptions {
  prompt: string;
  chatId: string;
  config: CursorConfig;
  workspace: string;
  agentBin?: string;
  model?: string;
  onActivity?: (label: string) => void;
  onStreamUpdate?: (text: string) => void;
}

export function runCursor(opts: RunCursorOptions): Promise<AiResult> {
  const { prompt, chatId, config, workspace, onActivity } = opts;
  const bin = opts.agentBin || DEFAULT_BIN;
  const model = opts.model || "auto";
  const sessionId = sessions.get(chatId);

  const onStreamUpdate = opts.onStreamUpdate;
  const lockKey = sessionId ? `session:${sessionId}` : `chat:${chatId}`;

  return withLock(lockKey, () => {
    return new Promise((resolve) => {
      const args = [
        "-p", "--force", "--trust", "--approve-mcps",
        "--workspace", workspace,
        "--model", model,
        "--output-format", "stream-json",
      ];
      if (sessionId) args.push("--resume", sessionId);
      args.push("--", prompt);

      console.log(`[cursor] spawn chat=${chatId.slice(0, 8)} session=${sessionId?.slice(0, 8) || "(new)"}`);

      const child = spawn(bin, args, {
        env: { ...process.env, CURSOR_API_KEY: config.apiKey },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const activeRun: ActiveRun = { child, cancelled: false };
      activeRuns.set(chatId, activeRun);
      const clearRun = () => { if (activeRuns.get(chatId) === activeRun) activeRuns.delete(chatId); };

      let stderr = "";
      let resultText = "";
      let outSessionId: string | undefined;
      let outModel: string | undefined;
      let lastSegment = "";
      let lineBuf = "";
      let usage: AiResult["usage"];
      let settled = false;
      const startedAt = Date.now();
      let lastOutputAt = startedAt;

      const touch = () => { lastOutputAt = Date.now(); };

      const finish = (result: AiResult) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        clearRun();
        resolve({ ...result, model: result.model || outModel, sessionId: result.sessionId || outSessionId });
      };

      const watchdog = setInterval(() => {
        if (settled || child.exitCode != null) return;
        const now = Date.now();
        if (STALL_TIMEOUT_MS > 0 && now - lastOutputAt >= STALL_TIMEOUT_MS) {
          try { child.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
          finish({ text: `⚠️ Cursor Agent stopped responding after ${Math.round((now - lastOutputAt) / 60000)}min.` });
        }
        if (HARD_TIMEOUT_MS > 0 && now - startedAt >= HARD_TIMEOUT_MS) {
          try { child.kill("SIGTERM"); } catch {}
          setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 5000);
          finish({ text: `⚠️ Cursor Agent reached ${Math.round(HARD_TIMEOUT_MS / 60000)}min limit.` });
        }
      }, 60_000);

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let ev: StreamEvent;
        try { ev = JSON.parse(trimmed); } catch { return; }

        if (ev.session_id && !outSessionId) outSessionId = ev.session_id;
        if (ev.model && !outModel) outModel = ev.model;

        if (ev.type === "assistant" && ev.message?.content) {
          for (const c of ev.message.content) {
            if (c.type === "text" && c.text) {
              lastSegment += c.text;
              const snippet = stripAnsi(c.text).replace(/\s+/g, " ").trim().slice(-80);
              if (snippet) onActivity?.(`💭 ${snippet}`);
              if (lastSegment) onStreamUpdate?.(stripAnsi(lastSegment));
            }
          }
        }
        if (ev.type === "result" && ev.result != null) resultText = ev.result;
        if (ev.type === "result" && ev.subtype === "error" && ev.error) resultText = ev.error;
        if (ev.type === "result" && ev.usage) usage = normalizeUsage(ev.usage) ?? usage;
      };

      child.stdout!.on("data", (chunk: Buffer) => {
        touch();
        lineBuf += chunk.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop()!;
        for (const line of lines) processLine(line);
      });

      child.stderr!.on("data", (chunk: Buffer) => {
        touch();
        stderr += chunk.toString();
      });

      child.on("close", (code: number | null) => {
        if (lineBuf.trim()) processLine(lineBuf);

        if (activeRun.cancelled) {
          const partial = stripAnsi(lastSegment) || resultText || undefined;
          finish({ text: partial ? `⏹️ Stopped. Partial output:\n${partial}` : "⏹️ Stopped by user." });
          return;
        }

        const output = stripAnsi(lastSegment) || resultText || stripAnsi(stderr) || "(no output)";
        if (code !== 0 && code !== null && !resultText && !lastSegment) {
          finish({ text: `⚠️ Cursor Agent exited with code ${code}.\n${output}` });
          return;
        }

        finish({
          text: output,
          model: outModel,
          sessionId: outSessionId,
          usage,
        });
      });

      child.on("error", (err) => {
        finish({ text: `⚠️ Failed to spawn Cursor Agent: ${err.message}` });
      });
    });
  });
}
