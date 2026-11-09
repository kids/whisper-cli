// =============================================================================
// orc ↔ chat glue: per-chat mode/preset profile, one shared Orchestrator per
// process, progress cards, notifications, lead-agent action parsing (002 §2–§3)
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FeishuClient } from "../platform/feishu";
import type { AgentConfig } from "../types";
import { getChatInstructions } from "../announcement";
import { formatMemory, joinInstructions } from "../memory";
import { applyPatch, loadPresets, loadRoles, presetSummary, resolvePreset } from "./config";
import { findJsonObjects } from "./output";
import { CliExecutor, type ExecutorBins } from "./runner";
import { Orchestrator } from "./scheduler";
import { OrcStore } from "./store";
import type { PresetPatch, ResolvedPreset, Task } from "./types";
import { TERMINAL } from "./types";

export const ORC_HOME = process.env.ORC_HOME || resolve(process.env.HOME || "/root", ".orc");
const PROFILES_PATH = resolve(import.meta.dirname, "../../state/orc-chats.json");

// ---- chat profiles ----------------------------------------------------------

export interface ChatProfile {
  mode: "single" | "orc";
  preset: string;
  patch: PresetPatch;
  version: number;
  /** Proposed by the lead agent, applied only after `/orc confirm` */
  pending?: { kind: "config"; patch: PresetPatch } | { kind: "announce"; paragraphs: string[]; revision: number };
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
  return loadProfiles()[chatId] ?? { mode: "single", preset: "dev", patch: {}, version: 1 };
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
  return resolvePreset(def, roles, { version: p.version + (extra ? 1 : 0), availableClis: available as any });
}

export function listPresetSummaries(): string[] {
  const roles = loadRoles();
  return [...loadPresets().values()].map((p) => {
    try { return `• \`${p.name}\` ${p.description}\n  ${presetSummary(resolvePreset(p, roles))}`; }
    catch (e) { return `• \`${p.name}\` ⚠️ ${(e as Error).message}`; }
  });
}

// ---- shared orchestrator ----------------------------------------------------

const chatClients = new Map<string, FeishuClient>();
const cards = new Map<number, string>();          // taskId → progress card message id
const cardTouched = new Map<number, number>();
const CARD_THROTTLE_MS = Number(process.env.ORC_CARD_THROTTLE_MS || 30_000);
let orc: Orchestrator | null = null;
let executor: CliExecutor | null = null;

export function bindChat(chatId: string, feishu: FeishuClient): void {
  chatClients.set(chatId, feishu);
}

export function renderCard(t: Task, store: OrcStore): string {
  const stage = t.preset.stages[Math.min(t.stageIdx, t.preset.stages.length - 1)];
  const icon = { queued: "⏳", running: "🛠", waiting_children: "🧩", ready: "✅", blocked: "✋", failed: "❌", dropped: "🛑" }[t.status];
  const mins = Math.round((Date.now() - t.createdAt) / 60_000);
  const lines = [
    `**${icon} #${t.id} ${t.title}**`,
    `${t.preset.name} · 阶段 ${t.status === "ready" ? "完成" : `${stage.id}(${t.stageIdx + 1}/${t.preset.stages.length})`} · ${t.status} · ${mins}m`,
  ];
  const loops = Object.entries(t.loops).filter(([k]) => !k.includes(":"));
  if (loops.length) lines.push(`退回：${loops.map(([k, v]) => `${k} ${v}/${t.preset.stages.find((s) => s.id === k)?.maxLoops ?? "?"}`).join("，")}`);
  lines.push(`最近：${t.progress || "-"}`);
  const atts = store.listAttempts(t.id).slice(-6);
  if (atts.length) {
    lines.push("", ...atts.map((a) => {
      const mark = a.status === "running" ? "▶" : a.parsed?.pass ? "✓" : a.status === "done" ? "✗" : "·";
      return `${mark} ${a.stageId}/${a.role} \`${a.cli}${a.model ? ":" + a.model : ""}\` ${(a.parsed?.summary || a.progress || a.error || "").slice(0, 80)}`;
    }));
  }
  if (t.branch) lines.push("", `分支 \`${t.branch}\``);
  return lines.join("\n");
}

async function refreshCard(t: Task, force = false): Promise<void> {
  const feishu = t.chatId ? chatClients.get(t.chatId) : undefined;
  const cardId = cards.get(t.id);
  if (!feishu || !cardId || !orc) return;
  const now = Date.now();
  if (!force && now - (cardTouched.get(t.id) ?? 0) < CARD_THROTTLE_MS) return;
  cardTouched.set(t.id, now);
  await feishu.updateCardMessage(cardId, renderCard(t, orc.store)).catch(() => {});
}

export function getOrc(agents: AgentConfig[], bins: ExecutorBins): Orchestrator {
  if (orc) return orc;
  mkdirSync(ORC_HOME, { recursive: true });
  executor = new CliExecutor(agents, bins);
  orc = new Orchestrator(new OrcStore(resolve(ORC_HOME, "orc.db")), executor, {
    orcHome: ORC_HOME,
    instructionsFor: async (t) => {
      if (!t.chatId) return undefined;
      const f = chatClients.get(t.chatId);
      const ann = f ? await getChatInstructions(f.getClient(), t.chatId) : undefined;
      return joinInstructions(ann, formatMemory(t.chatId)); // workers read group memory, never write it
    },
    onProgress: (t) => void refreshCard(t, TERMINAL.includes(t.status)),
    notify: async (t, n) => {
      const f = t.chatId ? chatClients.get(t.chatId) : undefined;
      if (!f || !t.chatId) return; // CLI-submitted task: nothing to deliver
      await refreshCard(t, true);
      const head = { ready: "✅ 结果可用", decision: "✋ 需要你决定", failed: "❌ 无法继续", info: "ℹ️" }[n.kind];
      const tail = n.kind === "decision" ? `\n\n回复 \`/task retry ${t.id} [补充说明]\` 重试，或 \`/task stop ${t.id}\` 放弃。` : "";
      await f.sendMarkdown(t.chatId, `**${head} · #${t.id} ${t.title}**\n\n${n.text}${tail}`);
    },
  });
  orc.start();
  return orc;
}

export function availableClis(): string[] {
  return executor?.available() ?? [];
}

/** Submit from chat: posts the progress card and binds it to the task */
export async function submitFromChat(o: Orchestrator, feishu: FeishuClient, chatId: string, goal: string, repo: string, preset: ResolvedPreset): Promise<Task> {
  bindChat(chatId, feishu);
  const task = o.submit({ goal, repo, preset, chatId });
  const cardId = await feishu.sendCardAndGetId(chatId, renderCard(task, o.store)).catch(() => undefined);
  if (cardId) cards.set(task.id, cardId);
  return task;
}

/** One-line-per-task summary of this chat's active orc tasks (for single-mode prompts) */
export function activeTaskSummary(chatId: string): string | undefined {
  if (!orc) return undefined;
  const ts = orc.store.listTasks({ chatId, status: ["queued", "running", "waiting_children", "blocked"], limit: 5 });
  if (!ts.length) return undefined;
  return "【本群后台 orc 任务】\n" + ts.map((t) => `- #${t.id} [${t.status}] ${t.title}：${t.progress}`).join("\n");
}

// ---- lead agent (intent → structured action; code executes) -----------------

export type LeadAction =
  | { action: "submit"; goal: string; preset?: string }
  | { action: "attach"; task: number; text: string; urgent?: boolean }
  | { action: "status"; task?: number }
  | { action: "stop"; task: number }
  | { action: "retry"; task: number; note?: string }
  | { action: "config"; patch: PresetPatch; reason?: string }
  | { action: "announce"; paragraphs: string[]; reason?: string }
  | { action: "remember"; items: string[] }
  | { action: "forget"; ids: number[] }
  | { action: "reply"; text: string };

const ACTIONS = ["submit", "attach", "status", "stop", "retry", "config", "announce", "remember", "forget", "reply"];

export function buildLeadPrompt(c: {
  userText: string; presetLine: string; tasks: Task[]; presets: string[]; roles: string[]; history?: string;
}): string {
  const tasks = c.tasks.length
    ? c.tasks.map((t) => `- #${t.id} [${t.status}] ${t.title} —— ${t.progress}`).join("\n")
    : "（无）";
  return [
    "你是本群的 orc 主 agent，只负责**理解意图并选择动作**，不亲自写代码、不改文件。",
    `当前编排：${c.presetLine}`,
    `可选组合：${c.presets.join(" / ")}；角色库：${c.roles.join(" / ")}`,
    `本群任务：\n${tasks}`,
    c.history ? `最近对话：\n${c.history}` : "",
    `用户消息：\n${c.userText}`,
    "",
    "从下列动作中选**一个**，只输出一个 JSON 对象（不要别的文字）：",
    '- {"action":"submit","goal":"完整、可独立理解的任务目标（把上下文写进去）","preset":"可选，组合名"}  —— 用户要团队去做一件新事情',
    '- {"action":"attach","task":12,"text":"给该任务的补充信息","urgent":false}  —— 对进行中任务的补充/纠偏；urgent=true 表示要立刻打断改方向',
    '- {"action":"status","task":12}  —— 问进展（task 可省略=全部）',
    '- {"action":"stop","task":12} / {"action":"retry","task":12,"note":"补充说明"}',
    '- {"action":"config","patch":{"preset":"fix","roles":{"critic":{"cli":"claude","count":1},"tester":null},"enable":["design_review"],"disable":[],"maxLoops":{"review":2}},"reason":"…"}  —— 调整编排；只能用角色库里已有的角色',
    '- {"action":"announce","paragraphs":["要追加到群公告（=本群长期指令）的规则，每段一句"],"reason":"…"}  —— 用户想修改本群的长期约束/规则（人人可见、约束所有 agent 的硬规则）',
    '- {"action":"remember","items":["一句话"]} / {"action":"forget","ids":[3]}  —— 用户要你记住/忘掉本群的背景信息、偏好（软信息，编号见【本群记忆】）；分不清是规则还是记忆时，用 remember',
    '- {"action":"reply","text":"直接回答"}  —— 闲聊、简单问题、或意图不清时向用户澄清（宁可问，不要猜）',
  ].filter(Boolean).join("\n");
}

export function parseLeadAction(text: string): LeadAction | { error: string } {
  const objs = findJsonObjects(text || "").filter((o) => typeof o.action === "string" && ACTIONS.includes(o.action));
  const a = objs[objs.length - 1];
  if (!a) return { error: "主 agent 没有给出可识别的动作" };
  const num = (v: any) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  switch (a.action) {
    case "submit": return typeof a.goal === "string" && a.goal.trim() ? { action: "submit", goal: a.goal.trim(), preset: a.preset || undefined } : { error: "submit 缺少 goal" };
    case "attach": return num(a.task) && a.text ? { action: "attach", task: num(a.task)!, text: String(a.text), urgent: a.urgent === true } : { error: "attach 缺少 task/text" };
    case "status": return { action: "status", task: num(a.task) };
    case "stop": return num(a.task) ? { action: "stop", task: num(a.task)! } : { error: "stop 缺少 task" };
    case "retry": return num(a.task) ? { action: "retry", task: num(a.task)!, note: a.note ? String(a.note) : undefined } : { error: "retry 缺少 task" };
    case "config": return a.patch && typeof a.patch === "object" ? { action: "config", patch: a.patch, reason: a.reason } : { error: "config 缺少 patch" };
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
  const ids = orc.store.listTasks({ chatId, status: ["queued", "running", "waiting_children"], limit: 50 })
    .filter((t) => !t.parentId).map((t) => t.id);
  for (const id of ids) orc.stop(id);
  return ids;
}
