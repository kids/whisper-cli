// =============================================================================
// Cursor Agent CLI runner — spawns `agent` with session management
// =============================================================================
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { AgentFile, AgentImage, AiResult, CursorConfig } from "../types";
import { findBinary } from "../config";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BIN = findBinary("agent", [
  `${process.env.HOME || "/root"}/.local/bin/agent`,
  "/opt/homebrew/bin/agent",
  "/usr/local/bin/agent",
]);
const STALL_TIMEOUT_MS = Number(process.env.AGENT_STALL_MS || 45 * 60 * 1000);
const HARD_TIMEOUT_MS = Number(process.env.AGENT_MAX_MS || 0);

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
  tool_call?: Record<string, unknown>;
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

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const IMG_PATH_RE = /(?:^|[\s`'"(])(\/[^\s`'"]+\.(?:png|jpe?g|gif|webp|bmp))(?:[\s`'")]|$)/gi;
const FILE_PATH_RE = /(?:^|[\s`'"(])(\/[^\s`'"]+\.[\w.-]+)(?:[\s`'")]|$)/gi;

function isRegularFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function extractGenerateImage(ev: StreamEvent): AgentImage | undefined {
  if (ev.type !== "tool_call" || ev.subtype !== "completed" || !ev.tool_call) return undefined;
  const gen = ev.tool_call.generateImageToolCall as Record<string, unknown> | undefined;
  const success = (gen?.result as Record<string, unknown> | undefined)?.success as
    | Record<string, unknown>
    | undefined;
  if (!success) return undefined;
  const img: AgentImage = {};
  if (typeof success.filePath === "string") img.filePath = success.filePath;
  if (typeof success.imageData === "string") img.imageData = success.imageData;
  return img.filePath || img.imageData ? img : undefined;
}

function collectImagesFromText(text: string, seenPaths: Set<string>): AgentImage[] {
  const out: AgentImage[] = [];
  for (const m of text.matchAll(IMG_PATH_RE)) {
    const p = m[1];
    if (seenPaths.has(p) || !isRegularFile(p)) continue;
    seenPaths.add(p);
    out.push({ filePath: p });
  }
  return out;
}

function collectFilesFromText(text: string, seenPaths: Set<string>): AgentFile[] {
  const out: AgentFile[] = [];
  for (const m of text.matchAll(FILE_PATH_RE)) {
    const p = m[1];
    if (seenPaths.has(p) || IMG_EXT.test(p) || !isRegularFile(p)) continue;
    seenPaths.add(p);
    out.push({ filePath: p, fileName: basename(p) });
  }
  return out;
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
      const images: AgentImage[] = [];
      const files: AgentFile[] = [];
      const seenPaths = new Set<string>();
      const startedAt = Date.now();
      let lastOutputAt = startedAt;

      const touch = () => { lastOutputAt = Date.now(); };

      const pushImage = (img: AgentImage) => {
        if (img.filePath) {
          if (seenPaths.has(img.filePath)) return;
          seenPaths.add(img.filePath);
        }
        images.push(img);
      };

      const finish = (result: AiResult) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        clearRun();
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

        const genImg = extractGenerateImage(ev);
        if (genImg) pushImage(genImg);
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

        for (const img of collectImagesFromText(output, seenPaths)) pushImage(img);
        for (const f of collectFilesFromText(output, seenPaths)) files.push(f);

        finish({
          text: output,
          model: outModel,
          sessionId: outSessionId,
          usage,
          images,
          files,
        });
      });

      child.on("error", (err) => {
        finish({ text: `⚠️ Failed to spawn Cursor Agent: ${err.message}` });
      });
    });
  });
}
