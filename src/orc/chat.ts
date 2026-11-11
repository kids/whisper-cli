// =============================================================================
// orc ↔ chat glue: per-chat mode/preset profile, one shared Orchestrator per
// process, progress cards, notifications, lead-agent action parsing (002 §2–§3)
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { larkOf } from "../platform/feishu";
import type { ImClient } from "../platform/types";
import type { AgentConfig } from "../types";
import { getChatInstructions } from "../announcement";
import { formatMemory, joinInstructions } from "../memory";
import { renderWatchCard, updateWatch } from "../watch";
import { AGENT_CARDS_ON, AgentCards } from "./agent-cards";
import { acceptable, stageName } from "./core";
import { applyPatch, loadPresets, loadRoles, presetSummary, resolvePreset } from "./config";
import { budgetState, clip, currentEvidence, type Ledger } from "./ledger";
import { findJsonObjects } from "./output";
import { CliExecutor, type ExecutorBins } from "./runner";
import { Orchestrator } from "./scheduler";
import { OrcStore } from "./store";
import { MODE_LABEL, type ChatMode, type RouteTask } from "./route";
import type { CliName, PresetPatch, ResolvedPreset, Task, Verbosity } from "./types";
import type { LoopRunEvent } from "./loop";
import { TERMINAL } from "./types";

export const ORC_HOME = process.env.ORC_HOME || resolve(process.env.HOME || "/root", ".orc");
const PROFILES_PATH = process.env.ORC_CHATS_PATH || resolve(import.meta.dirname, "../../state/orc-chats.json");

// ---- chat profiles ----------------------------------------------------------

export interface ChatProfile {
  /** auto (default): code routes each message; single: one agent; orc: everything via the lead (src/orc/route.ts) */
  mode: ChatMode;
  preset: string;
  patch: PresetPatch;
  version: number;
  /** Proposed by the lead agent, applied only after the human says 确认 */
  pending?: { kind: "config"; patch: PresetPatch } | { kind: "announce"; paragraphs: string[]; revision: number };
  /** Bot group that serves this chat — lets cards/notifications resume after a restart */
  bot?: string;
  /** Pipeline tasks: quiet = no per-agent cards in the thread; normal (default) / verbose = one card per run */
  verbosity?: Verbosity;
}

let profiles: Record<string, ChatProfile> | null = null;
function loadProfiles(): Record<string, ChatProfile> {
  if (profiles) return profiles;
  try { profiles = existsSync(PROFILES_PATH) ? JSON.parse(readFileSync(PROFILES_PATH, "utf8")) : {}; }
  catch { profiles = {}; }
  return profiles!;
}
function saveProfiles(): void {
  mkdirSync(resolve(PROFILES_PATH, ".."), { recursive: true });
  const tmp = PROFILES_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(profiles ?? {}, null, 2));
  renameSync(tmp, PROFILES_PATH);
}
export function getProfile(chatId: string): ChatProfile {
  return loadProfiles()[chatId] ?? { mode: "auto", preset: "dev", patch: {}, version: 1 };
}
export function setProfile(chatId: string, p: ChatProfile): void {
  loadProfiles()[chatId] = p;
  saveProfiles();
}

/** Validate a chat's preset (+ optional extra patch) into a runnable snapshot; throws on invalid */
export function resolveChatPreset(p: ChatProfile, extra?: PresetPatch, available?: string[]): ResolvedPreset {
  const presets = loadPresets();
  const roles = loadRoles();
  const base = presets.get(p.preset);
  if (!base) throw new Error(`未知组合 "${p.preset}"，可选：${[...presets.keys()].join(" / ")}`);
  let def = applyPatch(base, p.patch, presets);
  if (extra) def = applyPatch(def, extra, presets);
  const r = resolvePreset(def, roles, { version: p.version + (extra ? 1 : 0), availableClis: available as any });
  if (r.loop && p.verbosity) r.loop.verbosity = p.verbosity;
  return r;
}

export function listPresetSummaries(available?: string[]): string[] {
  const roles = loadRoles();
  return [...loadPresets().values()].map((p) => {
    try { return `• \`${p.name}\` ${p.description}\n  ${presetSummary(resolvePreset(p, roles, { availableClis: available as any }))}`; }
    catch (e) { return `• \`${p.name}\` ⚠️ ${(e as Error).message}`; }
  });
}

// ---- shared orchestrator ----------------------------------------------------

const chatClients = new Map<string, ImClient>();
const bots = new Map<string, ImClient>();     // bot group name → client (registered at startup)
const cardTouched = new Map<number, number>();
const CARD_THROTTLE_MS = Number(process.env.ORC_CARD_THROTTLE_MS || 30_000);
let orc: Orchestrator | null = null;
let executor: CliExecutor | null = null;

// taskId → progress card message id; persisted so cards keep updating after a restart
let cards: Map<number, string> | null = null;
const cardsPath = () => resolve(ORC_HOME, "cards.json");
function cardMap(): Map<number, string> {
  if (cards) return cards;
  try { cards = new Map(Object.entries(JSON.parse(readFileSync(cardsPath(), "utf8"))).map(([k, v]) => [Number(k), String(v)])); }
  catch { cards = new Map(); }
  return cards;
}
function setCard(taskId: number, messageId: string): void {
  const m = cardMap();
  m.set(taskId, messageId);
  const keep = [...m.entries()].sort((a, b) => a[0] - b[0]).slice(-500);
  mkdirSync(ORC_HOME, { recursive: true });
  writeFileSync(cardsPath() + ".tmp", JSON.stringify(Object.fromEntries(keep)));
  renameSync(cardsPath() + ".tmp", cardsPath());
}

/** Task whose progress card is this message (thread replies under a card belong to that task) */
export function taskForCard(messageId: string): number | undefined {
  for (const [id, mid] of cardMap()) if (mid === messageId) return id;
  return undefined;
}

/** Called once per bot group at startup */
export function registerBot(name: string, im: ImClient): void {
  bots.set(name, im);
}

export function bindChat(chatId: string, im: ImClient): void {
  chatClients.set(chatId, im);
  const name = [...bots.entries()].find(([, f]) => f === im)?.[0];
  if (name && getProfile(chatId).bot !== name) setProfile(chatId, { ...getProfile(chatId), bot: name });
}

/** Client for a chat: bound this process, else the bot recorded in its profile, else the only bot */
function clientFor(chatId: string | null): ImClient | undefined {
  if (!chatId) return undefined;
  const hit = chatClients.get(chatId);
  if (hit) return hit;
  const bot = getProfile(chatId).bot;
  const f = (bot && bots.get(bot)) || (bots.size === 1 ? [...bots.values()][0] : undefined);
  if (f) chatClients.set(chatId, f);
  return f;
}

/** True when a previous process left orc work behind (start the scheduler eagerly) */
export function hasOrcState(): boolean {
  return existsSync(resolve(ORC_HOME, "orc.db"));
}

const STATUS_ICON: Record<Task["status"], string> = { queued: "⏳", running: "🛠", waiting: "⏳", waiting_children: "🧩", ready: "✅", blocked: "✋", failed: "❌", dropped: "🛑" };
const STATUS_ZH: Record<Task["status"], string> = { queued: "排队中", running: "进行中", waiting: "等待外部作业", waiting_children: "等子任务", ready: "完成", blocked: "等你决定", failed: "已放弃", dropped: "已终止" };
const roleLabel = (t: Task, name?: string) => {
  const r = name ? t.preset.roles[name] : undefined;
  return r ? `${r.cli}${r.model ? ":" + r.model : ""}` : "-";
};
const age = (ms: number) => { const m = Math.round(ms / 60_000); return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`; };

export function renderCard(t: Task, store: OrcStore, threaded = false): string {
  if (t.kind === "loop") return renderLoopCard(t, store.getLedger<Ledger>(t.id), threaded);
  const stage = t.preset.stages[Math.min(t.stageIdx, t.preset.stages.length - 1)];
  const icon = STATUS_ICON[t.status];
  const lines = [
    `**${icon} #${t.id} ${t.title}**${t.parentId ? `（#${t.parentId} 的子任务）` : ""}`,
    `${t.preset.name} · 阶段 ${t.status === "ready" ? "完成" : `${stage.id}(${t.stageIdx + 1}/${t.preset.stages.length})`} · ${STATUS_ZH[t.status]} · ${age(Date.now() - t.createdAt)}`,
  ];
  // a split task: the whole structure on one card
  const kids = t.parentId ? [] : store.listTasks({ parentId: t.id }).sort((a, b) => a.id - b.id);
  if (kids.length) {
    lines.push("", ...kids.map((c) => {
      const dep = c.deps.length ? `（等 ${c.deps.map((d) => "#" + d).join(",")}）` : "";
      return `${STATUS_ICON[c.status]} #${c.id} ${c.title} · ${STATUS_ZH[c.status]}${dep}`;
    }));
  }
  const loops = Object.entries(t.loops).filter(([k]) => !k.includes(":"));
  if (loops.length) lines.push(`退回：${loops.map(([k, v]) => `${k} ${v}/${t.preset.stages.find((s) => s.id === k)?.maxLoops ?? "?"}`).join("，")}`);
  const all = store.listAttempts(t.id);
  const atts = all.slice(-6);
  const role = t.preset.roles[stage.role];
  const others = (t.status === "running" || t.status === "queued") && !all.some((a) => a.status === "running")
    ? store.runningAttempts().filter((a) => a.role === stage.role && a.taskId !== t.id) : [];
  if (role && others.length >= role.count) {
    lines.push(`⏳ 排队等 ${stage.role}：名额被 ${others.map((a) => `#${a.taskId}`).join("、")} 占着`);
  } else {
    lines.push(`最近：${t.progress || "-"}`);
  }
  const tok = all.reduce((s, a) => s + (a.tokens || 0), 0);
  if (tok) lines.push(`已用 ${(tok / 1e6).toFixed(1)}M tokens · ${all.length} 次运行`);
  if (atts.length) {
    lines.push("", ...atts.map((a) => {
      const mark = a.status === "running" ? "▶" : a.parsed?.pass ? "✓" : a.status === "done" ? "✗" : "·";
      const tail = threaded ? "" : ` ${(a.parsed?.summary || a.progress || a.error || "").slice(0, 80)}`;
      return `${mark} ${a.stageId}/${a.role} \`${a.cli}${a.model ? ":" + a.model : ""}\`${tail}`;
    }));
  }
  if (t.branch) lines.push("", `分支 \`${t.branch}\``);
  if (threaded) lines.push("", "每个 agent 的过程和结论在这条消息的回复串里。");
  return lines.join("\n");
}

export function renderLoopCard(t: Task, l: Ledger | undefined, threaded = false): string {
  const loop = t.preset.loop;
  const lines = [
    `**${STATUS_ICON[t.status]} #${t.id} ${t.title}**`,
    `监督循环 · 第 ${l?.step ?? 0} 轮 · ${STATUS_ZH[t.status]} · ${age(Date.now() - t.createdAt)}`,
    `监督 \`${roleLabel(t, loop?.supervisor)}\` · 执行 \`${roleLabel(t, loop?.worker)}\`${loop?.reviewer ? ` · 审查 \`${roleLabel(t, loop.reviewer)}\`` : ""}`,
  ];
  if (l) {
    const passed = currentEvidence(l).filter((e) => e.pass).map((e) => e.id);
    lines.push(`验收标准：${l.criteria.length ? l.criteria.map((c) => c.id).join(" ") : "待定"}；当前版本通过的证据：${passed.join(" ") || "无"}`);
    lines.push(`预算：${budgetState(l).line}`);
    if (l.pendingAsk) lines.push(`✋ 等你决定：${clip(l.pendingAsk.question, 120)}`);
    if (l.waitWatch) lines.push(`⏳ 等待监控 #${l.waitWatch}`);
  }
  lines.push(`最近：${clip(t.progress || "-", 160)}`);
  if (l?.plan.length) {
    const mark = { todo: "○", doing: "▶", done: "✓", dropped: "✗" } as const;
    lines.push("", ...l.plan.slice(0, 8).map((p) => `${mark[p.status]} ${clip(p.text, 80)}`));
  }
  if (t.branch) lines.push("", `分支 \`${t.branch}\``);
  if (!TERMINAL.includes(t.status) || t.status === "blocked") lines.push("", `${threaded ? "每轮一张卡片（监督者和执行者各跑了什么、结论是什么）" : "每轮的主 ↔ 子交互"}在这条消息的回复串里。直接在群里说话就能影响它：补充要求、改口径、换模型、叫停都行。`);
  return lines.join("\n");
}

/** Walk up to the task the human submitted (planner-split children hang off it) */
function rootOf(t: Task): Task {
  let cur = t;
  for (let i = 0; i < 8 && cur.parentId; i++) {
    const p = orc?.store.getTask(cur.parentId);
    if (!p) break;
    cur = p;
  }
  return cur;
}

/**
 * Every task with a chat gets a card. The submitted task's card is posted in the chat (submitFromChat);
 * a planner-split child's card goes into the root card's thread, next to the runs it spawns.
 */
async function ensureCard(t: Task, im: ImClient): Promise<string | undefined> {
  const known = cardMap().get(t.id);
  if (known) return known;
  const root = rootOf(t);
  const rootCard = root.id !== t.id ? cardMap().get(root.id) : undefined;
  if (!rootCard || !im.replyCardInThread) return undefined;
  const id = await im.replyCardInThread(rootCard, renderCard(t, orc!.store, true)).catch(() => undefined);
  if (id) setCard(t.id, id);
  return id;
}

async function refreshCard(t: Task, force = false): Promise<void> {
  const im = clientFor(t.chatId);
  if (!im || !orc) return;
  const cardId = await ensureCard(t, im);
  if (!cardId) return;
  void syncAgentCards(t);
  const now = Date.now();
  if (!force && now - (cardTouched.get(t.id) ?? 0) < CARD_THROTTLE_MS) return;
  cardTouched.set(t.id, now);
  await im.updateCardMessage(cardId, renderCard(t, orc.store, threadCards(t))).catch(() => {});
}

// ---- per-agent cards in the task card's thread (agent-cards.ts) ----------------

let agentCards: AgentCards | null = null;
const cardsOf = () => (agentCards ??= new AgentCards(resolve(ORC_HOME, "agent-cards.json")));
const syncChain = new Map<number, Promise<void>>();

/** This task gets per-agent thread cards (platform has threads, chat not set to quiet) */
function threadCards(t: Task): boolean {
  if (!AGENT_CARDS_ON() || !t.chatId) return false;
  const im = clientFor(t.chatId);
  if (!im?.replyCardInThread || !cardMap().get(t.id)) return false;
  const v = t.kind === "loop" ? orc?.store.getLedger<Ledger>(t.id)?.verbosity : getProfile(t.chatId).verbosity;
  return v !== "quiet";
}

/** Everything about one submitted task lives in one thread: the root card's replies */
const rootCardOf = (t: Task) => cardMap().get(rootOf(t).id);

/** Pipeline: create / update / finalise the card of every attempt (serialised per task) */
function syncAgentCards(t: Task): Promise<void> {
  if (t.kind === "loop" || !orc || !threadCards(t)) return Promise.resolve();
  const im = clientFor(t.chatId)!;
  const root = rootCardOf(t);
  if (!root) return Promise.resolve();
  const store = orc.store;
  const next = (syncChain.get(t.id) ?? Promise.resolve())
    .then(() => cardsOf().syncAttempts(im, root, store.getTask(t.id) ?? t, store.listAttempts(t.id), ORC_HOME))
    .catch((e) => console.error(`[orc] agent cards #${t.id}:`, (e as Error).message));
  syncChain.set(t.id, next);
  return next;
}

function loopRunCard(t: Task, ev: LoopRunEvent): void {
  if (!threadCards(t)) return;
  const im = clientFor(t.chatId)!;
  const root = rootCardOf(t);
  if (!root) return;
  const next = (syncChain.get(t.id) ?? Promise.resolve())
    .then(() => cardsOf().loopRun(im, root, ev))
    .catch((e) => console.error(`[orc] agent cards #${t.id}:`, (e as Error).message));
  syncChain.set(t.id, next);
}

export function getOrc(agents: AgentConfig[], bins: ExecutorBins): Orchestrator {
  if (orc) return orc;
  mkdirSync(ORC_HOME, { recursive: true });
  executor = new CliExecutor(agents, bins);
  orc = new Orchestrator(new OrcStore(resolve(ORC_HOME, "orc.db")), executor, {
    orcHome: ORC_HOME,
    instructionsFor: async (t) => {
      if (!t.chatId) return undefined;
      const f = clientFor(t.chatId);
      const lark = larkOf(f);
      const ann = lark ? await getChatInstructions(lark, t.chatId) : undefined;
      return joinInstructions(ann, formatMemory(t.chatId)); // workers read group memory, never write it
    },
    onProgress: (t) => void refreshCard(t, TERMINAL.includes(t.status)),
    // 决策说明 written by orc/roles/advisor.md (engine-level, not part of any preset)
    briefRole: () => {
      const r = loadRoles().get("advisor");
      return r ? { ...r, count: 1 } : undefined;
    },
    notify: async (t, n) => {
      if (!t.chatId) return; // CLI-submitted task: nothing to deliver
      const f = clientFor(t.chatId);
      // bot not registered yet (startup race) → throw so the notify effect is retried with backoff
      if (!f) throw new Error(`no chat client for chat ${t.chatId}`);
      // loop rounds (主 ↔ 子) go into the card's thread so the chat stays readable
      if (n.kind === "turn") {
        void refreshCard(t);
        const cardId = cardMap().get(t.id);
        if (cardId && n.round !== undefined && threadCards(t)) {
          await (syncChain.get(t.id) ?? Promise.resolve());
          if (await cardsOf().loopTurn(f, cardId, t.id, n.round, n.text)) return;
        }
        if (cardId && await f.replyInThread(cardId, n.text)) return;
        await f.sendMarkdown(t.chatId, `**#${t.id}** ${n.text}`);
        return;
      }
      await refreshCard(t, true);
      await (syncChain.get(t.id) ?? Promise.resolve()); // the run's own card lands in the thread before the headline
      const head = { ready: "✅ 结果可用", decision: "✋ 需要你决定", failed: "❌ 无法继续", info: "ℹ️", ask: "✋ 需要你决定", report: "📋 汇报", constraints: "📐 约束 / 验收标准变更" }[n.kind];
      const tail = n.kind === "decision" && t.kind !== "loop" && !n.text.includes("你可以回复") ? `\n\n要重试就直接说「再试一次」，可以顺带补充要改的地方；不需要了就说「放弃」。` : "";
      await f.sendMarkdown(t.chatId, `**${head} · #${t.id} ${t.title}**\n\n${n.text}${tail}`);
    },
    loop: {
      watchBot: (t) => {
        if (!t.chatId) return undefined;
        const b = getProfile(t.chatId).bot;
        return b && bots.has(b) ? b : bots.size === 1 ? [...bots.keys()][0] : undefined;
      },
      onWatchCreated: (t, w) => {
        const f = clientFor(t.chatId);
        if (!f || !t.chatId) return;
        void f.sendCardAndGetId(t.chatId, renderWatchCard(w)).then((id) => { if (id) updateWatch(w.id, { cardId: id }); }).catch(() => {});
      },
      onRun: loopRunCard,
    },
  });
  orc.start();
  return orc;
}

export function availableClis(): string[] {
  return executor?.available() ?? [];
}

/** Submit from chat: posts the progress card and binds it to the task */
export async function submitFromChat(
  o: Orchestrator, im: ImClient, chatId: string, goal: string, repo: string, preset: ResolvedPreset,
  extra: { criteria?: string[]; constraints?: string[]; sourceText?: string } = {},
): Promise<Task> {
  bindChat(chatId, im);
  const task = o.submit({ goal, repo, preset, chatId, ...extra });
  const cardId = await im.sendCardAndGetId(chatId, renderCard(task, o.store)).catch(() => undefined);
  if (cardId) { setCard(task.id, cardId); void syncAgentCards(o.store.getTask(task.id) ?? task); }
  return task;
}

/** One-line-per-task summary of this chat's active orc tasks (for single-mode prompts) */
export function activeTaskSummary(chatId: string): string | undefined {
  if (!orc) return undefined;
  const ts = orc.store.listTasks({ chatId, status: ["queued", "running", "waiting", "waiting_children", "blocked"], limit: 5 });
  if (!ts.length) return undefined;
  return "【本群后台 orc 任务】\n" + ts.map((t) => `- #${t.id} [${t.status}] ${t.title}：${t.progress}`).join("\n");
}

/** What the router needs about this chat: recent tasks (+ open questions) and a pending proposal */
export function routeContext(chatId: string): { tasks: RouteTask[]; pendingProposal: boolean } {
  const pendingProposal = !!loadProfiles()[chatId]?.pending;
  if (!orc) return { tasks: [], pendingProposal };
  const store = orc.store;
  const tasks = store.listTasks({ chatId, limit: 10 }).filter((t) => !t.parentId).map((t) => ({
    id: t.id, title: t.title, status: t.status, updatedAt: t.updatedAt,
    // waiting for a human: a loop question, or a pipeline stuck on review / test (再试一次 / 接受 / 放弃)
    asking: t.status === "blocked" && (t.kind === "loop" ? !!store.getLedger<Ledger>(t.id)?.pendingAsk : !!acceptable(t)),
  }));
  return { tasks, pendingProposal };
}

// ---- lead agent (intent → structured action; code executes) -----------------

export type LeadAction =
  | { action: "submit"; goal: string; preset?: string; criteria?: string[]; constraints?: string[] }
  | { action: "attach"; task: number; text: string; urgent?: boolean }
  | { action: "answer"; task: number; option?: string; text?: string }
  | { action: "status"; task?: number }
  | { action: "stop"; task: number }
  | { action: "retry"; task: number; note?: string }
  | { action: "accept"; task: number; note?: string }
  | { action: "config"; patch: PresetPatch; reason?: string; task?: number; verbosity?: Verbosity }
  | { action: "confirm" }
  | { action: "cancel" }
  | { action: "announce"; paragraphs: string[]; reason?: string }
  | { action: "remember"; items: string[] }
  | { action: "forget"; ids: number[] }
  | { action: "chat" }
  | { action: "mode"; mode: ChatMode }
  | { action: "reply"; text: string };

const ACTIONS = ["submit", "attach", "answer", "status", "stop", "retry", "accept", "config", "confirm", "cancel", "announce", "remember", "forget", "chat", "mode", "reply"];

/** One task line for the lead; loop tasks carry their open question so the lead can map a reply onto it */
function leadTaskLine(t: Task, store?: OrcStore): string {
  const head = `- #${t.id} [${t.status}] ${t.kind === "loop" ? "（监督循环）" : ""}${t.title} —— ${t.progress}`;
  if (t.kind !== "loop") {
    const st = acceptable(t);
    return st ? `${head}\n  ⚠️ 卡在${stageName(st.id)}上等人决定：可 retry（再试一次）/ accept（接受这版，继续后面）/ stop（放弃）` : head;
  }
  if (!store) return head;
  const l = store.getLedger<Ledger>(t.id);
  if (!l) return head;
  const roles = `  角色：${Object.values(t.preset.roles).map((r) => `${r.name}=${r.cli}${r.model ? ":" + r.model : ""}`).join("，")}；播报：${l.verbosity}`;
  const ask = l.pendingAsk
    ? `\n  ⚠️ 正在等人回答：${l.pendingAsk.question}\n  选项：${l.pendingAsk.options.map((o) => `${o.id}) ${o.label}`).join("；")}（默认 ${l.pendingAsk.default}）`
    : "";
  return `${head}\n${roles}${ask}`;
}

export function buildLeadPrompt(c: {
  userText: string; presetLine: string; tasks: Task[]; presets: string[]; roles: string[]; history?: string;
  store?: OrcStore; pending?: string; threadTask?: number; mode?: ChatMode; routeWhy?: string;
}): string {
  const tasks = c.tasks.length ? c.tasks.map((t) => leadTaskLine(t, c.store)).join("\n") : "（无）";
  const mode = c.mode ?? "orc";
  const modeLine = mode === "orc"
    ? "本群是编排模式：所有消息都先到你这里。要动手做的事一律 submit 交给团队；chat 只用于闲聊、问答。"
    : `本群是${MODE_LABEL[mode]}模式：这条消息转给你，是因为它看起来和团队任务有关（${c.routeWhy || "规则命中"}）。如果其实只是普通对话、问答，或一个 agent 一轮就能做完的事，用 chat 交回给单 agent。`;
  return [
    "你是本群的 orc 主 agent，只负责**理解意图并选择动作**，不亲自写代码、不改文件。",
    modeLine,
    `当前编排：${c.presetLine}`,
    `可选组合：${c.presets.join(" / ")}（loop = 监督循环：监督者反复下指令、取证、汇报，适合要反复试错、长时间实验、目标可能随讨论调整的任务）；角色库：${c.roles.join(" / ")}`,
    `本群任务：\n${tasks}`,
    c.pending ? `待用户确认的提议：${c.pending}` : "",
    c.history ? `最近对话：\n${c.history}` : "",
    c.threadTask ? `（这条消息是在任务 #${c.threadTask} 卡片的回复串里发的，多半是对这个任务说的）` : "",
    `用户消息：\n${c.userText}`,
    "",
    "从下列动作中选**一个**，只输出一个 JSON 对象（不要别的文字）：",
    '- {"action":"submit","goal":"完整、可独立理解的任务目标（把上下文写进去）","preset":"可选，组合名","criteria":["可选：可检查的验收标准"],"constraints":["可选：必须遵守的约束"]}  —— 用户要团队去做一件新事情；用户说「把刚才这个交给团队」时，从「最近对话」里总结出目标、约束和已有结论',
    '- {"action":"attach","task":12,"text":"给该任务的补充信息","urgent":false}  —— 对进行中任务的补充、纠偏、改口径；监督循环任务会在下一轮看到；urgent=true 表示立刻打断正在干活的 agent',
    '- {"action":"answer","task":12,"option":"a","text":"可选补充"}  —— 用户在回答某个任务「正在等人回答」的问题（选项 id 必须来自该问题；用户只说了想法没选项时 option 省略）',
    '- {"action":"status","task":12}  —— 问进展（task 可省略=全部）',
    '- {"action":"stop","task":12} / {"action":"retry","task":12,"note":"补充说明"}  —— 放弃 / 再试一次（note 里写清人说的哪些要改、哪些不用管）',
    '- {"action":"accept","task":12,"note":"可选"}  —— 任务卡在评审 / 测试上等人决定，人说「接受」「就用这版」「不用改了，继续」：按通过处理，继续后面的环节',
    '- {"action":"config","patch":{"preset":"fix","roles":{"critic":{"cli":"claude","count":1},"tester":null},"enable":["design_review"],"disable":[],"maxLoops":{"review":2}},"reason":"…"}  —— 调整本群之后新任务的编排；只能用角色库里已有的角色（需要用户确认）',
    '- {"action":"config","task":12,"patch":{"roles":{"implementer":{"cli":"cursor","model":"auto"}}},"verbosity":"quiet|normal|verbose","reason":"…"}  —— 调整**进行中**任务的角色模型或播报详细程度，立即生效（下一次运行起）',
    '- {"action":"confirm"} / {"action":"cancel"}  —— 用户同意 / 拒绝「待用户确认的提议」（如“好的”“确认”“算了”）',
    '- {"action":"announce","paragraphs":["要追加到群公告（=本群长期指令）的规则，每段一句"],"reason":"…"}  —— 用户想修改本群的长期约束/规则（人人可见、约束所有 agent 的硬规则）',
    '- {"action":"remember","items":["一句话"]} / {"action":"forget","ids":[3]}  —— 用户要你记住/忘掉本群的背景信息、偏好（软信息，编号见【本群记忆】）；分不清是规则还是记忆时，用 remember',
    '- {"action":"mode","mode":"auto|single|orc"}  —— 用户要切换本群的工作方式：auto=自动判断（默认）；single=只用单 agent；orc=所有消息先经过你、干活都交给团队',
    '- {"action":"chat"}  —— 把这条消息原样交给本群的单 agent（它能读写工作区、续接本群对话）：普通问答、讨论、一轮就能做完的改动或查询',
    '- {"action":"reply","text":"直接回答"}  —— 关于任务 / 编排的简单问题，或意图不清时向用户澄清（宁可问，不要猜）',
  ].filter(Boolean).join("\n");
}

export function parseLeadAction(text: string): LeadAction | { error: string } {
  const objs = findJsonObjects(text || "").filter((o) => typeof o.action === "string" && ACTIONS.includes(o.action));
  const a = objs[objs.length - 1];
  if (!a) return { error: "主 agent 没有给出可识别的动作" };
  const num = (v: any) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  const strs = (v: any) => (Array.isArray(v) ? v.map(String).map((s: string) => s.trim()).filter(Boolean).slice(0, 12) : undefined);
  switch (a.action) {
    case "submit": return typeof a.goal === "string" && a.goal.trim()
      ? { action: "submit", goal: a.goal.trim(), preset: a.preset || undefined, criteria: strs(a.criteria), constraints: strs(a.constraints) }
      : { error: "submit 缺少 goal" };
    case "attach": return num(a.task) && a.text ? { action: "attach", task: num(a.task)!, text: String(a.text), urgent: a.urgent === true } : { error: "attach 缺少 task/text" };
    case "answer": return num(a.task) && (a.option || a.text)
      ? { action: "answer", task: num(a.task)!, option: a.option ? String(a.option) : undefined, text: a.text ? String(a.text) : undefined }
      : { error: "answer 缺少 task 或 option/text" };
    case "status": return { action: "status", task: num(a.task) };
    case "stop": return num(a.task) ? { action: "stop", task: num(a.task)! } : { error: "stop 缺少 task" };
    case "retry": return num(a.task) ? { action: "retry", task: num(a.task)!, note: a.note ? String(a.note) : undefined } : { error: "retry 缺少 task" };
    case "accept": return num(a.task) ? { action: "accept", task: num(a.task)!, note: a.note ? String(a.note) : undefined } : { error: "accept 缺少 task" };
    case "config": {
      const vb = a.verbosity ?? a.patch?.verbosity;
      const verbosity = ["quiet", "normal", "verbose"].includes(vb) ? vb as Verbosity : undefined;
      let patch = a.patch && typeof a.patch === "object" ? { ...a.patch } : undefined;
      if (patch && "verbosity" in patch) { delete patch.verbosity; if (!Object.keys(patch).length) patch = undefined; }
      if (num(a.task) && (patch || verbosity)) return { action: "config", task: num(a.task), patch: patch ?? {}, verbosity, reason: a.reason };
      return patch ? { action: "config", patch, reason: a.reason } : { error: "config 缺少 patch" };
    }
    case "confirm": return { action: "confirm" };
    case "cancel": return { action: "cancel" };
    case "announce": {
      const ps = Array.isArray(a.paragraphs) ? a.paragraphs.map(String).map((s: string) => s.trim()).filter(Boolean) : [];
      return ps.length ? { action: "announce", paragraphs: ps.slice(0, 10), reason: a.reason } : { error: "announce 缺少 paragraphs" };
    }
    case "remember": {
      const raw = Array.isArray(a.items) ? a.items : a.text ? [a.text] : [];
      const items = raw.map(String).map((s: string) => s.trim()).filter(Boolean).slice(0, 10);
      return items.length ? { action: "remember", items } : { error: "remember 缺少 items" };
    }
    case "forget": {
      const ids = (Array.isArray(a.ids) ? a.ids : [a.ids ?? a.id]).map(num).filter((x: number | undefined): x is number => !!x);
      return ids.length ? { action: "forget", ids } : { error: "forget 缺少 ids" };
    }
    case "chat": return { action: "chat" };
    case "mode": {
      const m = String(a.mode ?? "").toLowerCase();
      return m === "auto" || m === "single" || m === "orc" ? { action: "mode", mode: m } : { error: "mode 必须是 auto / single / orc" };
    }
    default: return { action: "reply", text: String(a.text ?? "") };
  }
}

/** Human-readable diff of a preset change for confirmation */
export function describePresetChange(before: ResolvedPreset, after: ResolvedPreset): string {
  return `之前：${presetSummary(before)}\n之后：${presetSummary(after)}`;
}

/** `/stop` in a chat: stop every active orc task of that chat; returns ids stopped */
export function stopChatTasks(chatId: string): number[] {
  if (!orc) return [];
  const ids = orc.store.listTasks({ chatId, status: ["queued", "running", "waiting", "waiting_children", "blocked"], limit: 50 })
    .filter((t) => t.status !== "blocked" || t.kind === "loop")
    .filter((t) => !t.parentId).map((t) => t.id);
  for (const id of ids) orc.stop(id);
  return ids;
}
