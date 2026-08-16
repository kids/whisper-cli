// =============================================================================
// Gemini CLI runner — spawns `gemini -p` with session management
// =============================================================================
// Auth: `gemini` OAuth login (推荐) or optional GEMINI_API_KEY / GOOGLE_API_KEY.
//
// Headless:
//   gemini --prompt PROMPT --output-format stream-json
//          --approval-mode yolo --skip-trust
//          [-r SESSION] [-m MODEL] [--include-directories DIR]
//
// Stream JSON (NDJSON):
//   {"type":"init","session_id":"...","model":"..."}
//   {"type":"message","role":"assistant","content":"...","delta":true}
//   {"type":"result","status":"success","stats":{...}}
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, GeminiConfig } from "../types";
import { findBinary } from "../config";
import {
  collectFilesFromText,
  collectImagesFromText,
  HARD_TIMEOUT_MS,
  normalizeUsage,
  STALL_TIMEOUT_MS,
  stripAnsi,
} from "./helpers";

const DEFAULT_BIN = findBinary("gemini", [
  `${process.env.HOME || "/root"}/.local/bin/gemini`,
  "/opt/homebrew/bin/gemini",
  "/usr/local/bin/gemini",
  `${process.env.HOME || "/root"}/.npm-global/bin/gemini`,
]);

const sessions = new Map<string, string>();

export function getGeminiSession(chatId: string): string | undefined {
  return sessions.get(chatId);
}
export function setGeminiSession(chatId: string, sid: string): void {
  sessions.set(chatId, sid);
}
export function clearGeminiSession(chatId: string): void {
  sessions.delete(chatId);
}

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
}
const activeRuns = new Map<string, ActiveRun>();

export function stopGeminiRun(runKey: string): boolean {
  const run = activeRuns.get(runKey);
  if (!run) return false;
  run.cancelled = true;
  try { run.child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { run.child.kill("SIGKILL"); } catch {} }, 5000);
  return true;
}

/** Gemini CLI model aliases for `/model`. Concrete model names also accepted. */
export const GEMINI_MODEL_ALIASES = ["auto", "pro", "flash", "flash-lite"];

interface StreamEvent {
  type: string;
  session_id?: string;
  model?: string;
  role?: string;
  content?: string;
  delta?: boolean;
  status?: string;
  message?: string;
  stats?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

export interface RunGeminiOptions {
  prompt: string;
  chatId: string;
  config: GeminiConfig;
  workspace: string;
  addDirs?: string[];
  geminiBin?: string;
  model?: string;
  onStreamUpdate?: (text: string) => void;
}

export function runGemini(opts: RunGeminiOptions): Promise<AiResult> {
  const { prompt, chatId, config, workspace } = opts;
  const bin = opts.geminiBin || DEFAULT_BIN;
  const addDirs = [...new Set((opts.addDirs || []).filter(Boolean))];

  async function attempt(resume: boolean): Promise<AiResult | null> {
    const sid = resume ? sessions.get(chatId) : undefined;
    const args = [
      "--prompt", prompt,
      "--output-format", "stream-json",
      "--approval-mode", "yolo",
      "--skip-trust",
    ];
    if (sid) args.push("--resume", sid);
    if (opts.model) args.push("--model", opts.model);
    for (const dir of addDirs) args.push("--include-directories", dir);

    console.log(`[gemini] spawn chat=${chatId.slice(0, 8)} session=${sid?.slice(0, 8) || "(new)"}`);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    };
    if (config.apiKey) {
      env.GEMINI_API_KEY = config.apiKey;
      env.GOOGLE_API_KEY = config.apiKey;
    }

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
      let assistantText = "";
      let lineBuf = "";
      let outSessionId: string | undefined;
      let outModel: string | undefined;
      let usage: AiResult["usage"];
      let resultError = "";
      let settled = false;
      const images: NonNullable<AiResult["images"]> = [];
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

        if (ev.type === "init") {
          if (ev.session_id) outSessionId = ev.session_id;
          if (ev.model) outModel = ev.model;
        }

        if (ev.type === "message" && ev.role === "assistant" && typeof ev.content === "string") {
          if (ev.delta) assistantText += ev.content;
          else assistantText = ev.content;
          opts.onStreamUpdate?.(stripAnsi(assistantText));
        }

        if (ev.type === "result") {
          if (ev.session_id) outSessionId = ev.session_id;
          if (ev.model) outModel = ev.model;
          if (ev.stats) usage = normalizeUsage(ev.stats) ?? usage;
          if (ev.status === "error") {
            resultError = ev.error?.message || ev.message || "Gemini CLI returned an error.";
          }
        }

        if (ev.type === "error" && ev.message) {
          if (!assistantText) resultError = ev.message;
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
          const partial = stripAnsi(assistantText);
          finish({
            text: partial ? `⏹️ Stopped. Partial output:\n${partial}` : "⏹️ Stopped by user.",
            sessionId: outSessionId,
            model: outModel,
            usage,
          });
          return;
        }

        const output = stripAnsi(assistantText);
        if (!output) {
          if (timedOut) {
            finish({
              text: `⚠️ Gemini CLI timed out.\n${stripAnsi(stderr).slice(0, 500)}`,
              sessionId: outSessionId,
              model: outModel,
              usage,
            });
            return;
          }
          if (sid) {
            console.warn(`[gemini] session ${sid} stale, retrying`);
            sessions.delete(chatId);
            settled = true;
            clearInterval(watchdog);
            clearRun();
            resolve(null);
            return;
          }
          finish({
            text: `⚠️ ${resultError || "No output from Gemini CLI."}\n${stripAnsi(stderr).slice(0, 500) || (code != null ? `exit ${code}` : "")}`,
          });
          return;
        }

        for (const img of collectImagesFromText(output, seenPaths)) images.push(img);
        for (const f of collectFilesFromText(output, seenPaths)) files.push(f);
        if (outSessionId) sessions.set(chatId, outSessionId);
        finish({
          text: resultError ? `${output}\n\n⚠️ ${resultError}` : output,
          model: outModel,
          sessionId: outSessionId,
          usage,
          images,
          files,
        });
      });

      child.on("error", (err) => {
        finish({ text: `⚠️ Failed to spawn Gemini CLI: ${err.message}` });
      });
    });
  }

  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[gemini] retrying without session for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
