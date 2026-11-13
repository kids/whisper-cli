// =============================================================================
// orc — one card per agent run, posted in the task card's reply thread
// =============================================================================
// The task card (chat.ts renderCard) is a thin index: `#N title` + progress text.
// Each agent run gets its own card in that card's thread (Feishu 话题 /
// Telegram reply): live while running (elapsed, tokens, last progress lines),
// then only the conclusion — summary + artifacts for writers, verdict + issue
// list for critics, pass/fail for testers. The main chat only gets what needs a
// human (result / decision / failure), sent by chat.ts notify.
//
// Pipeline runs map 1:1 to `attempts` rows. Loop tasks get one card per round
// (supervisor + worker/reviewer runs), finalised with the round's 主 ↔ 子 text.
// Platforms without threads (WeCom) get no agent cards; the task card still
// lists recent runs. Card ids persist in ~/.orc/agent-cards.json so updates
// continue after a restart. Disable with ORC_AGENT_CARDS=off.
// =============================================================================
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ImClient } from "../platform/types";
import type { Attempt, Task } from "./types";

export const AGENT_CARDS_ON = () => !/^(off|0|false|no)$/i.test(process.env.ORC_AGENT_CARDS || "");
const THROTTLE_MS = () => Number(process.env.ORC_AGENT_CARD_THROTTLE_MS || 5000);
const MAX_CARD = 3500;
/** Runs that ended before this process started never get a card (no flood on restart) */
const BOOT = Date.now();

// ---- rendering (pure) ------------------------------------------------------

const ROLE_ICON: Record<string, string> = {
  planner: "🗺", implementer: "🛠", reproducer: "🐞", tester: "🧪", critic: "🧐", critic_alt: "🧐",
  researcher: "🔬", synthesizer: "📝", supervisor: "🧭",
};
const STAGE_ZH: Record<string, string> = {
  plan: "规划", design_review: "设计评审", impl: "实现", review: "评审", critique: "评审", test: "测试",
  repro: "复现", fix: "修复", research: "调研", summary: "汇总", review_a: "评审", review_b: "第二评审",
};

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
export const fmtMin = (ms: number) => { const m = Math.max(0, Math.round(ms / 60_000)); return m < 90 ? `${m} 分钟` : `${(m / 60).toFixed(1)} 小时`; };
export const fmtTok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const firstSentence = (s: string, n: number) => clipText((s.split(/(?<=[。；;！!？?])/)[0] || s).trim(), n);
const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const modelOf = (a: { cli: string; model: string | null }) => a.model || a.cli;

export interface AttemptCtx {
  /** 1-based count of this role's runs in this stage (so far, including this one) */
  nth: number;
  /** Failed verdict/test this run is responding to */
  prior?: { what: "评审" | "测试"; count: number };
  outputPath: string;
  readOnly: boolean;
  /** Recent progress lines while running (newest last) */
  lines?: string[];
  now?: number;
}

function verdictBlock(p: any): string[] {
  const issues: any[] = Array.isArray(p.issues) ? p.issues : [];
  const major = issues.filter((it) => it.severity === "major");
  const rest = issues.filter((it) => it.severity !== "major");
  const show = major.length ? major : rest.slice(0, 5);
  const out: string[] = [];
  const notes: string[] = Array.isArray(p.notes) ? p.notes : [];
  const fixed = notes.find((x) => /^已确认修复/.test(x));
  if (fixed) out.push("", `**已确认修复**：${clipText(fixed.replace(/^已确认修复[:：]?/, ""), 300)}`);
  if (show.length) {
    out.push("", major.length ? "**问题（major）**" : "**问题**");
    show.slice(0, 12).forEach((it, k) => {
      const f = it.file ? String(it.file).split("/").pop() + (it.line ? ":" + it.line : "") : "";
      out.push(`${k + 1}. ${f ? `\`${f}\` ` : ""}${firstSentence(str(it.desc), 140)}`);
    });
    if (show.length > 12) out.push(`…另有 ${show.length - 12} 条`);
  }
  const others = major.length ? rest.length : Math.max(0, rest.length - 5);
  if (others) out.push(`另有 ${others} 条次要意见`);
  return out;
}



/** State word for the header line */
function stateOf(a: Attempt): string {
  if (a.status === "running") return "运行中";
  if (a.status === "cancelled") return "🛑 已停止";
  if (a.status === "interrupted") return "⏸ 被打断（服务重启）";
  if (a.status === "failed") return "❌ 出错";
  const p = a.parsed;
  if (!p) return "⚠️ 没按约定输出";
  if (p.kind === "verdict") {
    if (p.pass) return "✓ 通过";
    const n = (p.issues ?? []).filter((it: any) => it.severity === "major").length;
    return `✗ 退回${n ? `（${n} 条 major）` : ""}`;
  }
  if (p.kind === "test") return p.pass ? "✓ 通过" : "✗ 未通过";
  if (p.kind === "plan") return "✓ 规划完成";
  return "✓ 交付";
}

export function renderAttemptCard(a: Attempt, c: AttemptCtx): string {
  const now = c.now ?? Date.now();
  const icon = ROLE_ICON[a.role] ?? "🤖";
  const stage = STAGE_ZH[a.stageId] ?? a.stageId;
  const head = `**${icon} ${a.role} · ${modelOf(a)} · ${stage}第 ${c.nth} 次 · ${stateOf(a)}**`;
  const meta = [
    `用时 ${fmtMin((a.endedAt ?? now) - a.startedAt)}`,
    a.tokens ? `${fmtTok(a.tokens)} tokens` : "",
    c.readOnly ? "只读" : "",
    /^提交 [0-9a-f]{7}/.test(a.progress) && a.status !== "running" ? a.progress : "",
  ].filter(Boolean).join(" · ");
  const lines = [head, meta];
  if (c.prior) lines.push("", `这一版是根据上次${c.prior.what}的 ${c.prior.count} 条意见重做的。`);
  if (a.status === "running") {
    const recent = (c.lines?.length ? c.lines : a.progress ? [a.progress] : []).slice(-4);
    lines.push("", ...(recent.length ? recent.map((l) => `> ${clipText(l, 160)}`) : ["> 启动中…"]));
    return clipText(lines.join("\n"), MAX_CARD);
  }
  const p = a.parsed;
  if (a.status === "failed" || a.status === "cancelled" || a.status === "interrupted") {
    if (a.error) lines.push("", clipText(a.error, 600));
  } else if (!p) {
    lines.push("", `输出里没找到结论行，下面是结尾部分：`, "", clipText(a.output.trim().slice(-600), 600) || "（空）");
  } else {
    if (p.summary) lines.push("", p.kind === "verdict" ? `**结论**：${clipText(p.summary, 600)}` : clipText(p.summary, 1400));
    if (p.kind === "verdict") lines.push(...verdictBlock(p));
    else if (p.kind === "plan" && p.subtasks?.length) lines.push("", `拆成 ${p.subtasks.length} 个子任务：`, ...p.subtasks.slice(0, 8).map((s: any, i: number) => `${i + 1}. ${clipText(str(s.title), 80)}`));
  }
  lines.push("", `完整输出：\`${c.outputPath}\``);
  return clipText(lines.join("\n"), MAX_CARD);
}

/** Context for one attempt within its task's attempt list */
export function attemptCtx(t: Task, all: Attempt[], a: Attempt, orcHome: string, lines?: string[]): AttemptCtx {
  const nth = all.filter((x) => x.id <= a.id && x.stageId === a.stageId && x.role === a.role).length;
  const role = t.preset.roles[a.role];
  const readOnly = role?.isolation === "readonly";
  let prior: AttemptCtx["prior"];
  if (!readOnly && nth > 1) {
    const prev = [...all].reverse().find((x) => x.id < a.id && x.parsed && (x.parsed.kind === "verdict" || x.parsed.kind === "test") && x.parsed.pass === false);
    if (prev) {
      const count = (prev.parsed.issues ?? []).length;
      if (count) prior = { what: prev.parsed.kind === "verdict" ? "评审" : "测试", count };
    }
  }
  return { nth, prior, readOnly, lines, outputPath: resolve(orcHome, "tasks", String(t.id), `${a.id}-${a.stageId}.output.md`).replace(process.env.HOME || "/root", "~") };
}

// ---- loop rounds --------------------------------------------------------------

export interface LoopRun {
  label: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  tokens?: number;
  error?: string;
  line?: string;
}

export interface LoopRound {
  taskId: number;
  n: number;
  runs: LoopRun[];
  /** The round's 主 ↔ 子 text (set when the round commits) */
  turn?: string;
}

export function renderLoopRoundCard(r: LoopRound, now = Date.now()): string {
  const running = r.runs.some((x) => !x.endedAt);
  const lines = [`**🔁 第 ${r.n} 轮${r.turn ? "" : running ? " · 运行中" : ""}**`];
  for (const x of r.runs) {
    const st = !x.endedAt ? "▶" : x.error ? "❌" : "✓";
    const label = ({ worker: "执行", 审查: "审查", 监督者: "监督者" } as Record<string, string>)[x.label] ?? x.label;
    lines.push(`${st} ${label} · ${x.model} · ${fmtMin((x.endedAt ?? now) - x.startedAt)}${x.tokens ? ` · ${fmtTok(x.tokens)} tokens` : ""}${x.error ? ` · ${clipText(x.error, 120)}` : ""}`);
    if (!x.endedAt && x.line) lines.push(`> ${clipText(x.line, 160)}`);
  }
  if (r.turn) lines.push("", r.turn.replace(/^\*\*第 \d+ 轮 · /, "**"));
  return clipText(lines.join("\n"), MAX_CARD);
}

// ---- delivery -------------------------------------------------------------------

interface Saved { id: string; done?: boolean }

export class AgentCards {
  private saved: Record<string, Saved> | null = null;
  private inflight = new Map<string, Promise<string | undefined>>();
  private touched = new Map<string, { at: number; text: string }>();
  private lines = new Map<number, string[]>();
  private rounds = new Map<string, LoopRound>();

  constructor(private path: string) {}

  private load(): Record<string, Saved> {
    if (this.saved) return this.saved;
    try { this.saved = existsSync(this.path) ? JSON.parse(readFileSync(this.path, "utf8")) : {}; }
    catch { this.saved = {}; }
    return this.saved!;
  }

  private persist(): void {
    const all = Object.entries(this.load());
    const keep = Object.fromEntries(all.slice(-3000));
    this.saved = keep;
    mkdirSync(resolve(this.path, ".."), { recursive: true });
    writeFileSync(this.path + ".tmp", JSON.stringify(keep));
    renameSync(this.path + ".tmp", this.path);
  }

  cardId(key: string): string | undefined {
    return this.load()[key]?.id;
  }

  /** Create (once) or update the card for `key`; `final` = last update, always sent */
  async upsert(im: ImClient, rootCard: string, key: string, text: string, final: boolean): Promise<void> {
    if (!im.replyCardInThread) return;
    const s = this.load()[key];
    if (s?.done) return;
    if (!s) {
      let p = this.inflight.get(key);
      const creating = !p;
      if (!p) {
        p = im.replyCardInThread(rootCard, text).catch(() => undefined);
        this.inflight.set(key, p);
      }
      const id = await p;
      if (creating) {
        this.inflight.delete(key);
        if (!id) return;
        this.load()[key] = { id, done: final };
        this.persist();
        this.touched.set(key, { at: Date.now(), text });
        return;
      }
      if (!id) return;
    }
    const id = this.load()[key]!.id;
    const last = this.touched.get(key);
    if (!final && last && (last.text === text || Date.now() - last.at < THROTTLE_MS())) return;
    if (final && last?.text === text) { this.load()[key].done = true; this.persist(); return; }
    this.touched.set(key, { at: Date.now(), text });
    await im.updateCardMessage(id, text).catch(() => false);
    if (final) { this.load()[key].done = true; this.persist(); this.touched.delete(key); }
  }

  /** Remember a progress line for a running attempt (shown as the card's tail) */
  noteLine(attemptId: number, line: string): string[] {
    const l = this.lines.get(attemptId) ?? [];
    if (line && l[l.length - 1] !== line) l.push(line);
    if (l.length > 4) l.shift();
    this.lines.set(attemptId, l);
    return l;
  }

  /** Pipeline: bring every live/just-finished attempt's card up to date */
  async syncAttempts(im: ImClient, rootCard: string, t: Task, all: Attempt[], orcHome: string): Promise<void> {
    for (const a of all) {
      const key = `a:${a.id}`;
      const s = this.load()[key];
      if (s?.done) continue;
      if (!s && a.status !== "running" && (a.endedAt ?? 0) < BOOT) continue;
      const lines = a.status === "running" ? this.noteLine(a.id, a.progress) : undefined;
      const final = a.status !== "running";
      await this.upsert(im, rootCard, key, renderAttemptCard(a, attemptCtx(t, all, a, orcHome, lines)), final);
      if (final) this.lines.delete(a.id);
    }
  }

  /** Loop: a run inside round n started / progressed / ended */
  async loopRun(im: ImClient, rootCard: string, ev: { taskId: number; n: number; phase: "start" | "progress" | "end"; label: string; model: string; line?: string; tokens?: number; error?: string }): Promise<void> {
    const key = `l:${ev.taskId}:${ev.n}`;
    for (const k of this.rounds.keys()) if (k.startsWith(`l:${ev.taskId}:`) && k !== key) this.rounds.delete(k);
    const r = this.rounds.get(key) ?? { taskId: ev.taskId, n: ev.n, runs: [] };
    this.rounds.set(key, r);
    let run = [...r.runs].reverse().find((x) => x.label === ev.label && !x.endedAt);
    if (ev.phase === "start" || !run) { run = { label: ev.label, model: ev.model, startedAt: Date.now() }; r.runs.push(run); }
    if (ev.line) run.line = ev.line;
    if (ev.phase === "end") { run.endedAt = Date.now(); run.tokens = ev.tokens; run.error = ev.error; }
    await this.upsert(im, rootCard, key, renderLoopRoundCard(r), false);
  }

  /** Loop: the round committed — finalise its card with the 主 ↔ 子 text. False = no card (caller posts) */
  async loopTurn(im: ImClient, rootCard: string, taskId: number, n: number, text: string): Promise<boolean> {
    const key = `l:${taskId}:${n}`;
    const r = this.rounds.get(key);
    if (!r && !this.cardId(key)) return false;
    const round = r ?? { taskId, n, runs: [] };
    round.turn = text;
    for (const x of round.runs) x.endedAt ??= Date.now();
    await this.upsert(im, rootCard, key, renderLoopRoundCard(round), true);
    this.rounds.delete(key);
    return !!this.cardId(key);
  }
}
