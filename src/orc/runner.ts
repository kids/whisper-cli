// =============================================================================
// orc — Executor: one attempt = one adapter call (src/ai/*), chosen per role
// =============================================================================
// Bypasses AgentRunner.dispatchAi (which is bound to one CLI per bot group) so
// critic can run on a different CLI/model than the implementer (002 §4.2).
// =============================================================================
import type { AgentConfig } from "../types";
import type { GlobalConfig } from "../config";
import { runCodebuddy, setCodebuddySession, clearCodebuddySession, getCodebuddySession, stopCodebuddyRun } from "../ai/codebuddy";
import { runCodex, setCodexSession, clearCodexSession, getCodexSession, stopCodexRun } from "../ai/codex";
import { runClaude, setClaudeSession, clearClaudeSession, getClaudeSession, stopClaudeRun } from "../ai/claude";
import type { CliName } from "./types";

export interface RunRequest {
  cli: CliName;
  model?: string;
  prompt: string;
  sessionKey: string;
  /** Resume this CLI session; undefined = fresh */
  resumeSessionId?: string;
  cwd: string;
  appendSystemPrompt?: string;
  readOnly: boolean;
  disallowedTools?: string[];
  hardTimeoutMs: number;
  staleTimeoutMs: number;
  onProgress?: (line: string) => void;
  onText?: (text: string) => void;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  tokens: number;
  timedOut: boolean;
  cancelled: boolean;
  error?: string;
}

export interface Executor {
  available(): CliName[];
  run(req: RunRequest): Promise<RunResult>;
  stop(sessionKey: string, cli: CliName): boolean;
}

const WRITE_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

/** Map a raw stream event to a short progress line (tool calls / commands) */
export function eventToProgress(ev: any): string | undefined {
  const clip = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 140);
  if (ev?.type === "assistant" && Array.isArray(ev.message?.content)) {
    const tu = [...ev.message.content].reverse().find((c: any) => c?.type === "tool_use");
    if (tu) {
      const inp = tu.input ?? {};
      const arg = inp.command ?? inp.file_path ?? inp.path ?? inp.pattern ?? inp.url ?? inp.description ?? "";
      return clip(`${tu.name}${arg ? ": " + String(arg) : ""}`);
    }
  }
  if ((ev?.type === "item.started" || ev?.type === "item.completed") && ev.item?.type === "command_execution") {
    return clip(`shell: ${ev.item.command ?? ""}`);
  }
  if (ev?.type === "item.completed" && ev.item?.type === "file_change") return clip(`edit: ${JSON.stringify(ev.item.changes ?? "").slice(0, 120)}`);
  return undefined;
}

/** Adapters report failures in-band as text; classify them */
export function classifyResult(text: string): Pick<RunResult, "timedOut" | "cancelled" | "error"> {
  const t = (text || "").trimStart();
  if (t.startsWith("⏱️") || /timed out/i.test(t.slice(0, 80))) return { timedOut: true, cancelled: false, error: t.slice(0, 300) };
  if (t.startsWith("🛑")) return { timedOut: false, cancelled: true };
  if (t.startsWith("⚠️")) return { timedOut: false, cancelled: false, error: t.slice(0, 500) };
  return { timedOut: false, cancelled: false };
}

export class CliExecutor implements Executor {
  constructor(private agents: AgentConfig[], private bins: GlobalConfig) {}

  private cfg<K extends "codebuddy" | "claude" | "codex">(k: K): AgentConfig[K] | undefined {
    return this.agents.find((a) => a[k])?.[k];
  }

  available(): CliName[] {
    const out: CliName[] = [];
    if (this.cfg("codebuddy")) out.push("codebuddy");
    if (this.bins.codexBin) out.push("codex");
    if (this.bins.claudeBin) out.push("claude");
    return out;
  }

  stop(sessionKey: string, cli: CliName): boolean {
    if (cli === "codebuddy") return stopCodebuddyRun(sessionKey);
    if (cli === "codex") return stopCodexRun(sessionKey);
    if (cli === "claude") return stopClaudeRun(sessionKey);
    return false;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const key = req.sessionKey;
    const onEvent = (ev: any) => { const p = eventToProgress(ev); if (p) req.onProgress?.(p); };
    const onStreamUpdate = (t: string) => req.onText?.(t);
    let res;
    if (req.cli === "codebuddy") {
      const config = this.cfg("codebuddy");
      if (!config) throw new Error("codebuddy is not configured (no AGENT_<N>_CODEBUDDY_API_KEY)");
      if (req.resumeSessionId) setCodebuddySession(key, req.resumeSessionId); else clearCodebuddySession(key);
      res = await runCodebuddy({
        prompt: req.prompt, chatId: key, config, workdir: req.cwd, codebuddyBin: this.bins.codebuddyBin,
        model: req.model, onStreamUpdate, onEvent, appendSystemPrompt: req.appendSystemPrompt,
        disallowedTools: req.readOnly ? [...WRITE_TOOLS, ...(req.disallowedTools ?? [])] : req.disallowedTools,
        hardTimeoutMs: req.hardTimeoutMs, staleTimeoutMs: req.staleTimeoutMs,
      });
      res.sessionId ||= getCodebuddySession(key);
    } else if (req.cli === "codex") {
      if (req.resumeSessionId) setCodexSession(key, req.resumeSessionId); else clearCodexSession(key);
      res = await runCodex({
        prompt: req.prompt, chatId: key, config: this.cfg("codex") ?? {}, workdir: req.cwd, codexBin: this.bins.codexBin,
        model: req.model, onStreamUpdate, onEvent, appendSystemPrompt: req.appendSystemPrompt,
        readOnly: req.readOnly, hardTimeoutMs: req.hardTimeoutMs, staleTimeoutMs: req.staleTimeoutMs,
      });
      res.sessionId ||= getCodexSession(key);
    } else if (req.cli === "claude") {
      if (req.resumeSessionId) setClaudeSession(key, req.resumeSessionId); else clearClaudeSession(key);
      res = await runClaude({
        prompt: req.prompt, chatId: key, config: this.cfg("claude") ?? {}, workspace: req.cwd, claudeBin: this.bins.claudeBin,
        model: req.model, onStreamUpdate, appendSystemPrompt: req.appendSystemPrompt,
        disallowedTools: req.readOnly ? [...WRITE_TOOLS, ...(req.disallowedTools ?? [])] : req.disallowedTools,
      });
      res.sessionId ||= getClaudeSession(key);
    } else {
      throw new Error(`orc executor: cli "${req.cli}" not supported yet`);
    }
    return { text: res.text, sessionId: res.sessionId, tokens: res.usage?.totalTokens ?? 0, ...classifyResult(res.text) };
  }
}
