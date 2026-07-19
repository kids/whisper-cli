// =============================================================================
// Codex CLI runner — spawns `codex exec` with session management
// =============================================================================
// Codex uses persistent auth via `codex login` — no API key needed at runtime.
//
// Output format (--json JSONL):
//   {"type":"thread.started","thread_id":"<uuid>"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
//   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, CodexConfig } from "../types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap
const STALE_TIMEOUT_MS = 120 * 1000;    // 2 min no-output

// ---------------------------------------------------------------------------
// Session store (chat_id -> thread_id)
// ---------------------------------------------------------------------------

const threads = new Map<string, string>();

export function getCodexSession(chatId: string): string | undefined {
  return threads.get(chatId);
}

export function setCodexSession(chatId: string, tid: string): void {
  threads.set(chatId, tid);
}

export function clearCodexSession(chatId: string): void {
  threads.delete(chatId);
}

// ---------------------------------------------------------------------------
// Active run tracking (for /stop)
// ---------------------------------------------------------------------------

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

export function stopCodexRun(runKey: string): boolean {
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

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunCodexOptions {
  prompt: string;
  chatId: string;
  config: CodexConfig;
  workdir: string;
  codexBin: string;
  model?: string;
  onStreamUpdate?: (text: string) => void;
}

export function runCodex(opts: RunCodexOptions): Promise<AiResult> {
  const { prompt, chatId, workdir, codexBin } = opts;
  const threadId = threads.get(chatId);

  async function attempt(resume: boolean): Promise<AiResult | null> {
    const tid = resume ? threads.get(chatId) : undefined;

    let args: string[];
    if (tid) {
      // Resume existing thread with new prompt
      args = [
        "exec", "resume", tid,
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
      ];
      if (opts.model) args.push("-m", opts.model);
      args.push(prompt);
    } else {
      args = [
        "exec",
        "--json",
        "--dangerously-bypass-approvals-and-sandbox",
        "--dangerously-bypass-hook-trust",
        "--skip-git-repo-check",
      ];
      if (opts.model) args.push("-m", opts.model);
      if (workdir) args.push("-C", workdir);
      args.push(prompt);
    }

    console.log(`[codex] spawn chat=${chatId.slice(0, 8)} thread=${tid?.slice(0, 8) || "(new)"}`);

    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolveP) => {
        const child = spawn(codexBin, args, {
          env: { ...process.env },
          cwd: workdir,
          stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin?.end(); // codex reads stdin even with positional prompt — must close immediately

        const activeRun: ActiveRun = { child, cancelled: false };
        activeRuns.set(chatId, activeRun);
        const clearRun = () => {
          if (activeRuns.get(chatId) === activeRun) activeRuns.delete(chatId);
        };

        let out = "";
        let err = "";

        const hardTimer: NodeJS.Timeout | null = setTimeout(() => {
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
          clearTimeout(hardTimer!);
          if (staleTimer) clearTimeout(staleTimer);
          clearRun();
          resolveP({ stdout: "", stderr: `spawn error: ${e.message}` });
        });

        let lineBuf2 = "";
        let lastStreamText = "";
        child.stdout!.on("data", (d: Buffer | string) => {
          const chunk = d.toString();
          out += chunk;
          lineBuf2 += chunk;
          touch();
          // Emit stream updates for agent_message items
          let nl: number;
          while ((nl = lineBuf2.indexOf("\n")) >= 0) {
            const line = lineBuf2.slice(0, nl).trim();
            lineBuf2 = lineBuf2.slice(nl + 1);
            if (!line.startsWith("{")) continue;
            try {
              const ev = JSON.parse(line) as CodexEvent;
              if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
                const t = ev.item.text;
                if (t !== lastStreamText) {
                  lastStreamText = t;
                  opts.onStreamUpdate?.(t);
                }
              }
            } catch { /* skip */ }
          }
        });
        child.stderr!.on("data", (d: Buffer | string) => {
          err += d.toString();
          touch();
        });

        child.on("close", (_code: number | null) => {
          clearTimeout(hardTimer!);
          if (staleTimer) clearTimeout(staleTimer);

          // If cancelled by user, return partial
          if (activeRun.cancelled) {
            clearRun();
            resolveP({ stdout: out, stderr: err });
            return;
          }

          clearRun();
          resolveP({ stdout: out, stderr: err });
        });
      },
    );

    // Parse JSONL events
    const events: CodexEvent[] = [];
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch { /* skip partial lines */ }
    }

    if (events.length === 0) {
      if (tid) {
        console.warn(`[codex] thread ${tid} stale, clearing and retrying`);
        threads.delete(chatId);
        return null; // signal retry
      }
      return { text: `⚠️ No output from Codex.\n${stderr?.slice(0, 500) || ""}` };
    }

    // Extract thread_id
    let outThreadId: string | undefined;
    for (const ev of events) {
      if (ev.type === "thread.started" && ev.thread_id) {
        outThreadId = ev.thread_id;
        threads.set(chatId, outThreadId);
        break;
      }
    }

    // Extract usage from turn.completed
    let usage: AiResult["usage"];
    for (const ev of events) {
      if (ev.type === "turn.completed" && ev.usage) {
        const u = ev.usage;
        usage = {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: u.cached_input_tokens ?? undefined,
          cacheWriteTokens: undefined,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
        };
      }
    }

    // Extract assistant text from item.completed (agent_message)
    let resultText = "";
    for (const ev of events) {
      if (
        ev.type === "item.completed" &&
        ev.item?.type === "agent_message" &&
        ev.item.text
      ) {
        resultText = ev.item.text;
      }
    }

    if (!resultText) {
      return {
        text: "⚠️ Codex finished without a text response.",
        usage,
        sessionId: outThreadId,
      };
    }

    return {
      text: resultText,
      usage,
      sessionId: outThreadId,
    };
  }

  // Try with thread; if stale, retry once without it
  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[codex] retrying without thread for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
