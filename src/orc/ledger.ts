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
  /** HEAD when collected — finish only accepts evidence at the current HEAD */
  sha: string;
  at: number;
  step: number;
}
/** go=true: picking this option approves the irreversible operation in question */
export interface AskOption { id: string; label: string; consequence?: string; go?: boolean }
export interface PendingAsk {
  step: number;
  question: string;
  why: AskWhy;
  options: AskOption[];
  askedAt: number;
  /** raised by code (guards), not by the Supervisor */
  code?: "budget" | "idle" | "errors" | "invalid";
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
  plan: PlanItem[];
  decisions: { step: number; text: string; at: number }[];
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
  /** bumped when a human switches the worker's CLI/model; a new epoch = fresh session */
  workerEpoch: number;
  budget: { steps: number; workerRuns: number; activeMs: number; tokens: number; warned: boolean };
  limits: LoopBudget;
  guard: { idleStreak: number; lastSig: string; errorCounts: Record<string, number>; invalidStreak: number; infraErrors: number; lastAction?: string };
  /** HEAD after the latest commit seen */
  head: string;
  /** HEAD after the latest change to the code (worker / recovered / human commit) */
  lastChangeSha: string;
  verbosity: Verbosity;
  seq: { E: number; C: number; K: number };
  step: number;
  /** why the last proposal was rejected (shown once) */
  rejection?: string;
}

const MAX_OBS = 30;
const MAX_EVIDENCE = 80;
const MAX_HUMAN_LOG = 30;
export const MAX_WORKER_TURNS = Number(process.env.ORC_LOOP_WORKER_TURNS || 15);
export const IDLE_LIMIT = 4;
export const ERROR_HINT_AT = 3;
export const ERROR_ASK_AT = 5;
export const INVALID_LIMIT = 3;

export function createLedger(input: {
  goal: string; criteria?: string[]; constraints?: string[]; sourceText?: string; head: string;
  limits: LoopBudget; verbosity: Verbosity; by?: Who;
}): Ledger {
  const now = Date.now();
  const by = input.by ?? "lead";
  const l: Ledger = {
    goal: input.goal, criteria: [], constraints: [], constraintsVersion: 1, plan: [], decisions: [], evidence: [],
    observations: [], inbox: [], events: [], humanLog: [], approvals: [],
    worker: { turns: 0, rotations: 0, epoch: 0 }, workerEpoch: 0,
    budget: { steps: 0, workerRuns: 0, activeMs: 0, tokens: 0, warned: false },
    limits: { ...input.limits },
    guard: { idleStreak: 0, lastSig: "", errorCounts: {}, invalidStreak: 0, infraErrors: 0 },
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

export function currentEvidence(l: Ledger): Evidence[] {
  return l.evidence.filter((e) => e.sha === l.lastChangeSha);
}

/** Progress signature for idle detection: code, evidence outcomes, constraints, criteria, plan */
export function progressSig(l: Ledger): string {
  return JSON.stringify([
    l.head, l.evidence.slice(-12).map((e) => `${e.label}:${e.pass}`), l.constraintsVersion, l.criteria.length,
    l.plan.map((p) => p.status),
  ]);
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
  l.guard.idleStreak = 0;
  l.guard.errorCounts = {};
  l.guard.invalidStreak = 0;
  l.guard.infraErrors = 0;
  l.guard.lastSig = "";
}

/** Question raised by a guard (budget / idle / repeated error / invalid proposals) */
export function guardAsk(l: Ledger, code: NonNullable<PendingAsk["code"]>, detail: string): PendingAsk {
  const q = {
    budget: `预算用完（${detail}）。要追加预算继续吗？`,
    idle: `连续 ${IDLE_LIMIT} 轮没有新进展（没有新改动、新证据或约束变化）。${detail}`,
    errors: `同一个错误已经出现 ${ERROR_ASK_AT} 次：${detail}`,
    invalid: `监督者连续 ${INVALID_LIMIT} 次给出无效动作：${detail}`,
  }[code];
  const go = code === "budget" ? { id: "more", label: "追加 50% 预算继续" } : { id: "continue", label: "继续，让监督者换个思路（可以顺便告诉它怎么做）" };
  return {
    step: l.step, question: q, why: "high_cost", code, askedAt: Date.now(),
    options: [go, { id: "stop", label: "停下（分支和进展保留，之后可以重试）" }],
  };
}

// ---- actions ------------------------------------------------------------------

export interface Change { op: "add" | "modify" | "remove"; target: "constraint" | "criterion"; id?: string; text?: string }
export interface VerifyCheck { cmd: string; expect?: string; label?: string; timeoutS?: number }

interface Common { plan?: PlanItem[]; decision?: string }
export type LoopAction = Common & (
  | { action: "instruct"; text: string; fresh?: boolean }
  | { action: "verify"; checks: VerifyCheck[] }
  | { action: "report"; progress: string; findings?: string[]; suggestion?: string }
  | { action: "update_constraints"; changes: Change[]; reason: string; source: "human" | "evidence" | "supervisor"; quote?: string }
  | { action: "review"; focus?: string }
  | { action: "wait"; watch?: any; keep?: boolean; heartbeat?: string; reason?: string }
  | { action: "ask"; question: string; why: AskWhy; options: AskOption[] }
  | { action: "finish"; summary: string; acceptance: { criterion: string; evidence: string }[] }
  | { action: "abort"; reason: string; tried: string[]; blockers: string[]; unmet: string[]; resume_hint?: string }
);
export type ActionName = LoopAction["action"];
export const ACTIONS: ActionName[] = ["instruct", "verify", "report", "update_constraints", "review", "wait", "ask", "finish", "abort"];
export const ACTION_LABEL: Record<ActionName, string> = {
  instruct: "下指令", verify: "验证", report: "汇报", update_constraints: "更新约束", review: "审查",
  wait: "等待", ask: "问人", finish: "完成", abort: "放弃",
};

const s = (v: any) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const sl = (v: any): string[] => (Array.isArray(v) ? v.map(s).filter(Boolean) : typeof v === "string" && v.trim() ? [v.trim()] : []);

/** Last JSON object with a known "action" → normalized action, or a parse error */
export function parseLoopAction(text: string): LoopAction | { error: string } {
  const objs = findJsonObjects(text || "").filter((o) => typeof o.action === "string");
  const v = objs[objs.length - 1];
  if (!v) return { error: "回复里没有包含 \"action\" 字段的 JSON 对象" };
  const name = s(v.action) as ActionName;
  if (!ACTIONS.includes(name)) return { error: `未知动作 "${v.action}"，只能是 ${ACTIONS.join(" / ")}` };
  const common: Common = {};
  if (Array.isArray(v.plan)) {
    common.plan = v.plan.slice(0, 15).map((p: any) => typeof p === "string" ? { text: p, status: "todo" } : {
      text: s(p?.text), status: (["todo", "doing", "done", "dropped"].includes(p?.status) ? p.status : "todo"),
    }).filter((p: PlanItem) => p.text);
  }
  if (s(v.decision)) common.decision = s(v.decision).slice(0, 300);
  switch (name) {
    case "instruct": return { ...common, action: name, text: s(v.text), fresh: v.fresh === true };
    case "verify": {
      const raw = Array.isArray(v.checks) ? v.checks : v.cmd ? [{ cmd: v.cmd, expect: v.expect }] : [];
      const checks = raw.map((c: any) => typeof c === "string" ? { cmd: c.trim() } : {
        cmd: s(c?.cmd), expect: s(c?.expect) || undefined, label: s(c?.label) || undefined,
        timeoutS: Number.isFinite(Number(c?.timeout_s ?? c?.timeoutS)) ? Number(c?.timeout_s ?? c?.timeoutS) : undefined,
      });
      return { ...common, action: name, checks };
    }
    case "report": return { ...common, action: name, progress: s(v.progress ?? v.summary), findings: sl(v.findings), suggestion: s(v.suggestion) || undefined };
    case "update_constraints": {
      const changes: Change[] = (Array.isArray(v.changes) ? v.changes : []).map((c: any) => ({
        op: s(c?.op) as Change["op"], target: (s(c?.target) || "constraint") as Change["target"],
        id: s(c?.id) || undefined, text: s(c?.text) || undefined,
      }));
      return { ...common, action: name, changes, reason: s(v.reason), source: (s(v.source) || "supervisor") as any, quote: s(v.quote) || undefined };
    }
    case "review": return { ...common, action: name, focus: s(v.focus) || undefined };
    case "wait": return { ...common, action: name, watch: v.watch, keep: v.keep === true, heartbeat: s(v.heartbeat) || undefined, reason: s(v.reason) || undefined };
    case "ask": {
      const options: AskOption[] = (Array.isArray(v.options) ? v.options : []).map((o: any, i: number) => typeof o === "string"
        ? { id: String.fromCharCode(97 + i), label: o.trim() }
        : { id: s(o?.id) || String.fromCharCode(97 + i), label: s(o?.label ?? o?.text), consequence: s(o?.consequence) || undefined, go: o?.go === true || undefined });
      return { ...common, action: name, question: s(v.question), why: s(v.why) as AskWhy, options };
    }
    case "finish": {
      const acceptance = (Array.isArray(v.acceptance) ? v.acceptance : []).map((a: any) => ({ criterion: s(a?.criterion ?? a?.id), evidence: s(a?.evidence ?? a?.evidence_ref) }));
      return { ...common, action: name, summary: s(v.summary), acceptance };
    }
    case "abort": return { ...common, action: name, reason: s(v.reason), tried: sl(v.tried), blockers: sl(v.blockers), unmet: sl(v.unmet), resume_hint: s(v.resume_hint) || undefined };
  }
}

// ---- guards -----------------------------------------------------------------

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

const norm = (t: string) => t.replace(/\s+/g, "").toLowerCase();

export interface ValidateCtx {
  hasReviewer: boolean;
  requireReview: boolean;
  /** task bound to a chat whose bot can run watches */
  canWait: boolean;
  /** validate a watch spec (throws with a reason) */
  checkWatch?: (raw: any) => void;
}

/** undefined = accepted; string = why the proposal is rejected (fed back next round) */
export function validateAction(l: Ledger, a: LoopAction, ctx: ValidateCtx): string | undefined {
  switch (a.action) {
    case "instruct": {
      if (!a.text) return "instruct 缺少 text";
      const hit = irreversibleHit(a.text);
      if (hit && !l.approvals.some((x) => !x.used)) return `这条指令涉及不可逆操作（${hit}），先用 ask（why=irreversible）征得人的同意`;
      return undefined;
    }
    case "verify": {
      if (!a.checks.length) return "verify 至少要有一条 checks";
      if (a.checks.length > 8) return "verify 一次最多 8 条检查";
      for (const c of a.checks) {
        if (!c.cmd) return "verify 的每条检查都要有 cmd";
        const hit = irreversibleHit(c.cmd);
        if (hit) return `验证命令必须是只读的，这条涉及不可逆操作（${hit}）：${c.cmd}`;
        if (c.expect) { try { new RegExp(c.expect, "i"); } catch { return `expect 不是合法正则：${c.expect}`; } }
        if (c.timeoutS != null && !(c.timeoutS > 0 && c.timeoutS <= 1800)) return "timeout_s 必须在 1..1800 之间；更久的作业让 worker 后台启动，再用 wait";
      }
      return undefined;
    }
    case "report": {
      if (!a.progress) return "report 缺少 progress";
      if (l.guard.lastAction === "report") return "不能连续两轮都 report；先推进工作（instruct / verify / review），有新进展再汇报";
      return undefined;
    }
    case "update_constraints": {
      if (!a.changes.length) return "update_constraints 缺少 changes";
      if (!a.reason) return "update_constraints 必须写 reason";
      for (const c of a.changes) {
        if (!["add", "modify", "remove"].includes(c.op)) return `change.op 只能是 add / modify / remove`;
        if (!["constraint", "criterion"].includes(c.target)) return `change.target 只能是 constraint / criterion`;
        const list = c.target === "criterion" ? l.criteria : l.constraints;
        if (c.op === "add" && !c.text) return "add 需要 text";
        if (c.op !== "add") {
          if (!c.id || !list.some((x) => x.id === c.id)) return `${c.op} 需要已有的 id（${list.map((x) => x.id).join(", ") || "当前为空"}）`;
          if (c.op === "modify" && !c.text) return "modify 需要 text";
        }
        // add = tightening (free); modify/remove = may loosen → only on a human's word
        if (c.op !== "add") {
          if (a.source !== "human") return `${c.op} ${c.id} 可能放宽要求，只能由人提出：source 填 human 并在 quote 里引用人的原话；不是人提的就先 ask`;
          const q = norm(a.quote ?? "");
          if (q.length < 2 || !l.humanLog.some((h) => norm(h.text).includes(q))) return "quote 必须原样引用人说过的话（在最近的人类消息里找不到）";
        }
      }
      return undefined;
    }
    case "review": return ctx.hasReviewer ? undefined : "这个组合没有配置审查角色，不能 review";
    case "wait": {
      if (!ctx.canWait) return "这个任务没有绑定群，无法挂起等待；让 worker 在前台完成，或拆成更短的步骤";
      if (a.keep) return l.waitWatch ? undefined : "当前没有在等待的监控，keep 无效";
      if (!a.watch || typeof a.watch !== "object") return "wait 需要 watch（至少 pid / log / metrics / file / cmd 之一）";
      try { ctx.checkWatch?.(a.watch); } catch (e) { return `watch 不合法：${(e as Error).message}`; }
      return undefined;
    }
    case "ask": {
      if (!a.question) return "ask 缺少 question";
      if (!ASK_WHY.includes(a.why)) return `ask 只用于不可逆或高成本的分叉：why 必须是 ${ASK_WHY.join(" / ")}；其他问题自己判断，在 report 里说明`;
      if (a.options.length < 2 || a.options.length > 6) return "ask 需要 2～6 个 options";
      if (a.options.some((o) => !o.label)) return "每个选项都要有 label";
      if (new Set(a.options.map((o) => o.id)).size !== a.options.length) return "选项 id 重复";
      if (a.why === "irreversible" && !a.options.some((o) => o.go)) return "irreversible 的问题要把「同意执行」的选项标上 \"go\":true";
      return undefined;
    }
    case "finish": {
      if (!l.criteria.length) return "还没有验收标准，不能 finish；先用 update_constraints 补上";
      if (!a.summary) return "finish 缺少 summary";
      const cur = new Map(currentEvidence(l).map((e) => [e.id, e]));
      const problems: string[] = [];
      for (const c of l.criteria) {
        const refs = a.acceptance.filter((x) => x.criterion === c.id);
        if (!refs.length) { problems.push(`${c.id} 没有对应证据`); continue; }
        const ok = refs.some((r) => cur.get(r.evidence)?.pass);
        if (!ok) {
          const r = refs[0].evidence;
          const ev = l.evidence.find((e) => e.id === r);
          problems.push(!ev ? `${c.id} 引用的 ${r} 不存在` : !ev.pass ? `${c.id} 引用的 ${r} 没有通过` : `${c.id} 引用的 ${r} 是在旧版本上采集的（之后代码又改过），需要重新验证`);
        }
      }
      if (ctx.requireReview && !currentEvidence(l).some((e) => e.kind === "review" && e.pass)) problems.push("这个组合要求当前版本至少通过一次 review");
      return problems.length ? `完成门禁未通过：${problems.join("；")}` : undefined;
    }
    case "abort": {
      if (!a.reason) return "abort 缺少 reason";
      if (!a.tried.length) return "abort 要写 tried（试过什么）";
      if (!a.blockers.length) return "abort 要写 blockers（卡在哪）";
      const ids = new Set(l.criteria.map((c) => c.id));
      if (l.criteria.length && !a.unmet.length) return "abort 要在 unmet 里列出没达成的验收标准";
      const bad = a.unmet.filter((u) => !ids.has(u));
      if (bad.length) return `unmet 里有不存在的标准：${bad.join(", ")}`;
      return undefined;
    }
  }
}

/** Apply an accepted update_constraints; returns human-readable change lines */
export function applyChanges(l: Ledger, a: Extract<LoopAction, { action: "update_constraints" }>, step: number): string[] {
  const by: Who = a.source === "human" ? "human" : "supervisor";
  const out: string[] = [];
  for (const c of a.changes) {
    const isC = c.target === "criterion";
    const list = isC ? l.criteria : l.constraints;
    const kind = isC ? "验收" : "约束";
    if (c.op === "add") {
      const id = isC ? `C${++l.seq.C}` : `K${++l.seq.K}`;
      list.push({ id, text: c.text!, by, at: Date.now() });
      out.push(`＋ ${kind} ${id}：${c.text}`);
    } else if (c.op === "modify") {
      const it = list.find((x) => x.id === c.id)!;
      out.push(`～ ${kind} ${c.id}：${it.text} → ${c.text}`);
      it.text = c.text!;
      it.by = by;
    } else {
      const i = list.findIndex((x) => x.id === c.id);
      out.push(`－ ${kind} ${c.id}：${list[i].text}`);
      list.splice(i, 1);
    }
  }
  l.constraintsVersion++;
  l.decisions.push({ step, at: Date.now(), text: `约束 v${l.constraintsVersion}：${a.reason}` });
  return out;
}

// ---- prompts ------------------------------------------------------------------

const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "…" : t);
export { clip };

function criteriaBlock(l: Ledger, withEvidence: boolean): string {
  if (!l.criteria.length) return "（还没有）";
  const cur = currentEvidence(l).filter((e) => e.pass);
  return l.criteria.map((c) => `- ${c.id} ${c.text}`).join("\n") + (withEvidence && cur.length ? `\n（当前版本上通过的证据：${cur.map((e) => e.id).join(", ")}）` : "");
}

function constraintsBlock(l: Ledger): string {
  return l.constraints.length ? l.constraints.map((c) => `- ${c.id} ${c.text}`).join("\n") : "（无额外约束；群公告和群记忆见系统提示）";
}

function planBlock(l: Ledger): string {
  return l.plan.length ? l.plan.map((p) => `- [${p.status}] ${p.text}`).join("\n") : "（还没有计划）";
}

export function evidenceLine(e: Evidence, l: Ledger): string {
  const at = e.sha === l.lastChangeSha ? "当前版本" : `旧版本 ${e.sha.slice(0, 7)}`;
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
}

export function buildSupervisorPrompt(l: Ledger, c: SupervisorCtx): string {
  const b = budgetState(l);
  const ev = l.evidence.slice(-10);
  const obs = l.observations.slice(-8);
  const humanNew = obs.filter((o) => o.kind === "human" && o.step > l.step);
  const out: string[] = [];
  out.push(`你是 orc 任务 #${c.taskId}「${c.title}」的监督者（Supervisor）。你不亲自改代码：每轮从固定动作里选**一个**，代码校验后执行，结果下一轮交给你。你可以用只读工具查看仓库来分析（工作区 \`${c.worktree}\`，分支 \`${c.branch}\`）。`);
  out.push(`## 目标\n${l.goal}`);
  out.push(`## 验收标准\n${criteriaBlock(l, true)}` + (l.criteria.length ? "" : "\n第一件事：用 update_constraints（target=criterion, op=add）补上**可检查**的验收标准（能用命令、测试、指标判定）。"));
  out.push(`## 约束（v${l.constraintsVersion}）\n${constraintsBlock(l)}\n群公告和群记忆在系统提示里，同样必须遵守。`);
  out.push(`## 计划\n${planBlock(l)}`);
  if (l.decisions.length) out.push(`## 关键决定\n${l.decisions.slice(-8).map((d) => `- 第 ${d.step} 轮：${d.text}`).join("\n")}`);
  out.push(`## 证据（最近 ${ev.length} 条）\n${ev.length ? ev.map((e) => evidenceLine(e, l)).join("\n") : "（还没有）"}`);
  out.push([
    `## 当前状态`,
    `HEAD \`${l.head.slice(0, 12)}\`；相对起点的改动：${c.diffStat ? "\n```\n" + clip(c.diffStat, 1500) + "\n```" : "无"}`,
    `worker：${c.worker}${l.worker.sessionId ? `（会话已续接 ${l.worker.turns} 轮）` : "（下一条指令开新会话）"}${c.reviewer ? `；审查：${c.reviewer}` : ""}`,
    c.waiting ? `正在等待：${c.waiting}` : "",
    `预算：${b.line}${b.ratio >= 0.8 ? "（已用 80% 以上，抓紧收敛）" : ""}`,
  ].filter(Boolean).join("\n"));
  out.push(`## 最近观测（旧 → 新）\n${obs.length ? obs.map((o) => `[第 ${o.step} 轮 · ${o.kind}] ${clip(o.text, 1200)}`).join("\n\n") : "（无）"}`);
  out.push([
    `## 这一轮`,
    `起因：${c.reason}`,
    l.rejection ? `⚠️ 你上一轮提出的动作被代码驳回：${l.rejection}` : "",
    humanNew.length ? "人刚发来了新消息（见最近观测里的 [human]）：先回应它——调整计划 / 约束，或在 report 里说明你打算怎么处理。" : "",
    l.pendingAsk ? `待人回答：${l.pendingAsk.question}` : "",
  ].filter(Boolean).join("\n"));
  const acts = [
    '- {"action":"instruct","text":"给 worker 的下一条具体指令（当前约束和验收标准由代码自动附上）","fresh":false}',
    '- {"action":"verify","checks":[{"cmd":"只读检查命令，如 pytest -q","expect":"可选：输出必须匹配的正则","label":"可选"}]}  —— 取证；结果记为 E 编号',
    '- {"action":"report","progress":"给人看的进展","findings":["分析/发现"],"suggestion":"建议（可选）"}',
    '- {"action":"update_constraints","changes":[{"op":"add|modify|remove","target":"constraint|criterion","id":"modify/remove 时必填","text":"…"}],"reason":"为什么改","source":"human|evidence|supervisor","quote":"source=human 时原样引用人的话"}',
    c.reviewer ? '- {"action":"review","focus":"可选：审查重点"}  —— 换一个模型审当前改动，结论记为证据' : "",
    c.canWait ? '- {"action":"wait","watch":{"title":"…","pid":123,"log":"out/train.log","done":"Training finished","wake_on":["Traceback"],"stale":"30m","metrics":{"path":"out/metrics.jsonl","show":["step","loss"],"stop":"loss<0.2"},"every":"5m","timeout":"2d"},"heartbeat":"巡检间隔，默认 30m","reason":"…"}  —— 挂起等外部作业；代码定时检查（不耗 token），结束/出错/卡住时叫醒你，另外每个 heartbeat 叫醒你巡检一次。巡检正常就 {"action":"wait","keep":true,"reason":"一句判断依据"}（不占轮数）；其他任何动作都会结束这次等待。' + WAKE_ON_HINT : "",
    '- {"action":"ask","question":"…","why":"irreversible|high_cost|goal_ambiguous","options":[{"id":"a","label":"…","consequence":"选它会怎样"},{"id":"b","label":"同意推送","go":true}]}  —— 问了就一直等你答，代码不会替你选；能自己定的就别问，在 report 里说明；irreversible 时把同意执行的选项标 "go":true',
    '- {"action":"finish","summary":"结论","acceptance":[{"criterion":"C1","evidence":"E3"}]}',
    '- {"action":"abort","reason":"…","tried":["试过什么"],"blockers":["卡在哪"],"unmet":["C2"],"resume_hint":"以后怎么接着做"}',
  ].filter(Boolean);
  out.push(`## 动作（可以先写简短分析，最后只输出一个 JSON 对象）\n${acts.join("\n")}\n任何动作都可以附带："plan":[{"text":"…","status":"todo|doing|done|dropped"}]（整体替换计划）、"decision":"一句话记录关键取舍及理由"。`);
  out.push([
    "## 规则（代码会强制检查）",
    "- 不信 worker 的自报：完成与否以 verify / review / 监控采集的证据为准。",
    "- finish 必须为每条验收标准列出证据编号，且证据必须是在**当前版本**上采集并通过的；代码改过就要重新验证。",
    "- 长时间作业（训练、批处理）：让 worker 在后台启动并报告 pid 和日志，再用 wait 等待；不要让 worker 前台干等。等待期间你在盯实验：跑偏了就 instruct worker 停掉、修正、重跑，不要等它跑完。",
    "- 只有不可逆（推送、部署、删除数据、对外发消息）、高成本（大额算力 / 时间）或目标本身有歧义的分叉才 ask，并给出选项、后果和默认；其他问题自己判断，在 report 里说明理由。",
    "- 新增约束或验收标准可以直接加；修改 / 删除（可能放宽要求）只能由人提出：source=human 并在 quote 里原样引用。",
    "- 有分析、发现或建议时用 report 告诉人；不要连续两轮 report。",
  ].join("\n"));
  return out.join("\n\n");
}

export function buildWorkerPrompt(l: Ledger, text: string, o: { taskId: number; fresh: boolean; rolePrompt: string; branch: string }): string {
  const out: string[] = [];
  out.push(`# orc 任务 #${o.taskId} · 你是执行者（worker），按监督者的指令干活`);
  if (o.fresh) {
    out.push(`## 任务目标\n${l.goal}`);
    const recent = l.observations.slice(-5);
    const ctx = [
      l.plan.length ? `计划：\n${planBlock(l)}` : "",
      l.decisions.length ? `关键决定：\n${l.decisions.slice(-6).map((d) => `- ${d.text}`).join("\n")}` : "",
      recent.length ? `最近进展：\n${recent.map((r) => `- [${r.kind}] ${clip(r.text.replace(/\n+/g, " "), 300)}`).join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
    if (ctx) out.push(`## 到目前为止（你是新会话，这是交接摘要）\n${ctx}`);
  }
  out.push(`## 验收标准\n${criteriaBlock(l, false)}`);
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
    `## 验收标准\n${criteriaBlock(l, false)}`,
    `## 约束（v${l.constraintsVersion}）\n${constraintsBlock(l)}`,
    o.focus ? `## 本次审查重点\n${o.focus}` : "",
    `## 相对基线的改动\n提交：\n\`\`\`\n${o.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${o.diff.stat || "(无改动)"}\n\`\`\``,
    o.diff.diff ? `\`\`\`diff\n${o.diff.diff}\n\`\`\`` : "",
    `## 角色说明\n${o.rolePrompt}`,
    `## 输出约定（必须遵守）\n最后一条回复要给出结论：\n${o.contract}`,
  ].filter(Boolean).join("\n\n");
}
