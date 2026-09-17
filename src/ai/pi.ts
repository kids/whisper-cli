// =============================================================================
// Pi runner — spawns `pi -p --mode json` with session management
// =============================================================================
// Pi uses persistent auth via `pi login` (e.g. ChatGPT Plus/Pro Codex OAuth) —
// no API key needed at runtime, same as codex. Verify readiness with:
//   pi auth check --provider openai-codex --json   # => {"status":"ready",...}
//
// Output format (`--mode json`, JSONL):
//   {"type":"session","id":"<uuid>","cwd":"..."}
//   {"type":"agent_start"} ... {"type":"agent_settled"}
//   {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"..."}}
//   {"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"..."}],
//      "model":"gpt-5.5","usage":{"input":...,"output":...,"cacheRead":...,"cacheWrite":...,"totalTokens":...}}}
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, PiConfig } from "../types";
import { findBinary } from "../config";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BIN = findBinary("pi", [
  `${process.env.HOME || "/root"}/.local/bin/pi`,
  "/opt/homebrew/bin/pi",
  "/usr/local/bin/pi",
  "/usr/bin/pi",
]);
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap
const STALE_TIMEOUT_MS = Number(process.env.PI_STALE_MS || 10 * 60 * 1000); // 10 min no-output
const DEFAULT_PROVIDER = "openai-codex"; // ChatGPT Plus/Pro (Codex) OAuth

// ---------------------------------------------------------------------------
// Session store (chat_id -> session_id)
// ---------------------------------------------------------------------------

const sessions = new Map<string, string>();

export function getPiSession(chatId: string): string | undefined {
  return sessions.get(chatId);
}

export function setPiSession(chatId: string, sid: string): void {
  sessions.set(chatId, sid);
}

export function clearPiSession(chatId: string): void {
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

export function stopPiRun(runKey: string): boolean {
  const run = activeRuns.get(runKey);
  if (!run) return false;
  run.cancelled = true;
  try { run.child.kill("SIGTERM"); } catch { /* already dead */ }
  setTimeout(() => { try { run.child.kill("SIGKILL"); } catch {} }, 5000);
  return true;
}

// ---------------------------------------------------------------------------
// JSONL event types
// ---------------------------------------------------------------------------

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
}

interface PiMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  usage?: PiUsage;
}

interface PiEvent {
  type: string;
  id?: string;
  message?: PiMessage;
  assistantMessageEvent?: { type?: string; delta?: string };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunPiOptions {
  prompt: string;
  chatId: string;
  config: PiConfig;
  workdir: string;
  piBin?: string;
  model?: string;
  onStreamUpdate?: (text: string) => void;
}

export function runPi(opts: RunPiOptions): Promise<AiResult> {
  const { prompt, chatId, workdir } = opts;
  const bin = opts.piBin || DEFAULT_BIN;
  const provider = opts.config.provider || DEFAULT_PROVIDER;

  async function attempt(resume: boolean): Promise<AiResult | null> {
    const sid = resume ? sessions.get(chatId) : undefined;

    const args = ["-p", "--mode", "json", "--provider", provider];
    if (opts.model) args.push("--model", opts.model);
    if (sid) args.push("--session", sid);
    args.push(prompt);

    console.log(`[pi] spawn chat=${chatId.slice(0, 8)} session=${sid?.slice(0, 8) || "(new)"}`);

    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolveP) => {
        const child = spawn(bin, args, {
          env: { ...process.env },
          cwd: workdir,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin?.end(); // prompt passed positionally — close stdin to avoid hang

        const activeRun: ActiveRun = { child, cancelled: false };
        activeRuns.set(chatId, activeRun);
        const clearRun = () => {
          if (activeRuns.get(chatId) === activeRun) activeRuns.delete(chatId);
        };

        let out = "";
        let err = "";
        let streamBuf = "";

        const hardTimer: NodeJS.Timeout = setTimeout(() => {
          child.kill("SIGKILL");
          clearRun();
          resolveP({ stdout: out, stderr: err + "\n[HARD TIMEOUT]" });
        }, HARD_TIMEOUT_MS);

        let staleTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
          child.kill("SIGKILL");
          clearRun();
          resolveP({ stdout: out, stderr: err + "\n[STALE TIMEOUT]" });
        }, STALE_TIMEOUT_MS);

        const touch = () => {
          if (staleTimer) {
            clearTimeout(staleTimer);
            staleTimer = setTimeout(() => {
              child.kill("SIGKILL");
              clearRun();
              resolveP({ stdout: out, stderr: err + "\n[STALE TIMEOUT]" });
            }, STALE_TIMEOUT_MS);
          }
        };

        child.on("error", (e: Error) => {
          clearTimeout(hardTimer);
          if (staleTimer) clearTimeout(staleTimer);
          clearRun();
          resolveP({ stdout: "", stderr: `spawn error: ${e.message}` });
        });

        // Stream text deltas to the caller (for the Feishu streaming card)
        let lineBuf = "";
        child.stdout!.on("data", (d: Buffer | string) => {
          const chunk = d.toString();
          out += chunk;
          lineBuf += chunk;
          touch();
          let nl: number;
          while ((nl = lineBuf.indexOf("\n")) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line.startsWith("{")) continue;
            try {
              const ev = JSON.parse(line) as PiEvent;
              if (ev.type === "message_update") {
                const e = ev.assistantMessageEvent;
                if (e?.type === "text_delta" && e.delta) {
                  streamBuf += e.delta;
                  opts.onStreamUpdate?.(streamBuf);
                }
              }
            } catch { /* skip */ }
          }
        });

        child.stderr!.on("data", (d: Buffer | string) => {
          err += d.toString();
          touch();
        });

        child.on("close", () => {
          clearTimeout(hardTimer);
          if (staleTimer) clearTimeout(staleTimer);
          clearRun();
          resolveP({ stdout: out, stderr: err });
        });
      },
    );

    // Parse JSONL events
    const events: PiEvent[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch { /* skip partial lines */ }
    }

    if (events.length === 0) {
      if (sid) {
        console.warn(`[pi] session ${sid.slice(0, 8)} stale, clearing and retrying`);
        sessions.delete(chatId);
        return null; // signal retry
      }
      return { text: `⚠️ No output from Pi.\n${stderr?.slice(0, 500) || ""}` };
    }

    // Extract session id from the first "session" event
    let outSessionId: string | undefined;
    for (const ev of events) {
      if (ev.type === "session" && ev.id) {
        outSessionId = ev.id;
        sessions.set(chatId, outSessionId);
        break;
      }
    }

    // Extract final assistant text + usage + model (last assistant message wins)
    let resultText = "";
    let usage: AiResult["usage"];
    let outModel: string | undefined;
    for (const ev of events) {
      if (ev.type !== "message_end" || ev.message?.role !== "assistant") continue;
      const m = ev.message;
      if (m.model) outModel = m.model;
      const text = (m.content || [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
      if (text) resultText = text;
      if (m.usage) {
        usage = {
          inputTokens: m.usage.input ?? 0,
          outputTokens: m.usage.output ?? 0,
          cacheReadTokens: m.usage.cacheRead ?? undefined,
          cacheWriteTokens: m.usage.cacheWrite ?? undefined,
          totalTokens: m.usage.totalTokens ?? (m.usage.input ?? 0) + (m.usage.output ?? 0),
        };
      }
    }

    if (!resultText) {
      return {
        text: "⚠️ Pi finished without a text response.",
        usage,
        sessionId: outSessionId,
      };
    }

    return {
      text: resultText,
      usage,
      model: outModel,
      sessionId: outSessionId,
    };
  }

  // Try with existing session; if stale, retry once without it
  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[pi] retrying without session for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
