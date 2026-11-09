// =============================================================================
// Per-chat memory — long-lived facts/preferences scoped to one group
// =============================================================================
// Why not CodeBuddy's Auto Memory: it is keyed by cwd, so chats sharing a repo
// leak into each other, orc worktrees fragment it, and other CLIs never see it.
// This store is keyed by chatId, injected every turn next to the announcement,
// and CLI-agnostic.
//
// Write paths:
//   - commands: /记住 <text>, /记忆 [forget <n…> | clear]
//   - single-agent replies: a line `[[remember]] …` / `[[forget]] 3,5` (stripped
//     from the reply, applied by code)
//   - orc lead agent: `remember` / `forget` actions
// orc workers only read it (they never write group memory).
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const MAX_ITEMS = 60;
export const MAX_ITEM_CHARS = 300;
export const MAX_INJECT_CHARS = 2500;

export interface MemoryItem {
  id: number;
  text: string;
  /** who wrote it: a command, the single agent, or the orc lead */
  source: "user" | "agent" | "lead";
  createdAt: number;
}

interface ChatMemory {
  nextId: number;
  items: MemoryItem[];
}

function dir(): string {
  return process.env.CHAT_MEMORY_DIR || resolve(import.meta.dirname, "../state/chat-memory");
}

function fileOf(chatId: string): string {
  return resolve(dir(), `${chatId.replace(/[^\w.-]/g, "_")}.json`);
}

const cache = new Map<string, ChatMemory>();

function load(chatId: string): ChatMemory {
  const hit = cache.get(chatId);
  if (hit) return hit;
  let m: ChatMemory = { nextId: 1, items: [] };
  try {
    const f = fileOf(chatId);
    if (existsSync(f)) m = JSON.parse(readFileSync(f, "utf8"));
  } catch { /* corrupt → start empty, file is rewritten on next change */ }
  cache.set(chatId, m);
  return m;
}

function save(chatId: string, m: ChatMemory): void {
  mkdirSync(dir(), { recursive: true });
  const f = fileOf(chatId);
  writeFileSync(f + ".tmp", JSON.stringify(m, null, 2));
  renameSync(f + ".tmp", f);
  cache.set(chatId, m);
}

/** Chat id of a session key like "<chatId>#lead" / "<chatId>#role:x" */
export function chatOf(key: string): string {
  return key.split("#")[0];
}

export function listMemory(chatId: string): MemoryItem[] {
  return [...load(chatId).items];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Add one item; exact duplicates are not re-added. Oldest items drop past MAX_ITEMS. */
export function addMemory(chatId: string, text: string, source: MemoryItem["source"]): MemoryItem | undefined {
  const t = norm(text).slice(0, MAX_ITEM_CHARS);
  if (!t) return undefined;
  const m = load(chatId);
  const dup = m.items.find((i) => norm(i.text) === t);
  if (dup) return dup;
  const item: MemoryItem = { id: m.nextId++, text: t, source, createdAt: Date.now() };
  const items = [...m.items, item].slice(-MAX_ITEMS);
  save(chatId, { nextId: m.nextId, items });
  return item;
}

/** Remove by id; returns the ids actually removed */
export function forgetMemory(chatId: string, ids: number[]): number[] {
  const m = load(chatId);
  const want = new Set(ids);
  const gone = m.items.filter((i) => want.has(i.id)).map((i) => i.id);
  if (gone.length) save(chatId, { nextId: m.nextId, items: m.items.filter((i) => !want.has(i.id)) });
  return gone;
}

export function clearMemory(chatId: string): number {
  const m = load(chatId);
  const n = m.items.length;
  if (n) save(chatId, { nextId: m.nextId, items: [] });
  return n;
}

const WRITE_HINT =
  "如果用户明确要求记住某件本群长期适用的事（偏好、约定、事实），或要求忘掉某条，在回复末尾单独一行输出 " +
  "`[[remember]] 一句话` 或 `[[forget]] 编号`，代码会写入/删除（这一行不会展示给用户）。" +
  "只记长期有效、可复用的信息，不要记一次性的任务细节、密码或密钥。";

/**
 * Text to inject for this chat (newest kept when over budget).
 * `writable`: append the [[remember]] protocol (single agent only).
 */
export function formatMemory(chatId: string, opts: { writable?: boolean } = {}): string | undefined {
  const items = load(chatId).items;
  if (!items.length && !opts.writable) return undefined;
  const lines: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const line = `[${items[i].id}] ${items[i].text}`;
    if (used + line.length + 1 > MAX_INJECT_CHARS) break;
    lines.unshift(line);
    used += line.length + 1;
  }
  const dropped = items.length - lines.length;
  const head = "【本群记忆】以下是本群积累的长期信息，作为背景参考（与用户当轮要求冲突时以用户为准）：";
  const body = lines.length ? lines.join("\n") : "（暂无）";
  return [head, body, dropped > 0 ? `…（另有 ${dropped} 条较早的记忆未展示）` : "", opts.writable ? WRITE_HINT : ""]
    .filter(Boolean).join("\n");
}

/** Group announcement + chat memory → one block for --append-system-prompt / prompt prefix */
export function joinInstructions(...parts: (string | undefined)[]): string | undefined {
  const ps = parts.filter((p): p is string => !!p && !!p.trim());
  return ps.length ? ps.join("\n\n---\n\n") : undefined;
}

export interface MemoryOps {
  text: string;
  remember: string[];
  forget: number[];
}

const REMEMBER_RE = /^[ \t>*-]*`?\[\[remember\]\]\s*(.+?)`?\s*$/gim;
const FORGET_RE = /^[ \t>*-]*`?\[\[forget\]\]\s*([#\d,，\s]+?)`?\s*$/gim;

/** Pull `[[remember]]` / `[[forget]]` lines out of an agent reply */
export function extractMemoryOps(text: string): MemoryOps {
  const remember: string[] = [];
  const forget: number[] = [];
  let out = (text || "").replace(REMEMBER_RE, (_, t: string) => { remember.push(t.trim()); return ""; });
  out = out.replace(FORGET_RE, (_, ids: string) => {
    for (const s of ids.split(/[#,，\s]+/)) if (/^\d+$/.test(s)) forget.push(Number(s));
    return "";
  });
  if (remember.length || forget.length) out = out.replace(/\n{3,}/g, "\n\n").trimEnd();
  return { text: out, remember, forget };
}

/** Apply ops from an agent reply; returns a short footer for the reply ("" if nothing changed) */
export function applyMemoryOps(chatId: string, ops: MemoryOps, source: MemoryItem["source"]): string {
  const added = ops.remember.map((t) => addMemory(chatId, t, source)).filter((x): x is MemoryItem => !!x);
  const gone = ops.forget.length ? forgetMemory(chatId, ops.forget) : [];
  const parts: string[] = [];
  if (added.length) parts.push(`📌 已记入本群记忆：${added.map((i) => `[${i.id}] ${i.text}`).join("；")}`);
  if (gone.length) parts.push(`🗑 已忘记：${gone.map((i) => `[${i}]`).join(" ")}`);
  return parts.length ? parts.join("\n") + "\n（`/记忆` 查看，`/记忆 forget <编号>` 删除）" : "";
}

/**
 * /记住 <text> | /remember <text>
 * /记忆 | /memory  [forget|忘记 <n…> | clear|清空]
 * Returns the reply markdown, or undefined if the text is not a memory command.
 */
export function memoryCommand(chatId: string, text: string): string | undefined {
  const t = text.trim();
  let m = t.match(/^\/(记住|remember)\s+([\s\S]+)$/i);
  if (m) {
    const it = addMemory(chatId, m[2], "user");
    return it ? `📌 已记入本群记忆 [${it.id}] ${it.text}` : "内容为空，没有记录。";
  }
  m = t.match(/^\/(记忆|memory|mem)(?:\s+([\s\S]*))?$/i);
  if (!m) return undefined;
  const arg = (m[2] || "").trim();
  if (!arg) {
    const items = listMemory(chatId);
    return items.length
      ? [`**本群记忆（${items.length} 条）**`, ...items.map((i) => `[${i.id}] ${i.text}`), "",
         "`/记住 <内容>` 新增；`/记忆 forget <编号…>` 删除；`/记忆 clear` 清空。也可以直接对 agent 说「记住…」「忘掉第 N 条」。"].join("\n")
      : "本群还没有记忆。`/记住 <内容>` 新增，或直接对 agent 说「记住…」。";
  }
  const f = arg.match(/^(forget|忘记|删除|rm)\s+([#\d,，\s]+)$/i);
  if (f) {
    const ids = f[2].split(/[#,，\s]+/).filter((s) => /^\d+$/.test(s)).map(Number);
    const gone = forgetMemory(chatId, ids);
    return gone.length ? `🗑 已忘记 ${gone.map((i) => `[${i}]`).join(" ")}` : "没有找到这些编号。";
  }
  if (/^(clear|清空)$/i.test(arg)) return `已清空本群记忆（${clearMemory(chatId)} 条）。`;
  if (/^(add|新增)\s+/i.test(arg)) return memoryCommand(chatId, `/记住 ${arg.replace(/^\S+\s+/, "")}`);
  return "用法：`/记忆` 查看；`/记住 <内容>`；`/记忆 forget <编号…>`；`/记忆 clear`";
}
