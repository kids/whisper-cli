// =============================================================================
// DeepSeek Harness (dsh) headless runner — `dsh --profile headless --json`
// =============================================================================
// Install: npm i -g @deepseek-ai/dsh   (Node >=24.9, see package engines)
// Auth:    DEEPSEEK_API_KEY (per group) or ~/.dsh/.credentials.yaml / ~/.dsh/.env
//
//   dsh --profile headless --json --permission-mode danger-full-access --approval-policy never
//   dsh --profile headless --json --session-id <id>  # resume
//
// NDJSON on stdout: session → status/text/thinking/tool_call/tool_result → final
// (`status` / `step_end` carries token usage; an `error` event replaces `final`
// when the runner itself fails). Exit 0 = turn completed; 1 = aborted / error.
//
// Two headless-specific constraints:
//   • there is no `--model` flag — the model comes from the profile's
//     `agent-default-model` (cordis.patch.yml), so whisper's `/model` does not apply;
//   • `--session-id` is only accepted for a session recorded in the *same cwd*,
//     so switching a chat's workspace invalidates it (we retry once, fresh).
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, DshConfig } from "../types";
import { findBinary } from "../config";
import { normalizeUsage, stripAnsi } from "./helpers";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BIN = findBinary("dsh", [
  `${process.env.HOME || "/root"}/.local/bin/dsh`,
  `${process.env.HOME || "/root"}/.npm-global/bin/dsh`,
  "/opt/homebrew/bin/dsh",
  "/usr/local/bin/dsh",
]);
const DEFAULT_PROFILE = "headless";
// dsh writes no heartbeat before the first token; reasoning lands on stderr.
const STALL_TIMEOUT_MS = Number(process.env.DSH_STALE_MS || 15 * 60 * 1000);
const HARD_TIMEOUT_MS = Number(process.env.DSH_MAX_MS || 60 * 60 * 1000);

// ---------------------------------------------------------------------------
// Session store (chat_id -> session_id)
// ---------------------------------------------------------------------------

const sessions = new Map<string, string>();

export function getDshSession(chatId: string): string | undefined {
  return sessions.get(chatId);
}

export function setDshSession(chatId: string, sid: string): void {
  sessions.set(chatId, sid);
}

export function clearDshSession(chatId: string): void {
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

export function stopDshRun(runKey: string): boolean {
  const run = activeRuns.get(runKey);
  if (!run) return false;
  run.cancelled = true;
  const pid = run.child.pid;
  try {
    if (pid) process.kill(-pid, "SIGTERM");
    else run.child.kill("SIGTERM");
  } catch {
    try { run.child.kill("SIGTERM"); } catch { /* already dead */ }
  }
  setTimeout(() => {
    try {
      if (pid) process.kill(-pid, "SIGKILL");
      else run.child.kill("SIGKILL");
    } catch { /* already dead */ }
  }, 5000);
  return true;
}

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

interface StreamEvent {
  type?: string;
  /** identity of this run: session-<uuid> (field name differs across 0.1.x) */
  sessionId?: string;
  session_id?: string;
  id?: string;
  session?: string | { id?: string };
  text?: string;
  delta?: string;
  content?: string;
  answer?: string;
  final?: string;
  message?: string | { text?: string };
  error?: string;
  reason?: string | { kind?: string };
  /** present on status / step_end events */
  usage?: Record<string, unknown>;
  /** tool_call / tool_result */
  tool?: string;
  input?: Record<string, unknown>;
}

const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

/** One human-readable progress line for a tool call / reasoning step */
function activityOf(ev: StreamEvent): string | undefined {
  if (ev.type === "tool_call" && typeof ev.tool === "string") {
    const inp = ev.input ?? {};
    const arg = inp.command ?? inp.path ?? inp.pattern ?? inp.description ?? inp.url ?? inp.query ?? "";
    return `🔧 ${ev.tool}${arg ? ": " + clip(String(arg), 110) : ""}`;
  }
  if (ev.type === "thinking") {
    const t = str(ev.text);
    return t ? `💭 ${clip(t, 110)}` : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function sessionIdOf(ev: StreamEvent): string | undefined {
  if (typeof ev.session === "string") return str(ev.session);
  return str(ev.sessionId) ?? str(ev.session_id) ?? str(ev.id) ?? str(ev.session?.id);
}

/** `text` events project one committed assistant message (not a token delta). */
function textOf(ev: StreamEvent): string | undefined {
  return str(ev.text) ?? str(ev.delta) ?? str(ev.content);
}

/** `final` is the one lossless payload in the stream. */
function finalOf(ev: StreamEvent): string | undefined {
  return str(ev.text) ?? str(ev.answer) ?? str(ev.final)
    ?? (typeof ev.message === "string" ? str(ev.message) : str(ev.message?.text));
}

function errorOf(ev: StreamEvent): string | undefined {
  const msg = typeof ev.message === "string" ? ev.message : ev.message?.text;
  const reason = typeof ev.reason === "string" ? ev.reason : undefined;
  return str(ev.error) ?? str(msg) ?? str(reason);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunDshOptions {
  prompt: string;
  chatId: string;
  config: DshConfig;
  workspace: string;
  dshBin?: string;
  /** dsh profile; defaults to "headless" (AGENT_<N>_DSH_PROFILE) */
  profile?: string;
  /** Extra workspace roots (`--add-dir`); readable beyond the primary workspace */
  addDirs?: string[];
  /** `read-only` permission preset (orc readonly roles) */
  readOnly?: boolean;
  onStreamUpdate?: (text: string) => void;
  /** Raw NDJSON events, for orc progress */
  onEvent?: (ev: any) => void;
  /** Override DSH_MAX_MS / DSH_STALE_MS for this run (0 = off) */
  hardTimeoutMs?: number;
  staleTimeoutMs?: number;
}

export function runDsh(opts: RunDshOptions): Promise<AiResult> {
  const { prompt, chatId, config, workspace } = opts;
  const bin = opts.dshBin || DEFAULT_BIN;
  const profile = opts.profile || config.profile || DEFAULT_PROFILE;
  const stallMs = opts.staleTimeoutMs ?? STALL_TIMEOUT_MS;
  const hardMs = opts.hardTimeoutMs ?? HARD_TIMEOUT_MS;

  async function attempt(resume: boolean): Promise<AiResult | null> {
    const sid = resume ? sessions.get(chatId) : undefined;
    const addDirs = [...new Set((opts.addDirs || []).filter(Boolean))];
    // No TTY: approval prompts could only stall, so the policy is always "never".
    // Read-only roles get the read-only preset. Write roles get danger-full-access:
    // they must run git add/commit and arbitrary build/test commands in the repo.
    // That is the same trust level as cursor's --force / codebuddy's
    // bypassPermissions / claude's --dangerously-skip-permissions.
    const args = [
      "--profile", profile, "--json",
      "--permission-mode", opts.readOnly ? "read-only" : "danger-full-access",
      "--approval-policy", "never",
    ];
    for (const dir of addDirs) args.push("--add-dir", dir);
    if (sid) args.push("--session-id", sid);

    console.log(`[dsh] spawn chat=${chatId.slice(0, 8)} session=${sid || "(new)"}`);

    const env = { ...process.env };
    if (config.apiKey) env.DEEPSEEK_API_KEY = config.apiKey;
    // 第三方 Anthropic-Messages 兼容端点（TokenHub 等）：dsh 的 llm-deepseek 读它
    if (config.baseUrl) env.DEEPSEEK_BASE_URL = config.baseUrl;
    // headless 无 --model，profile 补丁用 DSH_MODEL 覆盖 agentDefaultModel
    if (config.model) env.DSH_MODEL = config.model;

    const result = await new Promise<AiResult | null>((resolve) => {
      const child = spawn(bin, args, {
        cwd: workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group, so /stop also reaps the worker the launcher spawns.
        detached: true,
      });

      const activeRun: ActiveRun = { child, cancelled: false };
      activeRuns.set(chatId, activeRun);
      const clearRun = () => { if (activeRuns.get(chatId) === activeRun) activeRuns.delete(chatId); };
      const killChild = (sig: NodeJS.Signals = "SIGTERM") => {
        try { process.kill(-child.pid!, sig); } catch {
          try { child.kill(sig); } catch { /* already dead */ }
        }
      };

      let stderr = "";
      let resultText = "";
      let lastText = "";
      let errText = "";
      /** transient progress lines (tool calls / reasoning) shown on the streaming card */
      const activity: string[] = [];
      const ACTIVITY_MAX = 6;
      const showActivity = () => opts.onStreamUpdate?.([...activity, stripAnsi(lastText)].filter(Boolean).join("\n\n"));
      let lineBuf = "";
      let outSessionId: string | undefined;
      let usage: AiResult["usage"];
      let settled = false;
      const startedAt = Date.now();
      let lastOutputAt = startedAt;
      let timedOut = false;
      const STDERR_CAP = 64 * 1024;

      // Task goes over stdin: dsh reads it from there and argv has length limits.
      child.stdin?.on("error", () => { /* dsh may exit before reading */ });
      try { child.stdin?.end(prompt); } catch { /* dsh already gone */ }

      const finish = (r: AiResult) => {
        if (settled) return;
        settled = true;
        clearInterval(watchdog);
        clearRun();
        if (r.sessionId) sessions.set(chatId, r.sessionId);
        resolve({ ...r, usage: r.usage ?? usage, sessionId: r.sessionId || outSessionId });
      };

      const watchdog = setInterval(() => {
        if (settled || child.exitCode != null) return;
        const now = Date.now();
        if (stallMs > 0 && now - lastOutputAt >= stallMs) {
          timedOut = true;
          killChild("SIGTERM");
          setTimeout(() => killChild("SIGKILL"), 5000);
        }
        if (hardMs > 0 && now - startedAt >= hardMs) {
          timedOut = true;
          killChild("SIGTERM");
          setTimeout(() => killChild("SIGKILL"), 5000);
        }
      }, 60_000);

      const processLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) return;
        let ev: StreamEvent;
        try { ev = JSON.parse(trimmed); } catch { return; }
        try { opts.onEvent?.(ev); } catch { /* observer must not break the run */ }

        const sidSeen = sessionIdOf(ev);
        if (sidSeen && !outSessionId) outSessionId = sidSeen;
        // status / step_end carry the per-step usage (camelCase keys); sum the steps
        const stepUsage = normalizeUsage(ev.usage);
        if (stepUsage) {
          usage = usage
            ? {
                inputTokens: usage.inputTokens + stepUsage.inputTokens,
                outputTokens: usage.outputTokens + stepUsage.outputTokens,
                cacheReadTokens: (usage.cacheReadTokens || 0) + (stepUsage.cacheReadTokens || 0),
                cacheWriteTokens: (usage.cacheWriteTokens || 0) + (stepUsage.cacheWriteTokens || 0),
                totalTokens: usage.totalTokens + stepUsage.totalTokens,
              }
            : stepUsage;
        }

        switch (ev.type) {
          case "session":
            if (sidSeen) outSessionId = sidSeen;
            break;
          case "text": {
            const t = textOf(ev);
            if (t) {
              lastText = t;
              showActivity();
            }
            break;
          }
          case "tool_call":
          case "thinking": {
            // Visible progress: a long lead/agent turn otherwise shows nothing
            // until a committed assistant message arrives.
            const line = activityOf(ev);
            if (line) {
              activity.push(line);
              if (activity.length > ACTIVITY_MAX) activity.splice(0, activity.length - ACTIVITY_MAX);
              showActivity();
            }
            break;
          }
          case "final": {
            const t = finalOf(ev);
            if (t) resultText = t;
            break;
          }
          case "error":
            errText = errorOf(ev) || errText;
            break;
          default:
            break;
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
        if (stderr.length > STDERR_CAP) stderr = stderr.slice(-STDERR_CAP);
      });

      child.on("close", (code: number | null) => {
        console.log(
          `[dsh] exit chat=${chatId.slice(0, 8)} code=${code} dur=${Math.round((Date.now() - startedAt) / 1000)}s session=${outSessionId || sid || "(none)"}`,
        );
        if (lineBuf.trim()) processLine(lineBuf);

        if (activeRun.cancelled) {
          const partial = stripAnsi(resultText || lastText);
          finish({ text: partial ? `⏹️ Stopped. Partial output:\n${partial}` : "⏹️ Stopped by user." });
          return;
        }

        const output = stripAnsi(resultText || lastText);

        // A stale --session-id fails before the turn (unknown id / other cwd /
        // other preset), so drop it and run once from scratch.
        if (!output && sid) {
          console.warn(`[dsh] session ${sid} unusable, retrying fresh`);
          sessions.delete(chatId);
          settled = true;
          clearInterval(watchdog);
          clearRun();
          resolve(null);
          return;
        }

        if (!output) {
          const diag = stripAnsi(errText || stderr).slice(0, 500);
          const why = timedOut
            ? "timed out"
            : code === 0
              ? "finished without an answer"
              : `exited with code ${code}`;
          finish({ text: `⚠️ dsh ${why}.${diag ? `\n${diag}` : ""}` });
          return;
        }

        // Exit 1 can still carry a final answer (aborted mid-turn); surface it
        // with the reason attached instead of discarding it.
        // In --json mode stderr carries only `dsh:` diagnostics (reasoning is an event).
        const reason = stripAnsi(errText || stderr).slice(0, 200);
        const suffix = code === 0 ? "" : `\n\n⚠️ dsh exited with code ${code}${reason ? `: ${reason}` : ""}`;
        finish({ text: output + suffix, sessionId: outSessionId });
      });

      child.on("error", (err) => {
        const hint = (err as NodeJS.ErrnoException).code === "ENOENT"
          ? "\nInstall it with `npm i -g @deepseek-ai/dsh` (Node >=24.9)."
          : "";
        finish({ text: `⚠️ Failed to spawn dsh: ${err.message}${hint}` });
      });
    });

    return result;
  }

  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[dsh] retrying without session for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
