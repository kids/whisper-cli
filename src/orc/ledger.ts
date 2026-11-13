// =============================================================================
// orc loop — task ledger, closed action set, code-side guards, prompts (pure)
// =============================================================================
// The ledger is the Supervisor's only memory: every round starts a fresh
// session and rebuilds context from it. The Supervisor *proposes* one action;
// validateAction() decides whether it may run ("LLM proposes, code decides").
// No I/O here — loop.ts executes; everything below is unit-testable.
// =============================================================================
import { findJsonObjects } from "./output";
import { WAKE_ON_HINT } from "../watch";
import type { LoopBudget, Verbosity } from "./types";

export type Who = "human" | "lead" | "supervisor";
export type AskWhy = "irreversible" | "high_cost" | "goal_ambiguous";
export const ASK_WHY: AskWhy[] = ["irreversible", "high_cost", "goal_ambiguous"];

export interface Item { id: string; text: string; by: Who; at: number }
export interface Evidence {
  id: string;
  kind: "verify" | "watch" | "review";
  label: string;
  pass: boolean;
  detail: string;
  /** HEAD when collected */
  sha: string;
  at: number;
  step: number;
  /** 重新规划时作废：结论基于旧口径，不再算数 */
  invalidated?: boolean;
}
export interface PendingAsk {
  step: number;
  question: string;
  why: AskWhy;
  askedAt: number;
  /** 代码自己发起的确认（只有预算这一种），其余都是监督者问的 */
  code?: "budget";
}
export interface Observation { step: number; at: number; kind: string; text: string }
export interface PlanItem { text: string; status: "todo" | "doing" | "done" | "dropped" }
/** Appended by code outside a round (watch fired, role switch); drained into the ledger at the next commit */
export type LoopEvent =
  | { at: number; kind: "watch"; watchId: number; title: string; fireKind: string; reason: string; evidence: string }
  | { at: number; kind: "note"; text: string };

export interface Ledger {
  goal: string;
  criteria: Item[];
  constraints: Item[];
  constraintsVersion: number;
  evidence: Evidence[];
  observations: Observation[];
  /** human messages the Supervisor has not seen yet */
  inbox: { at: number; text: string }[];
  events: LoopEvent[];
  /** recent human messages (quote check for loosening changes) */
  humanLog: { at: number; text: string }[];
  /** answers to irreversible questions; one approval unlocks one irreversible instruct */
  approvals: { step: number; question: string; answer: string; at: number; used?: boolean }[];
  pendingAsk?: PendingAsk;
  /** watch id the task is parked on */
  waitWatch?: number;
  heartbeatS?: number;
  worker: { sessionId?: string; turns: number; rotations: number; epoch: number };
  /** 监督者的长会话：有它就续，没它（首轮 / 轮换）重建一份完整上下文 */
  sup: { sessionId?: string; turns: number };
  /** bumped when a human switches the worker's CLI/model; a new epoch = fresh session */
  workerEpoch: number;
  budget: { steps: number; workerRuns: number; activeMs: number; tokens: number; warned: boolean };
  limits: LoopBudget;
  guard: { infraErrors: number };
  /** HEAD after the latest commit seen */
  head: string;
  /** HEAD after the latest change to the code (worker / recovered / human commit) */
  lastChangeSha: string;
  verbosity: Verbosity;
  seq: { E: number; C: number; K: number };
  step: number;
}

const MAX_OBS = 30;
const MAX_EVIDENCE = 80;
const MAX_HUMAN_LOG = 30;
export const MAX_WORKER_TURNS = Number(process.env.ORC_LOOP_WORKER_TURNS || 15);
/** 连续运行故障（CLI 报错 / 超时）上限，到点判故障而不是问人 */
export const INFRA_LIMIT = 3;
/** 运行故障后的退避基数（离线检查里调小） */
export const RETRY_BASE_MS = Number(process.env.ORC_LOOP_RETRY_MS || 10_000);

export function createLedger(input: {
  goal: string; criteria?: string[]; constraints?: string[]; sourceText?: string; head: string;
  limits: LoopBudget; verbosity: Verbosity; by?: Who;
}): Ledger {
  const now = Date.now();
  const by = input.by ?? "lead";
  const l: Ledger = {
    goal: input.goal, criteria: [], constraints: [], constraintsVersion: 1, evidence: [],
    observations: [], inbox: [], events: [], humanLog: [], approvals: [],
    worker: { turns: 0, rotations: 0, epoch: 0 }, sup: { turns: 0 }, workerEpoch: 0,
    budget: { steps: 0, workerRuns: 0, activeMs: 0, tokens: 0, warned: false },
    limits: { ...input.limits },
    guard: { infraErrors: 0 },
    head: input.head, lastChangeSha: input.head, verbosity: input.verbosity, seq: { E: 0, C: 0, K: 0 }, step: 0,
  };
  for (const t of input.criteria ?? []) if (t.trim()) l.criteria.push({ id: `C${++l.seq.C}`, text: t.trim(), by, at: now });
  for (const t of input.constraints ?? []) if (t.trim()) l.constraints.push({ id: `K${++l.seq.K}`, text: t.trim(), by, at: now });
  if (input.sourceText?.trim()) l.humanLog.push({ at: now, text: input.sourceText.trim() });
  return l;
}

// ---- small mutators -----------------------------------------------------------

export function observe(l: Ledger, step: number, kind: string, text: string): void {
  l.observations.push({ step, at: Date.now(), kind, text: text.slice(0, 4000) });
  if (l.observations.length > MAX_OBS) l.observations.splice(0, l.observations.length - MAX_OBS);
}

export function addEvidence(l: Ledger, e: Omit<Evidence, "id" | "at">): Evidence {
  const ev: Evidence = { ...e, id: `E${++l.seq.E}`, at: Date.now(), detail: e.detail.slice(0, 3000) };
  l.evidence.push(ev);
  if (l.evidence.length > MAX_EVIDENCE) l.evidence.splice(0, l.evidence.length - MAX_EVIDENCE);
  return ev;
}

export function noteHuman(l: Ledger, text: string): void {
  l.humanLog.push({ at: Date.now(), text });
  if (l.humanLog.length > MAX_HUMAN_LOG) l.humanLog.splice(0, l.humanLog.length - MAX_HUMAN_LOG);
}

/** Code changed under the ledger (worker commit, recovered leftovers, a human commit) */
export function codeChanged(l: Ledger, sha: string): void {
  l.head = sha;
  l.lastChangeSha = sha;
}

const DONE_KINDS = ["done", "metrics", "file", "cmd"];

/** Fold queued events into evidence / observations; true if the awaited watch fired */
export function drainEvents(l: Ledger): boolean {
  let fired = false;
  for (const e of l.events ?? []) {
    if (e.kind === "watch") {
      const ev = addEvidence(l, {
        kind: "watch", label: `监控 #${e.watchId} ${e.title}：${e.fireKind}`, pass: DONE_KINDS.includes(e.fireKind),
        detail: `${e.reason}\n${e.evidence}`, sha: l.lastChangeSha, step: l.step,
      });
      observe(l, l.step + 1, "watch", `监控 #${e.watchId}「${e.title}」触发（证据 ${ev.id}）：${e.reason}\n${clip(e.evidence, 2500)}`);
      if (l.waitWatch === e.watchId) { fired = true; l.waitWatch = undefined; l.heartbeatS = undefined; }
    } else {
      observe(l, l.step + 1, "human", e.text);
    }
  }
  l.events = [];
  return fired;
}

export function budgetState(l: Ledger): { exhausted?: string; ratio: number; line: string } {
  const hours = l.budget.activeMs / 3_600_000;
  const r = Math.max(l.budget.steps / l.limits.maxSteps, l.budget.workerRuns / l.limits.maxWorkerRuns, hours / l.limits.maxActiveHours);
  const line = `轮数 ${l.budget.steps}/${l.limits.maxSteps} · worker ${l.budget.workerRuns}/${l.limits.maxWorkerRuns} · 活跃用时 ${hours.toFixed(1)}/${l.limits.maxActiveHours}h`;
  let exhausted: string | undefined;
  if (l.budget.steps >= l.limits.maxSteps) exhausted = `轮数 ${l.budget.steps}/${l.limits.maxSteps}`;
  else if (l.budget.workerRuns >= l.limits.maxWorkerRuns) exhausted = `worker 运行 ${l.budget.workerRuns}/${l.limits.maxWorkerRuns} 次`;
  else if (hours >= l.limits.maxActiveHours) exhausted = `活跃用时 ${hours.toFixed(1)}/${l.limits.maxActiveHours}h`;
  return { exhausted, ratio: r, line };
}

export function extendBudget(l: Ledger, factor = 1.5): void {
  l.limits = {
    maxSteps: Math.ceil(Math.max(l.limits.maxSteps, l.budget.steps) * factor),
    maxWorkerRuns: Math.ceil(Math.max(l.limits.maxWorkerRuns, l.budget.workerRuns) * factor),
    maxActiveHours: +(Math.max(l.limits.maxActiveHours, l.budget.activeMs / 3_600_000) * factor).toFixed(2),
  };
  l.budget.warned = false;
}

export function resetGuards(l: Ledger): void {
  l.guard.infraErrors = 0;
}

/** 唯一的代码主动确认：预算用完要不要继续花钱 */
export function budgetAsk(l: Ledger, detail: string): PendingAsk {
  return { step: l.step, question: `预算用完（${detail}）。要继续吗？继续就追加 50%，不说话就不推进。`, why: "high_cost", code: "budget", askedAt: Date.now() };
}

// ---- 监督者的动作：正文 + 一行标记；不校验、不驳回 ---------------------------
//
// 代码不再要求 JSON、也不再判断模型"合不合约定"：没找到标记就当它还在想，下一轮继续。
// 只有真要执行的事才需要标记；标记内容看不懂也退化成"继续"，不报错、不找人。

export interface VerifyCheck { cmd: string; expect?: string; label?: string; timeoutS?: number }

export type LoopAction =
  | { action: "instruct"; text: string }
  | { action: "replan"; change: ChangeSet }
  | { action: "verify"; checks: VerifyCheck[] }
  | { action: "review"; focus?: string }
  | { action: "wait"; watch?: Record<string, unknown>; keep?: boolean; heartbeat?: string; reason?: string }
  | { action: "ask"; question: string; why: AskWhy }
  | { action: "finish"; summary: string }
  | { action: "abort"; reason: string };

export const ACTION_LABEL: Record<LoopAction["action"], string> = {
  instruct: "下指令", replan: "重新安排", verify: "验证", review: "审查", wait: "等待", ask: "问人", finish: "完成", abort: "放弃",
};

/** 人改了目标 / 验收 / 口径时，监督者给的增量安排；只认认得的字段，其余当说明 */
export interface ChangeSet {
  reason: string;
  /** 整体替换；不给就不动 */
  criteria?: string[];
  constraints?: string[];
  /** 要作废的证据编号（E3 / E3,E5） */
  invalidate?: string[];
  /** 默认 true：重新安排后 worker 开新会话，避免接着旧计划干 */
  resetWorker?: boolean;
  /** 原文，写进账本给人看 */
  text: string;
}

const CHANGE_KEY = /^([a-z_]+)\s*[:：]\s*(.*)$/i;

/** [[replan]] 块：自由文本 + 几个可选字段；认不出的内容原样留在 text 里 */
export function parseChange(body: string): ChangeSet {
  const out: ChangeSet = { reason: "", resetWorker: true, text: body.trim() };
  const lists: Record<string, string[]> = {};
  let key = "";
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kv = CHANGE_KEY.exec(line);
    if (kv) {
      key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === "reason") out.reason = val;
      else if (key === "invalidate") out.invalidate = val.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      else if (key === "reset_worker") out.resetWorker = !/^(0|false|no|不|否)$/i.test(val);
      else if (key === "criteria" || key === "constraints") { lists[key] = val ? [val] : []; if (key === "criteria") out.criteria = lists[key]; else out.constraints = lists[key]; }
      continue;
    }
    if (/^[-*·]\s+/.test(line) && (key === "criteria" || key === "constraints")) {
      const item = line.replace(/^[-*·]\s+/, "").trim();
      lists[key].push(item);
      if (key === "criteria") out.criteria = lists[key]; else out.constraints = lists[key];
      continue;
    }
    if (!out.reason) out.reason = line;
  }
  return out;
}

const SIGNAL_RE = /^[ \t]*\[\[\s*(instruct|replan|verify|review|wait|ask|finish|abort)\s*\]\][ \t]*(.*)$/i;
const CLEAN = (t: string) => t.replace(/^[\s\-*>`]+/, "").replace(/`/g, "").trim();

interface Block { name: string; body: string }

/** 把回复切成"正文 + 若干 [[标记]] 块" */
function signalBlocks(text: string): Block[] {
  const out: Block[] = [];
  let cur: Block | undefined;
  for (const line of (text || "").split(/\r?\n/)) {
    const m = SIGNAL_RE.exec(line);
    if (m) { cur = { name: m[1].toLowerCase(), body: m[2] ?? "" }; out.push(cur); }
    else if (cur) cur.body += `\n${line}`;
  }
  return out.map((b) => ({ name: b.name, body: b.body.trim() }));
}

/** 这一轮想做什么；没有标记 / 标记内容为空 = 它还在想（undefined，不当错误） */
export function parseSignal(text: string): LoopAction | undefined {
  const blocks = signalBlocks(text);
  const b = blocks[blocks.length - 1];
  if (!b || !b.body) return undefined;
  switch (b.name) {
    case "instruct": return { action: "instruct", text: b.body };
    case "replan": return { action: "replan", change: parseChange(b.body) };
    case "verify": {
      const checks = b.body.split(/\r?\n/).map(CLEAN).filter(Boolean).slice(0, 8).map((cmd) => ({ cmd }));
      return checks.length ? { action: "verify", checks } : undefined;
    }
    case "review": return { action: "review", focus: b.body || undefined };
    case "wait": {
      const kv: Record<string, string> = {};
      for (const line of b.body.split(/\r?\n/)) {
        const m = /^([a-z_]+)\s*[:=]\s*(.+)$/i.exec(line.trim());
        if (m) kv[m[1].toLowerCase()] = m[2].trim();
      }
      if (kv.keep && !/^(0|false|no)$/i.test(kv.keep)) return { action: "wait", keep: true, reason: kv.reason };
      const watch: Record<string, unknown> = {};
      if (kv.pid) watch.pid = Number(kv.pid);
      for (const k of ["title", "log", "done", "stale", "every", "timeout", "cmd", "file"] as const) if (kv[k]) watch[k] = kv[k];
      if (kv.wake_on) watch.wake_on = kv.wake_on.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
      if (kv.metrics) watch.metrics = { path: kv.metrics };
      return Object.keys(watch).length ? { action: "wait", watch, heartbeat: kv.heartbeat, reason: kv.reason } : undefined;
    }
    case "ask": {
      const why = (/^why\s*[:=]\s*(irreversible|high_cost|goal_ambiguous)/im.exec(b.body)?.[1] ?? "high_cost") as AskWhy;
      const question = b.body.replace(/^why\s*[:=].*$/gim, "").trim();
      return question ? { action: "ask", question, why } : undefined;
    }
    case "finish": return { action: "finish", summary: b.body };
    case "abort": return { action: "abort", reason: b.body };
  }
  return undefined;
}

/** 把监督者的增量安排落到账本上；返回给人看的变化行 */
export function applyChange(l: Ledger, c: ChangeSet, step: number): string[] {
  const lines: string[] = [];
  const now = Date.now();
  if (c.criteria?.length) {
    const items = c.criteria.map((t) => t.trim()).filter(Boolean);
    if (items.length) { l.criteria = items.map((t, i) => ({ id: `C${i + 1}`, text: t, by: "human", at: now })); l.seq.C = items.length; lines.push(`验收标准改为 ${items.length} 条`); }
  }
  if (c.constraints?.length) {
    const items = c.constraints.map((t) => t.trim()).filter(Boolean);
    if (items.length) { l.constraints = items.map((t, i) => ({ id: `K${i + 1}`, text: t, by: "human", at: now })); l.seq.K = items.length; lines.push(`约束改为 ${items.length} 条`); }
  }
  const ids = c.invalidate ?? [];
  const hit = l.evidence.filter((e) => ids.includes(e.id) || ids.some((x) => x === "all"));
  if (ids.length === 1 && ids[0] === "all") { for (const e of l.evidence) e.invalidated = true; lines.push(`作废全部 ${l.evidence.length} 条旧证据`); }
  else if (hit.length) { for (const e of hit) e.invalidated = true; lines.push(`作废证据 ${hit.map((e) => e.id).join(",")}`); }
  if (c.resetWorker !== false && l.worker.sessionId) { l.worker.sessionId = undefined; l.worker.turns = 0; l.worker.rotations++; lines.push("worker 开新会话（按新安排重来）"); }
  l.constraintsVersion++;
  observe(l, step, "replan", `按新的安排继续（v${l.constraintsVersion}）：${c.reason || c.text.slice(0, 300)}${lines.length ? "\n" + lines.join("；") : ""}`);
  return lines;
}

// ---- 不可逆操作（唯一保留的"看内容"规则）-----------------------------------

const IRREVERSIBLE: [RegExp, string][] = [
  [/\bgit\s+push\b/i, "git push"],
  [/\b(kubectl|helm)\s+(apply|delete|upgrade|install|rollout|scale)\b/i, "改动集群"],
  [/\bdeploy\b|部署|上线|发布到|发版/i, "部署 / 上线"],
  [/\brm\s+-[a-z]*r[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, "删除根目录或家目录"],
  [/\b(drop|truncate)\s+(table|database|schema)\b/i, "删库 / 删表"],
  [/删除(线上|生产|远端)?数据|清空(数据库|表|桶)/, "删除数据"],
  [/对外(发送|发布)|发(邮件|消息)给(客户|用户|外部)/, "对外发消息"],
];
const NEGATION = /(不要|不能|别|禁止|不得|勿|切勿|无需|不用|don't|do not|never|no)\s*$/i;

/** First irreversible operation a text asks for (negated mentions like "不要 git push" don't count) */
export function irreversibleHit(text: string): string | undefined {
  for (const [re, label] of IRREVERSIBLE) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      const before = text.slice(Math.max(0, (m.index ?? 0) - 10), m.index ?? 0);
      if (!NEGATION.test(before)) return label;
    }
  }
  return undefined;
}

// ---- prompts ------------------------------------------------------------------

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);
export { clip };

function criteriaBlock(l: Ledger): string {
  if (!l.criteria.length) return "（还没有）";
  return l.criteria.map((c) => `- ${c.id} ${c.text}`).join("\n");
}

function constraintsBlock(l: Ledger): string {
  return l.constraints.length ? l.constraints.map((c) => `- ${c.id} ${c.text}`).join("\n") : "（无额外约束；群公告和群记忆见系统提示）";
}

export function evidenceLine(e: Evidence, l: Ledger): string {
  const at = e.invalidated ? "已作废（重新安排前采的）" : e.sha === l.lastChangeSha ? "当前版本" : `旧版本 ${e.sha.slice(0, 7)}`;
  return `- ${e.id} ${e.pass ? "✓" : "✗"} ${e.kind} ${clip(e.label, 120)}（${at}，第 ${e.step} 轮）\n  ${clip(e.detail.replace(/\n+/g, " ⏎ "), 300)}`;
}

export interface SupervisorCtx {
  taskId: number;
  title: string;
  worktree: string;
  branch: string;
  diffStat: string;
  worker: string;
  reviewer?: string;
  reason: string;
  waiting?: string;
  canWait: boolean;
  /** 首轮 / 轮换：给完整上下文；续接的会话只给这一轮的增量 */
  fresh: boolean;
}

const SIGNAL_HINT = `## 要做的事写成一行标记（不写 = 你还在想，下一轮接着问你）
- \`[[instruct]]\` 给 worker 的具体指令，可以多行
- \`[[replan]]\` 人改了目标 / 验收 / 口径时，先重新安排再继续：reason: 一句原因；criteria: / constraints: 后面每行 - 一条（整体替换）；invalidate: E3,E5 作废旧证据；reset_worker: no 可以保留 worker 会话
- \`[[verify]]\` 你自己要跑的只读命令，一行一条
- \`[[review]]\` 可选：换一个模型审当前改动，这一行后面写审查重点
- \`[[wait]]\` 挂起等长作业，后面写 key=value：pid=123 / log=out/train.log / done=训练完成 / stale=30m / every=5m / timeout=2d；巡检正常写 \`[[wait]]\` 再一行 keep=1
- \`[[ask]]\` 只有不可逆、高成本或目标有歧义才用，第一行可写 why=irreversible
- \`[[finish]]\` 结论
- \`[[abort]]\` 为什么放弃

正文随便写，不用 JSON，也没有格式要求。`;

export function buildSupervisorPrompt(l: Ledger, c: SupervisorCtx): string {
  const b = budgetState(l);
  if (!c.fresh) {
    const recent = l.observations.slice(-6);
    return [
      `第 ${l.step + 1} 轮（接着上一轮说）。`,
      `起因：${c.reason}`,
      c.waiting ? `正在等待：${c.waiting}` : "",
      `## 自上一轮以来\n${recent.length ? recent.map((o) => `- [第 ${o.step} 轮 · ${o.kind}] ${clip(o.text, 800)}`).join("\n") : "（没有新情况）"}`,
      l.pendingAsk ? `待人回答：${l.pendingAsk.question}` : "",
      `## 现在\n按你的判断继续：给 worker 写 \`[[instruct]]\`、自己跑 \`[[verify]]\`、\`[[review]]\`、\`[[wait]]\`、\`[[finish]]\`、\`[[abort]]\`；只有不可逆或高成本才 \`[[ask]]\`。人这句话如果改了目标 / 验收 / 口径，先写 \`[[replan]]\` 再继续。`,
      `预算：${b.line}`,
    ].filter(Boolean).join("\n\n");
  }
  const obs = l.observations.slice(-8);
  const out: string[] = [];
  out.push(`你是 orc 任务 #${c.taskId}「${c.title}」的监督者。你不亲自改代码：看现场、给 worker 下指令、自己跑只读命令取证、判断什么时候收尾。工作区 \`${c.worktree}\`（分支 \`${c.branch}\`），你可以用只读工具随便看。`);
  out.push(`## 目标\n${l.goal}`);
  out.push(`## 验收标准\n${criteriaBlock(l)}`);
  out.push(`## 约束（v${l.constraintsVersion}）\n${constraintsBlock(l)}\n群公告和群记忆在系统提示里，同样必须遵守。`);
  out.push([
    `## 当前状态`,
    `HEAD \`${l.head.slice(0, 12)}\`；相对起点的改动：${c.diffStat ? "\n```\n" + clip(c.diffStat, 1500) + "\n```" : "无"}`,
    `worker：${c.worker}${l.worker.sessionId ? `（会话已续接 ${l.worker.turns} 轮）` : "（下一条指令开新会话）"}${c.reviewer ? `；可叫审查：${c.reviewer}` : ""}`,
    c.waiting ? `正在等待：${c.waiting}` : "",
    `预算：${b.line}${b.ratio >= 0.8 ? "（已用 80% 以上，抓紧收敛）" : ""}`,
  ].filter(Boolean).join("\n"));
  out.push(`## 最近观测（旧 → 新）\n${obs.length ? obs.map((o) => `[第 ${o.step} 轮 · ${o.kind}] ${clip(o.text, 1200)}`).join("\n\n") : "（无）"}`);
  out.push(SIGNAL_HINT);
  out.push([
    `## 怎么干（你自己判断，代码不检查）`,
    "- 不信 worker 的自报：它说做完了，你自己看 diff、跑命令确认。",
    "- 长作业（训练、批处理）让 worker 后台跑并报 pid 和日志，然后 `[[wait]]`；等的时候盯着，跑偏了就 `[[instruct]]` 让它停掉改。",
    "- 能自己定的事别问人；只有不可逆（推送、部署、删数据、对外发消息）、高成本或目标本身有歧义才 `[[ask]]`。",
    "- 收尾 `[[finish]]` + 一句话结论；放弃 `[[abort]]` + 原因和试过什么。",
  ].join("\n"));
  return out.join("\n\n");
}

export function buildWorkerPrompt(l: Ledger, text: string, o: { taskId: number; fresh: boolean; rolePrompt: string; branch: string }): string {
  const out: string[] = [];
  out.push(`# orc 任务 #${o.taskId} · 你是执行者（worker），按监督者的指令干活`);
  if (o.fresh) {
    out.push(`## 任务目标\n${l.goal}`);
    const recent = l.observations.slice(-6);
    const ctx = recent.length ? `最近进展：\n${recent.map((r) => `- [${r.kind}] ${clip(r.text.replace(/\n+/g, " "), 300)}`).join("\n")}` : "";
    if (ctx) out.push(`## 到目前为止（你是新会话，这是交接摘要）\n${ctx}`);
  }
  out.push(`## 验收标准\n${criteriaBlock(l)}`);
  out.push(`## 约束（v${l.constraintsVersion}，必须遵守）\n${constraintsBlock(l)}`);
  out.push(`## 本轮指令\n${text}`);
  out.push(`## 工作区\n当前目录是本任务专用的 git worktree（分支 \`${o.branch}\`）。只在这里工作；不要 git commit / push，orc 会在你结束后提交。`);
  out.push(`## 角色说明\n${o.rolePrompt}`);
  out.push([
    "## 长时间作业",
    "需要跑很久的程序（训练、批处理、超过几分钟的脚本）不要在前台等：用 `setsid nohup <命令> > <日志> 2>&1 < /dev/null & echo $!` 在后台启动，确认已经开始输出后就结束本轮，并写一行 `[[note]] 后台作业 pid=… 日志=…`，监督者会负责等待。",
  ].join("\n"));
  out.push(`## 输出约定（必须遵守）\n最后**单独一行**写结论（这是唯一判定依据，不要放进代码块）：\n[[done]] 做了什么、怎么验证的\n或\n[[blocked]] 卡在哪、需要人做什么\n- 想留笔记（含后台作业的 pid / 日志）就单独写 [[note]] 一句话，可以写多行。\n- 只有缺信息、缺权限、需要人做决定时才用 [[blocked]]。`);
  return out.join("\n\n");
}

export function buildReviewPrompt(l: Ledger, o: { taskId: number; rolePrompt: string; contract: string; diff: { stat: string; diff: string; log: string }; focus?: string }): string {
  return [
    `# orc 任务 #${o.taskId} · 审查当前改动`,
    `## 目标\n${l.goal}`,
    `## 验收标准\n${criteriaBlock(l)}`,
    `## 约束（v${l.constraintsVersion}）\n${constraintsBlock(l)}`,
    o.focus ? `## 本次审查重点\n${o.focus}` : "",
    `## 相对基线的改动\n提交：\n\`\`\`\n${o.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${o.diff.stat || "(无改动)"}\n\`\`\``,
    o.diff.diff ? `\`\`\`diff\n${o.diff.diff}\n\`\`\`` : "",
    `## 角色说明\n${o.rolePrompt}`,
    `## 输出约定（必须遵守）\n最后一条回复要给出结论：\n${o.contract}`,
  ].filter(Boolean).join("\n\n");
}
