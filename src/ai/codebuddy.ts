// =============================================================================
// CodeBuddy CLI runner — spawns `codebuddy -p` with session management
// =============================================================================
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
const HARD_TIMEOUT_MS = 30 * 60 * 1000;
const STALE_TIMEOUT_MS = 120 * 1000;
const DEBUG_DIR = resolve(import.meta.dirname, "../../debug");

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
// Active run tracking (for /stop)
// ---------------------------------------------------------------------------

interface ActiveRun {
  child: ReturnType<typeof spawn>;
  cancelled: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

export function stopCodebuddyRun(runKey: string): boolean {
  const run = activeRuns.get(runKey);
  if (!run) return false;
  run.cancelled = true;
  try { run.child.kill("SIGTERM"); } catch {}
  setTimeout(() => { try { run.child.kill("SIGKILL"); } catch {} }, 5000);
  return true;
}

// ---------------------------------------------------------------------------
// Model listing
// ---------------------------------------------------------------------------

const modelCache = new Map<string, string[]>();

/** Query installed CodeBuddy CLI for supported model list */
export function queryCodebuddyModels(bin: string): string[] {
  const cached = modelCache.get(bin);
  if (cached) return cached;
  const ids = ["default-model"];
  try {
    const out = execSync(`"${bin}" --help`, { encoding: "utf8", timeout: 10000 });
    const m = out.match(/Currently supported:\s*\(([^)]+)\)/);
    if (m) ids.push(...m[1].split(",").map((s) => s.trim()).filter(Boolean));
  } catch (e) {
    console.error(`[codebuddy/models] failed: ${e}`);
  }
  modelCache.set(bin, ids);
  return ids;
}

// ---------------------------------------------------------------------------
// Debug dump
// ---------------------------------------------------------------------------

function dumpDebug(label: string, data: string): string | null {
  try {
    if (!existsSync(DEBUG_DIR)) mkdirSync(DEBUG_DIR);
    const fpath = resolve(DEBUG_DIR, `codebuddy-${label}-${Date.now()}.txt`);
    writeFileSync(fpath, data, "utf8");
    return fpath;
  } catch (e) {
    console.error("[codebuddy/dump] failed:", e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Raw transcript detection
// ---------------------------------------------------------------------------

function looksLikeRawTranscript(s: string): boolean {
  if (!s || s.length < 100) return false;
  const trimmed = s.trimStart();
  if (!trimmed.startsWith("[")) return false;
  const has = (sub: string) => trimmed.includes(sub);
  return (
    (has('"type":"message"') || has('"type": "message"')) &&
    (has('"timestamp"') || has('"timestamp": ')) &&
    (has('"role"') || has('"role": '))
  );
}

// ---------------------------------------------------------------------------
// Truncated JSON recovery
// ---------------------------------------------------------------------------

function tryRecoverItems(s: string): any[] | null {
  const items: any[] = [];
  let i = 0, n = s.length;
  while (i < n && /\s/.test(s[i])) i++;
  if (i >= n || s[i] !== "[") return null;
  i++; // consume '['
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (i >= n) break;
    if (s[i] === "]") break;
    if (s[i] !== "{") break;
    const start = i;
    let depth = 0, inStr = false, esc = false;
    while (i < n) {
      const ch = s[i];
      if (esc) { esc = false; i++; continue; }
      if (inStr) {
        if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        i++; continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try { items.push(JSON.parse(s.slice(start, i + 1))); } catch {}
          i++; break;
        }
      }
      i++;
    }
    if (depth > 0) break;
  }
  return items.length > 0 ? items : null;
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
  model?: string;
  onStreamUpdate?: (text: string) => void;
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
    if (opts.model) args.push("--model", opts.model);

    console.log(`[codebuddy] spawn chat=${chatId.slice(0, 8)} session=${sid?.slice(0, 8) || "(new)"} model=${opts.model || "default"}`);

    const { stdout, stderr, wasCancelled } = await new Promise<{
      stdout: string; stderr: string; wasCancelled: boolean;
    }>((resolveP) => {
      const child = spawn(bin, args, {
        cwd: workdir,
        env: {
          ...process.env,
          CODEBUDDY_API_KEY: config.apiKey,
          CODEBUDDY_INTERNET_ENVIRONMENT: config.internetEnvironment || "ioa",
          CODEBUDDY_GIT_REPO_SCAN_DISABLED: "1",
        },
      });

      const activeRun: ActiveRun = { child, cancelled: false };
      activeRuns.set(chatId, activeRun);
      const clearRun = () => {
        if (activeRuns.get(chatId) === activeRun) activeRuns.delete(chatId);
      };

      let out = "", err = "";
      let lastAssistantText = "";
      let lineBuf = "";

      let hardTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
        clearRun();
        child.kill("SIGKILL");
        resolveP({ stdout: out, stderr: err + "\n[HARD TIMEOUT]", wasCancelled: false });
      }, HARD_TIMEOUT_MS);

      let staleTimer: ReturnType<typeof setTimeout> | null = null;
      const resetStale = () => {
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = setTimeout(() => {
          clearRun();
          child.kill("SIGKILL");
          resolveP({ stdout: out, stderr: err + "\n[STALE TIMEOUT]", wasCancelled: false });
        }, STALE_TIMEOUT_MS);
      };

      child.on("error", (e: Error) => {
        clearTimeout(hardTimer!);
        if (staleTimer) clearTimeout(staleTimer);
        clearRun();
        resolveP({ stdout: "", stderr: `spawn error: ${e.message}`, wasCancelled: false });
      });

      child.stdout!.on("data", (d: Buffer | string) => {
        out += d.toString();
        lineBuf += d.toString();
        resetStale();

        // Process complete NDJSON lines for streaming
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, nl).trim();
          lineBuf = lineBuf.slice(nl + 1);
          if (!line.startsWith("{")) continue;
          try {
            const ev = JSON.parse(line) as any;
            // Extract assistant text for streaming
            if (ev.type === "assistant" && ev.message?.content) {
              const content = ev.message.content;
              let text = "";
              if (Array.isArray(content)) {
                const texts = content
                  .filter((c: any) => c.type === "text" && typeof c.text === "string")
                  .map((c: any) => c.text);
                if (texts.length) text = texts.join("\n");
              } else if (typeof content === "string") {
                text = content;
              }
              if (text && text !== lastAssistantText) {
                lastAssistantText = text;
                opts.onStreamUpdate?.(text);
              }
            }
          } catch { /* skip partial */ }
        }
      });

      child.stderr!.on("data", (d: Buffer | string) => {
        err += d.toString();
        resetStale();
      });

      child.on("close", (_code: number | null) => {
        clearTimeout(hardTimer!);
        if (staleTimer) clearTimeout(staleTimer);
        const wasCancelled = activeRun.cancelled;
        clearRun();
        if (wasCancelled) {
          resolveP({ stdout: out, stderr: err, wasCancelled: true });
          return;
        }
        if (lineBuf.trim()) {
          // Flush partial last line — it was already added to stdout buffer
        }
        resolveP({ stdout: out, stderr: err, wasCancelled: false });
      });
    });

    if (wasCancelled) {
      return { text: "🛑 任务已被用户终止。" };
    }

    if (!stdout.trim()) {
      if (sid) {
        console.warn(`[codebuddy] session ${sid} stale, retrying`);
        sessions.delete(chatId);
        return null;
      }
      return { text: `⚠️ No output.\n${stderr?.slice(0, 500) || ""}` };
    }

    // Parse NDJSON first, then legacy, then truncated recovery
    const items: any[] = [];
    for (const line of stdout.split("\n")) {
      const s = line.trim();
      if (!s.startsWith("{")) continue;
      try { items.push(JSON.parse(s)); } catch {}
    }
    if (!items.length) {
      // Legacy JSON array
      try {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed)) items.push(...parsed);
        else items.push(parsed);
      } catch {
        // Truncated recovery
        const recovered = tryRecoverItems(stdout);
        if (recovered) items.push(...recovered);
        else {
          // Check if it looks like raw transcript
          if (looksLikeRawTranscript(stdout)) {
            dumpDebug("raw-transcript", stdout);
            return { text: "⚠️ Raw transcript — please /reset and retry." };
          }
          dumpDebug("unparseable", stdout);
          return { text: `⚠️ Could not parse output.\n${stderr?.slice(0, 500) || ""}` };
        }
      }
    }

    // Track session
    for (const item of items) {
      const newSid = item.session_id || item.sessionId;
      if (newSid) { sessions.set(chatId, newSid); break; }
    }

    // Extract model & accumulate usage from ALL assistant events (like cb-feishu)
    let model: string | undefined;
    let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
    let resultText = "";
    let resultItem: any = null;

    for (const item of items) {
      if (item?.type === "system" && item?.subtype === "init" && item?.model && !model) {
        model = item.model;
      }
      if (item?.type === "result") {
        resultItem = item;
        if (item.model && !model) model = item.model;
        if (typeof item.result === "string" && item.result) resultText = item.result;
      }
      if (item?.type === "assistant" && item?.message?.usage) {
        const u = item.message.usage;
        inputTokens += u.input_tokens || 0;
        outputTokens += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheWrite += u.cache_creation_input_tokens || 0;
      }
    }

    const usage = {
      inputTokens,
      outputTokens,
      cacheReadTokens: cacheRead || undefined,
      cacheWriteTokens: cacheWrite || undefined,
      totalTokens: inputTokens + outputTokens,
    };

    // Result text
    if (resultItem) {
      if (resultItem.is_error) {
        return { text: `⚠️ ${String(resultItem.result ?? "").slice(0, 4000)}`, model, usage };
      }
      if (resultText && resultText.length > 0) {
        return { text: resultText, model, usage, sessionId: sessions.get(chatId) };
      }
    }

    // Fallback to last assistant message
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it || it.role !== "assistant") continue;
      const content = it.content;
      if (typeof content === "string" && content.trim()) {
        return { text: content.trim(), model, usage, sessionId: sessions.get(chatId) };
      }
      if (Array.isArray(content)) {
        const texts = content
          .filter((c: any) => c?.type === "text" && c?.text?.trim())
          .map((c: any) => c.text);
        if (texts.length) return { text: texts.join("\n"), model, usage, sessionId: sessions.get(chatId) };
      }
    }

    if (resultText) return { text: resultText, model, usage, sessionId: sessions.get(chatId) };
    return { text: "⚠️ No usable result.", model, usage };
  }

  return attempt(true).then((result) => {
    if (result !== null) return result;
    console.log(`[codebuddy] retrying without session for chat=${chatId.slice(0, 8)}`);
    return attempt(false).then((r) => r!);
  });
}
