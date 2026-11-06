// =============================================================================
// Team mode — multi-role orchestrated discussion groups (/team)
// =============================================================================
// A "team" chat owns a roster of roles. Every user message runs a bounded
// discussion: each role speaks in order under its own CLI session, then a
// moderator turn converges the thread into a single answer.
// =============================================================================
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiResult } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
export const TEAMS_PATH = resolve(ROOT, ".teams.json");

/** Sentinel a role emits when it has nothing new to add this round */
export const AGREE_SENTINEL = "[[同意]]";
export const DEFAULT_MAX_ROUNDS = 2;
export const MAX_ROUNDS_CAP = 5;
export const MAX_ROLES = 5;

export const TEAM_USAGE = [
  "**团队群指令**",
  "• `/team` — 团队状态",
  "• `/team 角色` — 查看花名册",
  "• `/team 轮次 <1-5>` — 每轮讨论的最大轮数",
  "• `/team 加 <角色名>[:描述]` — 增加一个角色",
  "• `/team 收敛` — 不等本轮跑完，立即收口出结论",
  "• `/team 重置` — 清空所有角色的会话记忆",
  "",
  "群内直接发问题或观点，团队按顺序发言后自动收敛总结。",
].join("\n");

export interface TeamRole {
  /** Stable slug — part of the per-role session key, do not change after creation */
  id: string;
  /** Display name used in speech card headers */
  name: string;
  /** Persona / perspective instruction */
  prompt: string;
}

export interface TeamState {
  chatId: string;
  /** Original group topic (建群时的任务描述) */
  topic: string;
  roles: TeamRole[];
  /** Max discussion rounds per user turn (1..MAX_ROUNDS_CAP) */
  maxRounds: number;
  createdAt: number;
  lastActiveAt: number;
  /** Latest user turn — lets `/team 收敛` re-converge without a new question */
  lastUserText?: string;
  /** Compact transcript of the latest discussion, same purpose */
  lastTranscript?: string;
}

export interface Speech {
  roleId: string;
  name: string;
  text: string;
  /** Role reported "no new points" this round */
  agreed: boolean;
  round: number;
  usage?: AiResult["usage"];
  model?: string;
}

interface TeamStore {
  teams: Record<string, TeamState>;
}

// ---------------------------------------------------------------------------
// Persistence (`.teams.json`, debounced atomic write)
// ---------------------------------------------------------------------------

let store: TeamStore = { teams: {} };

function load(): void {
  if (!existsSync(TEAMS_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(TEAMS_PATH, "utf-8")) as TeamStore;
    store = { teams: data?.teams ?? {} };
  } catch { /* ignore corrupt store */ }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 300);
}

function saveNow(): void {
  const tmp = TEAMS_PATH + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
    renameSync(tmp, TEAMS_PATH);
  } catch (e) {
    console.error(`[team] failed to write ${TEAMS_PATH}:`, e);
  }
}

/** Flush pending writes on shutdown */
export function flushTeams(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveNow();
}

load();

// ---------------------------------------------------------------------------
// Store API
// ---------------------------------------------------------------------------

export function getTeam(chatId: string): TeamState | undefined {
  return store.teams[chatId];
}

export function isTeamChat(chatId: string): boolean {
  return Boolean(store.teams[chatId]);
}

export function setTeam(state: TeamState): void {
  store.teams[state.chatId] = state;
  save();
}

export function touchTeam(chatId: string, patch: Partial<Pick<TeamState, "lastUserText" | "lastTranscript">>): void {
  const team = store.teams[chatId];
  if (!team) return;
  Object.assign(team, patch, { lastActiveAt: Date.now() });
  save();
}

// ---------------------------------------------------------------------------
// Session keys — chatId is only a Map key inside the AI adapters, so a
// composite key gives every role an isolated, persistent CLI session.
// ---------------------------------------------------------------------------

export function roleSessionKey(chatId: string, roleId: string): string {
  return `${chatId}#role:${roleId}`;
}

export function moderatorSessionKey(chatId: string): string {
  return `${chatId}#moderator`;
}

export function metaSessionKey(chatId: string): string {
  return `${chatId}#meta`;
}

// ---------------------------------------------------------------------------
// Roster: decomposition prompt + tolerant parser + fallback
// ---------------------------------------------------------------------------

export function buildRosterPrompt(topic: string): string {
  return [
    "你在为一个即时通讯群组建「多角色专家团」。建群任务描述如下：",
    "",
    "【任务描述】",
    topic,
    "",
    "【要求】",
    `- 设计 3~${MAX_ROLES} 个视角互补、能形成真实张力的角色（禁止全是同一类人）`,
    "- 角色需覆盖：目标与收益、风险与代价、落地与执行 —— 三类视角至少各有一个",
    "- 每个角色给出：id（小写英文，可用短横线）、name（中文角色名，4~10 字）、prompt（该角色的关注点、立场与发言风格，40~80 字）",
    "- 只输出一个 JSON 对象；不要解释、不要 markdown 代码块标记",
    "",
    "【输出格式】",
    '{"roles":[{"id":"cost","name":"成本工程师","prompt":"只关注成本结构与规模效应……"}]}',
  ].join("\n");
}

export function slugifyRoleId(raw: string, fallbackIndex = 1): string {
  const s = raw
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || `role${fallbackIndex}`;
}

/** Extract `{roles:[...]}` from noisy CLI output (fences, prose, trailing junk) */
export function parseRoster(raw: string): TeamRole[] | null {
  const text = (raw || "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  const list = (parsed as { roles?: unknown })?.roles;
  if (!Array.isArray(list)) return null;

  const roles: TeamRole[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const name = typeof rec.name === "string" ? rec.name.trim().slice(0, 20) : "";
    const prompt = typeof rec.prompt === "string" ? rec.prompt.trim().slice(0, 400) : "";
    if (!name || !prompt) continue;

    const base = slugifyRoleId(typeof rec.id === "string" && rec.id.trim() ? rec.id : name, roles.length + 1);
    let id = base;
    let n = 2;
    while (seen.has(id)) id = `${base}-${n++}`;
    seen.add(id);

    roles.push({ id, name, prompt });
    if (roles.length >= MAX_ROLES) break;
  }

  return roles.length >= 2 ? roles : null;
}

/** Used when roster decomposition fails — keeps the group usable regardless */
export function fallbackRoster(): TeamRole[] {
  return [
    {
      id: "goal",
      name: "目标与收益",
      prompt: "只关注这件事要达成的目标、收益与判定标准；追问「成功长什么样」「怎么衡量」，避免讨论跑偏。",
    },
    {
      id: "risk",
      name: "风险与代价",
      prompt: "只关注风险、隐形成本、失败模式与被默认的假设；指出最可能翻车的地方以及付出的代价。",
    },
    {
      id: "exec",
      name: "落地与执行",
      prompt: "只关注怎么落地：步骤、依赖、时间与人力的最小可行路径；给出可立即执行的动作。",
    },
  ];
}

// ---------------------------------------------------------------------------
// Prompt builders — role speech / moderator convergence
// ---------------------------------------------------------------------------

export function buildRolePrompt(opts: {
  role: TeamRole;
  topic: string;
  userText: string;
  transcript: string;
  round: number;
  maxRounds: number;
}): string {
  const { role, topic, userText, transcript, round, maxRounds } = opts;
  return [
    `【你的角色】${role.name}`,
    role.prompt,
    "",
    `【团队主题】${topic}`,
    "",
    "【用户本轮发言】",
    userText,
    "",
    `【讨论进度】第 ${round}/${maxRounds} 轮`,
    "",
    "【之前已发言记录】",
    transcript,
    "",
    "【发言规则】",
    "1. 只从你的角色视角发言，不要替其他角色说话，不要写「作为AI」",
    "2. 300 字以内；先给结论，再给理由；不要复述别人已说过的内容",
    `3. 如果你对本次用户发言没有新增观点（前文已充分覆盖），第一行只输出 ${AGREE_SENTINEL}，第二行用一句话说明保留意见或补充，然后结束`,
    "4. 不要输出 JSON，不要用 markdown 表格，不要输出标题层级",
  ].join("\n");
}

export function buildSynthesisPrompt(opts: {
  topic: string;
  userText: string;
  transcript: string;
  roleNames: string[];
}): string {
  return [
    "【任务】你是这场多角色讨论的主持人。请收口讨论，输出给用户的最终回复。",
    "",
    `【团队主题】${opts.topic}`,
    "",
    "【用户本轮发言】",
    opts.userText,
    "",
    `【参与角色】${opts.roleNames.join("、")}`,
    "",
    "【讨论记录】",
    opts.transcript,
    "",
    "【输出结构】",
    "1. **结论** — 收敛后的直接回答；若存在条件性分歧，说明结论成立的前提",
    "2. **主要分歧** — 只有确实存在实质分歧时才写，每条一句话并点出分歧根源",
    "3. **下一步建议** — 最多 3 条，可执行",
    "",
    "【硬性要求】",
    "- 不要复述每个人的原话，不要按人罗列发言，要真正收敛成一个答案",
    "- 600 字以内",
    "- 若讨论已达成一致，不要为了凑结构编造分歧",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Transcript digest — bounded so role prompts never explode
// ---------------------------------------------------------------------------

export function buildTranscript(speeches: Speech[], maxChars = 3000): string {
  const lines = speeches
    .filter((s) => s.text.trim())
    .map((s) => `【${s.name}·R${s.round}】${s.text.trim()}`);
  let out = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!out) {
      // Always keep at least the newest speech, truncated if it alone blows
      // the budget — an empty digest would silently strip a speaker's context.
      out = line.length > maxChars ? `${line.slice(0, Math.max(0, maxChars - 1))}…` : line;
      continue;
    }
    const candidate = `${line}\n\n${out}`;
    if (candidate.length > maxChars) break;
    out = candidate;
  }
  return out || "（暂无发言）";
}

// ---------------------------------------------------------------------------
// Convergence helpers
// ---------------------------------------------------------------------------

export function isAgree(text: string): boolean {
  return (text || "").trimStart().startsWith(AGREE_SENTINEL);
}

export function stripSentinel(text: string): string {
  return (text || "").replace(AGREE_SENTINEL, "").trim();
}
