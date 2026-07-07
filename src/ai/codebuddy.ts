// =============================================================================
// CodeBuddy CLI runner — spawns `codebuddy -p` with session management
// =============================================================================
import { spawn } from "node:child_process";
import type { AiResult, CodeBuddyConfig } from "../types";
import { findBinary } from "../config";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_BIN = findBinary("codebuddy", [
  "/opt/homebrew/bin/codebuddy",
  "/usr/local/bin/codebuddy",
  "/home/linuxbrew/.linuxbrew/bin/codebuddy",
  `${process.env.HOME || "/root"}/.local/bin/codebuddy`,
  "/usr/bin/codebuddy",
]);
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap
const STALE_TIMEOUT_MS = 120 * 1000;     // 2 min no-output

// ---------------------------------------------------------------------------
// Session store (chat_id -> session_id)
// ---------------------------------------------------------------------------

const sessions = new Map<string, string>();

export function getCodebuddySession(chatId: string): string | undefined {
  return sessions.get(chatId);
}

export function setCodebuddySession(chatId: string, sid: string): void {
  sessions.set(chatId, sid);
}

export function clearCodebuddySession(chatId: string): void {
  sessions.delete(chatId);
}

// ---------------------------------------------------------------------------
// Parse output
// ---------------------------------------------------------------------------

interface CodebuddyItem {
  type?: string;
  subtype?: string;
  text?: string;
  content?: Array<{ type: string; text?: string }>;
  result?: string;
  error?: string;
  is_error?: boolean;
  model?: string;
  usage?: Record<string, number | null | undefined>;
  session_id?: string;
  sessionId?: string;
  role?: string;
  message?: { role?: string; content?: Array<{ type: string; text?: string }> };
}

function parseItems(out: string): CodebuddyItem[] {
  // Prefer JSONL: one object per line
  const lineItems: CodebuddyItem[] = [];
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    try {
      lineItems.push(JSON.parse(s));
    } catch { /* skip partial */ }
  }
  if (lineItems.length) return lineItems;

  // Legacy: single JSON array
  try {
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) return parsed.flat(Infinity) as CodebuddyItem[];
    return [parsed];
  } catch { /* fall through */ }

  // Balanced top-level array
  const firstBracket = out.indexOf("[");
  if (firstBracket !== -1) {
    let depth = 0, inStr = false, esc = false;
    for (let i = firstBracket; i < out.length; i++) {
      const c = out[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          try { return (JSON.parse(out.slice(firstBracket, i + 1)) as any[]).flat(Infinity) as CodebuddyItem[]; }
          catch { break; }
        }
      }
    }
  }
  return [];
}

function findResult(items: CodebuddyItem[]): CodebuddyItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.type === "result") return items[i];
  }
  return null;
}

function extractFallbackText(items: CodebuddyItem[]): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it || typeof it !== "object") continue;
    const role = it.role || it.message?.role;
    if (role && role !== "assistant") continue;
    if (it.type && it.type !== "message" && it.type !== "assistant") continue;
    for (const c of it.content ?? it.message?.content ?? []) {
      if (c.type === "output_text" || c.type === "text" || c.text) {
        if (c.text?.trim()) return c.text.trim();
      }
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunCodebuddyOptions {
  prompt: string;
  chatId: string;
  config: CodeBuddyConfig;
  workdir: string;
  codebuddyBin?: string;
  resumeSession?: boolean;
}

export function runCodebuddy(opts: RunCodebuddyOptions): Promise<AiResult> {
  const { prompt, chatId, config, workdir } = opts;
  const bin = opts.codebuddyBin || DEFAULT_BIN;
  const sessionId = opts.resumeSession !== false ? sessions.get(chatId) : undefined;

  async function attempt(resume: boolean): Promise<AiResult | null> {
    const sid = resume ? sessions.get(chatId) : undefined;
    const args = [
      "-p", prompt,
      "--permission-mode", "bypassPermissions",
      "--output-format", "stream-json",
    ];
    if (sid) args.push("-r", sid);

    console.log(`[codebuddy] spawn chat=${chatId.slice(0, 8)} session=${sid?.slice(0, 8) || "(new)"}`);

    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolveP) => {
      const child = spawn(bin, args, {
        cwd: workdir,
        env: {
          ...process.env,
          CODEBUDDY_API_KEY: config.apiKey,
          CODEBUDDY_INTERNET_ENVIRONMENT: config.internetEnvironment || "ioa",
          CODEBUDDY_GIT_REPO_SCAN_DISABLED: "1",
        },
      });

      let out = "", err = "";

      let hardTimer: NodeJS.Timeout | null = setTimeout(() => {
        child.kill("SIGKILL");
        resolveP({ stdout: out, stderr: err + "\n[HARD TIMEOUT]" });
      }, HARD_TIMEOUT_MS);

      let staleTimer: NodeJS.Timeout | null = setTimeout(() => {
        child.kill("SIGKILL");
        resolveP({ stdout: out, stderr: err + "\n[STALE TIMEOUT]" });
      }, STALE_TIMEOUT_MS);

      child.on("error", (e: Error) => {
        clearTimeout(hardTimer!); clearTimeout(staleTimer!);
        resolveP({ stdout: "", stderr: `spawn error: ${e.message}` });
      });

      child.stdout!.on("data", (d: Buffer | string) => {
        out += d.toString();
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
      });
      child.stderr!.on("data", (d: Buffer | string) => {
        err += d.toString();
        if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
      });

      child.on("close", (code: number | null) => {
        clearTimeout(hardTimer!);
        if (staleTimer) clearTimeout(staleTimer);
        resolveP({ stdout: out, stderr: err });
      });
    });

    if (!stdout.trim()) {
      if (sid) {
        console.warn(`[codebuddy] session ${sid} stale, clearing and retrying`);
        sessions.delete(chatId);
        return null; // signal retry
      }
      return { text: `⚠️ No output from CodeBuddy.\n${stderr?.slice(0, 500) || ""}` };
    }

    // Parse
    const items = parseItems(stdout);
    if (!items.length) {
      return { text: `⚠️ Could not parse CodeBuddy output.\n${stderr?.slice(0, 500) || ""}` };
    }

    // Track session
    for (const item of items) {
      const newSid = item.session_id || item.sessionId;
      if (newSid) { sessions.set(chatId, newSid); break; }
    }

    // Extract model & usage
    let model: string | undefined;
    let usage: AiResult["usage"];
    const resultItem = findResult(items);
    if (resultItem?.model) model = resultItem.model;
    if (!model) {
      for (const item of items) {
        if (item?.type === "system" && item?.subtype === "init" && item.model) {
          model = item.model; break;
        }
      }
    }
    const u = resultItem?.usage;
    if (u) {
      usage = {
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? u.prompt_cache_hit_tokens ?? undefined,
        cacheWriteTokens: u.cache_creation_input_tokens ?? u.prompt_cache_write_tokens ?? undefined,
        totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      };
    }

    // Extract result
    if (resultItem) {
      if (resultItem.is_error) {
        return { text: `⚠️ ${resultItem.result ?? resultItem.error ?? "unknown error"}`, model, usage };
      }
      const text = resultItem.result ?? resultItem.text;
      if (typeof text === "string" && text.length) {
        return { text, model, usage, sessionId: sessions.get(chatId) };
      }
    }

    const fallback = extractFallbackText(items);
    if (fallback) return { text: fallback, model, usage, sessionId: sessions.get(chatId) };

    return { text: "⚠️ CodeBuddy finished without a final answer.", model, usage };
  }

  // Try with session; if session is dead, retry once without it
  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[codebuddy] retrying without session for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
