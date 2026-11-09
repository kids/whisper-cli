// =============================================================================
// Recent turns per chat — a short, clipped transcript shared across modes
// =============================================================================
// The orc lead agent runs stateless (fresh session per message) and reads this
// instead, so "把刚才这个交给团队做" works right after single-agent turns
// (docs/orc/002 §2.4). Kept small on purpose: it is context, not memory.
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_TURNS = 10;
export const MAX_TURN_CHARS = 800;

export interface Turn {
  who: "user" | "agent" | "lead";
  text: string;
  at: number;
}

const path = () => process.env.RECENT_TURNS_PATH || resolve(import.meta.dirname, "../state/recent-turns.json");
let data: Record<string, Turn[]> | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

function load(): Record<string, Turn[]> {
  if (data) return data;
  try { data = existsSync(path()) ? JSON.parse(readFileSync(path(), "utf8")) : {}; } catch { data = {}; }
  return data!;
}

export function flushRecent(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!data) return;
  mkdirSync(resolve(path(), ".."), { recursive: true });
  writeFileSync(path() + ".tmp", JSON.stringify(data));
  renameSync(path() + ".tmp", path());
}

function clip(s: string): string {
  const t = (s || "").trim();
  return t.length <= MAX_TURN_CHARS ? t : t.slice(0, MAX_TURN_CHARS) + "…";
}

export function recordTurn(chatId: string, who: Turn["who"], text: string): void {
  if (!text?.trim()) return;
  const d = load();
  d[chatId] = [...(d[chatId] ?? []), { who, text: clip(text), at: Date.now() }].slice(-MAX_TURNS);
  if (!timer) timer = setTimeout(flushRecent, 2000);
}

export function recentTurns(chatId: string, n = MAX_TURNS): Turn[] {
  return (load()[chatId] ?? []).slice(-n);
}

/** Transcript block for a prompt, oldest first; undefined when empty */
export function formatRecent(chatId: string, n = 6): string | undefined {
  const ts = recentTurns(chatId, n);
  if (!ts.length) return undefined;
  const label = { user: "用户", agent: "单 agent", lead: "主 agent" };
  return ts.map((t) => `[${label[t.who]}] ${t.text}`).join("\n");
}
