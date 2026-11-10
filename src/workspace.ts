// =============================================================================
// Per-chat workspace — which directory a group's agent (and its orc team) works in
// =============================================================================
// Resolution order for a chat: explicit setting (this file's store) → registered
// task (.tasks.json) → WORKDIR. Set by `/工作区 <路径或项目名>`, by natural
// language (「把工作目录切到 …」), or by a `项目名:指令` prefix. Persisted to
// state/chat-workspace.json so it survives restarts.
//
// Group memory must not carry "工作目录是 X": the model would believe it while
// the code keeps running in the old cwd. Switching clears such memory items,
// and agent/lead `[[remember]]` of them is refused (src/memory.ts).
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { getProjects } from "./projects";

export interface ChatWorkspace {
  workspace: string;
  label: string;
}

interface Saved extends ChatWorkspace {
  setAt: number;
}

function file(): string {
  return process.env.CHAT_WORKSPACE_FILE || resolve(import.meta.dirname, "../state/chat-workspace.json");
}

let cache: Record<string, Saved> | undefined;

function load(): Record<string, Saved> {
  if (cache) return cache;
  cache = {};
  try {
    if (existsSync(file())) cache = JSON.parse(readFileSync(file(), "utf8")) ?? {};
  } catch { /* corrupt → start empty, rewritten on next change */ }
  return cache!;
}

function save(): void {
  const f = file();
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f + ".tmp", JSON.stringify(cache ?? {}, null, 2));
  renameSync(f + ".tmp", f);
}

/** All explicit per-chat settings (for hydrating the runtime map at startup) */
export function savedWorkspaces(): Record<string, ChatWorkspace> {
  const out: Record<string, ChatWorkspace> = {};
  for (const [k, v] of Object.entries(load())) out[k] = { workspace: v.workspace, label: v.label };
  return out;
}

export function getSavedWorkspace(chatId: string): ChatWorkspace | undefined {
  const v = load()[chatId];
  return v ? { workspace: v.workspace, label: v.label } : undefined;
}

/** Persist (or clear with `undefined`) the explicit setting for a chat */
export function saveWorkspace(chatId: string, ws: ChatWorkspace | undefined): void {
  const all = load();
  if (ws) all[chatId] = { ...ws, setAt: Date.now() };
  else if (all[chatId]) delete all[chatId];
  else return;
  save();
}

// ---------------------------------------------------------------------------
// Target resolution: project name or directory path
// ---------------------------------------------------------------------------

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

/** Project key whose path is exactly `dir` (so `/data/dev/worldout` gets label `worldout`) */
export function labelFor(dir: string): string {
  const hit = Object.entries(getProjects().projects).find(([, p]) => resolve(p.path) === dir);
  return hit ? hit[0] : basename(dir) || dir;
}

export type ResolveResult =
  | { ok: true; ws: ChatWorkspace }
  | { ok: false; reason: string };

const QUOTES = /^[`'"“”‘’「」『』《》]+|[`'"“”‘’「」『』《》]+$/g;

/** `/data/x`, `~/x`, or a projects.json key (case-insensitive; 「worldout 项目」 also works) */
export function resolveWorkspaceTarget(arg: string): ResolveResult {
  const a = arg.trim().replace(QUOTES, "").replace(/[。.!！?？，,；;]+$/, "").trim();
  if (!a) return { ok: false, reason: "没有给出目录或项目名。" };

  if (a.startsWith("/") || a.startsWith("~")) {
    const p = resolve(a.startsWith("~") ? (process.env.HOME || "/root") + a.slice(1) : a);
    if (!isAbsolute(p) || !isDir(p)) return { ok: false, reason: `目录 \`${p}\` 不存在。` };
    return { ok: true, ws: { workspace: p, label: labelFor(p) } };
  }

  const projects = getProjects().projects;
  const key = a.replace(/\s*(这个)?(项目|仓库|目录)$/, "").trim();
  const hit = projects[key] ? key : Object.keys(projects).find((k) => k.toLowerCase() === key.toLowerCase());
  if (hit) {
    const p = resolve(projects[hit].path);
    if (!isDir(p)) return { ok: false, reason: `项目 \`${hit}\` 配置的目录 \`${p}\` 不存在。` };
    return { ok: true, ws: { workspace: p, label: hit } };
  }
  const names = Object.keys(projects);
  return {
    ok: false,
    reason: `没有叫「${key}」的项目。` + (names.length ? `可用项目：${names.map((n) => `\`${n}\``).join(" ")}；也可以直接给绝对路径。` : "请直接给绝对路径（projects.json 里还没有配置项目）。"),
  };
}

// ---------------------------------------------------------------------------
// Natural language: 「把工作目录切到 /data/dev/x」「工作区换成 worldout」「切到 worldout 项目」
// ---------------------------------------------------------------------------

export interface SwitchWorkspaceIntent {
  target: string;
  /** Anything after the target (「…然后跑一下测试」) — handled as a normal message after switching */
  rest: string;
  /** The text named the workspace explicitly (工作目录/工作区/cd …): a bad target gets an error reply */
  explicit: boolean;
}

const KW = "(?:工作目录|工作区|工作路径|工作空间|根目录|workspace|work\\s*dir|cwd)";
const LEAD = "^(?:请|麻烦)?(?:你)?(?:帮我)?(?:把|将)?(?:本群|这个群|这群|群里|群|当前|我们)?(?:的)?";
const EXPLICIT_RE = new RegExp(`${LEAD}${KW}\\s*(?:切换|切|换|改|设置|设|定|指|固定)(?:成|到|为|在)?\\s*(.+)$`, "is");
const CD_RE = /^cd\s+(.+)$/is;
const PROJECT_RE = /^(?:请|麻烦)?(?:你)?(?:帮我)?(?:切换|切|换)(?:到|进)\s*(.+?)\s*(?:这个|那个)?(?:项目|仓库)(?:里|下|去|吧|了)*\s*(?:[，,。;；]\s*(.*))?$/is;

/**
 * Leading path / project-name token, then whatever follows (connectors stripped).
 * Only ASCII-ish tokens count as a target — 「工作目录改了吗」 is a question, not a switch.
 */
function splitTarget(s: string): { target: string; rest: string } | undefined {
  const t = s.trim();
  const m = t.match(/^[`'"“「『]?([A-Za-z0-9_.~\/\-+@]+)[`'"”」』]?/);
  if (!m || !/[A-Za-z0-9]/.test(m[1])) return undefined;
  const rest = t.slice(m[0].length)
    .replace(/^\s*(?:这个|那个)?(?:项目|仓库|目录)?(?:里|下|去|吧|了)*/, "")
    .replace(/^[\s，,。；;!！]*(?:然后|再|并且|并|接着|之后)?[\s，,]*/, "")
    .trim();
  return { target: m[1], rest };
}

export function parseSwitchWorkspaceIntent(text: string): SwitchWorkspaceIntent | undefined {
  const t = (text || "").trim();
  if (!t || t.length > 200 || t.startsWith("/")) return undefined;
  const m = t.match(EXPLICIT_RE) || t.match(CD_RE);
  if (m) {
    const s = splitTarget(m[1]);
    return s ? { ...s, explicit: true } : undefined;
  }
  const p = t.match(PROJECT_RE);
  if (p) {
    const s = splitTarget(p[1]);
    if (!s || s.rest) return undefined;
    return { target: s.target, rest: (p[2] || "").trim(), explicit: false };
  }
  return undefined;
}

/** `/工作区` `/workspace` `/ws` `/cd` [arg] → arg ("" = show); undefined = not this command */
export function workspaceCommandArg(text: string): string | undefined {
  const m = text.trim().match(/^\/(工作区|工作目录|workspace|ws|cd)(?:\s+([\s\S]*))?$/i);
  return m ? (m[2] || "").trim() : undefined;
}

export const RESET_ARGS = /^(reset|default|默认|恢复默认|清除)$/i;

/** One line for the agent's system prompt: where it really runs, and that it cannot switch itself */
export function formatWorkspaceHint(ws: ChatWorkspace): string {
  return [
    `【工作区】本群当前工作区：\`${ws.label}\` → ${ws.workspace}（你的命令默认在这里执行）。`,
    "切换工作区只能由用户发 `/工作区 <路径或项目名>` 或说「把工作目录切到 …」，由代码完成，你自己切不了。",
    "用户想换工作区时，请把这句话告诉他，不要说已经切好，也不要把工作目录写进本群记忆。",
  ].join("\n");
}
