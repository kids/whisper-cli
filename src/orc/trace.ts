// =============================================================================
// orc — 一轮结束以后的轨迹图（给人 review 用）
// =============================================================================
// A card that only says "实现中…" tells a manager nothing: the expensive
// failures are visible only in the shape of the run — the same stage retried
// eight times, a resume that grew from 22M to 36M per round, two runs killed at
// the clock, a critic that got E2BIG. The human asked to see that shape after
// every round, so this renders one compact block: a per-stage timeline with a
// symbol per attempt, the top consumers of tokens, the failures whose cause is
// already known, and the numbers that make the next decision obvious.
//
// Everything here is derived from data the scheduler already has (attempts,
// loops counters, the task's state file). It must never be able to break
// scheduling: callers wrap it in try/catch, and it degrades to "" when there is
// nothing to draw.
// =============================================================================
import { existsSync, readFileSync } from "node:fs";
import type { Attempt, Task } from "./types";
import { fmtMin, fmtTok } from "./agent-cards";

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const flat = (s: string) => (s || "").replace(/\s+/g, " ").trim();

/** Symbol for one attempt in the timeline; the legend is printed once */
export function mark(a: Attempt): string {
  if (a.status === "running") return "▶";
  if (a.status === "cancelled") return "✕";
  if (a.status === "failed") {
    if (/spawn|E2BIG|ENOENT|EACCES/i.test(a.error || "")) return "⚠"; // whisper's own fault, not the agent's
    return "✗";
  }
  if (a.status === "interrupted") return "◌"; // cut off mid-run (timeout / restart) — work may be half done
  const p = a.parsed;
  if (!p) return "·";
  if (p.kind === "verdict") return p.pass ? "✓" : "↺";   // passed / sent back for rework
  if (p.kind === "test") return p.pass ? "✓" : "↺";
  if (p.kind === "impl") return p.pass ? "✓" : "↺";
  return "•";
}

export const LEGEND = "✓ 通过 · ↺ 退回重做 · ✗ 失败 · ◌ 中途被截断 · ⚠ whisper 侧故障 · ▶ 运行中 · ✕ 已停止";

export function fmtDuration(ms: number): string {
  return ms >= 3_600_000 ? `${(ms / 3_600_000).toFixed(1)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`;
}

export interface TraceInput {
  task: Task;
  attempts: Attempt[];
  /** task working-state file, when the caller knows where it is */
  statePath?: string;
  now?: number;
}

/**
 * Per-stage one-liner: who ran, how many times, what the symbols were, what it cost.
 * Failures get their reason inline, because "✗✗✗" without a reason is exactly the
 * kind of "the agent tried and it didn't work" that hides a fixable detail problem.
 */
function stageLines(task: Task, attempts: Attempt[], now: number): string[] {
  const order = task.preset?.stages?.map((s) => s.id) ?? [];
  const byStage = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const k = a.stageId;
    if (!byStage.has(k)) byStage.set(k, []);
    byStage.get(k)!.push(a);
  }
  const ids = [...byStage.keys()].sort((x, y) => {
    const i = order.indexOf(x), j = order.indexOf(y);
    return (i < 0 ? 99 : i) - (j < 0 ? 99 : j);
  });
  return ids.map((id) => {
    const list = byStage.get(id)!;
    const roles = [...new Set(list.map((a) => a.role))];
    const tok = list.reduce((s, a) => s + (a.tokens || 0), 0);
    const dur = list.reduce((s, a) => s + ((a.endedAt ?? now) - a.startedAt), 0);
    const marks = list.map(mark).join("");
    const head = `**${id}**（${roles.join("/")}）${list.length} 次 ${marks}${tok ? ` · ${fmtTok(tok)} tok` : ""}${dur ? ` · ${fmtDuration(dur)}` : ""}`;
    const reasons = list
      .filter((a) => a.status === "failed" || a.status === "interrupted" || a.status === "cancelled")
      .slice(-2)
      .map((a) => `  - #${a.id} ${a.status === "interrupted" ? "被截断" : a.status === "cancelled" ? "被停止" : "失败"}：${clipText(flat(a.error || a.progress || "没有记录原因"), 120)}`);
    return [head, ...reasons].join("\n");
  });
}

/** Where the tokens went: the three heaviest runs, with the growth that makes resume expensive */
function costLines(attempts: Attempt[]): string[] {
  const done = attempts.filter((a) => (a.tokens || 0) > 0 && a.endedAt != null);
  if (!done.length) return [];
  const total = done.reduce((s, a) => s + a.tokens, 0);
  const top = [...done].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
  const share = (n: number) => `${Math.round((n / total) * 100)}%`;
  const out = [`**花费最多**（共 ${fmtTok(total)} tok，${done.length} 次有计费）`];
  for (const a of top) {
    out.push(`  - #${a.id} ${a.stageId}/${a.role} · ${fmtTok(a.tokens)}（${share(a.tokens)}）· ${fmtDuration((a.endedAt ?? Date.now()) - a.startedAt)}`);
  }
  // Same session growing round over round is the resume cost spiral; name it rather than
  // leaving the human to notice the numbers creeping up.
  const bySession = new Map<string, number[]>();
  for (const a of done) {
    if (!a.sessionKey) continue;
    const k = a.sessionKey.replace(/:r\d+$/, "");
    if (!bySession.has(k)) bySession.set(k, []);
    bySession.get(k)!.push(a.tokens);
  }
  for (const [k, ts] of bySession) {
    if (ts.length >= 3 && ts[ts.length - 1] > ts[0] * 1.5) {
      out.push(`  - ↳ 同一会话续跑 ${ts.length} 次，单次从 ${fmtTok(ts[0])} 涨到 ${fmtTok(ts[ts.length - 1])}（历史每轮重发，已按轮数自动换会话）`);
      break;
    }
  }
  return out;
}

/** Why the last round stopped, in the driver's own words (loops counters are set by core.ts) */
function stopLines(task: Task): string[] {
  const loops = task.loops || {};
  const out: string[] = [];
  const stageIds = new Set(task.preset?.stages?.map((s) => s.id) ?? []);
  // core.ts bumps loops[<stage id>] when a review/test sends work back; `stall:` counts
  // rounds that ended without progress. Anything else (`env:`, `spec:`, `cont:`) is
  // bookkeeping, not a verdict on the work, so it stays out of the human's view.
  const rework = Object.entries(loops).filter(([k]) => stageIds.has(k));
  if (rework.length) out.push(`**退回次数**：${rework.map(([k, v]) => `${k} ×${v}`).join("、")}（到上限才交给人，不会无限来回）`);
  const stalls = Object.entries(loops).filter(([k]) => k.startsWith("stall:"));
  if (stalls.length) out.push(`**连续无进展**：${stalls.map(([k, v]) => `${k.split(":")[1]} ×${v}`).join("、")}`);
  if (task.progress) out.push(`**现在**：${clipText(flat(task.progress), 200)}`);
  return out;
}

/** The five sections of the state file, pulled out so a manager can read the cursor without opening it */
function stateBlock(task: Task, statePath?: string): string[] {
  const p = statePath ?? "";
  if (!p || !existsSync(p)) return [];
  let raw = "";
  try { raw = readFileSync(p, "utf8"); } catch { return []; }
  const grab = (name: string) => {
    const m = raw.match(new RegExp(`##\\s*${name}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`));
    return m ? m[1].trim() : "";
  };
  const out: string[] = [];
  const prog = grab("当前进度");
  if (prog) out.push(`**进度**：${clipText(flat(prog), 300)}`);
  const todo = grab("待办").split("\n").map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).slice(0, 3);
  if (todo.length) out.push(`**下一步**：${todo.join("；")}`);
  const no = grab("已否决");
  if (no) out.push(`**已否决**（注意分清是方法错、还是细节没做到位）：${clipText(flat(no), 300)}`);
  return out;
}

/**
 * One round of a loop task. A loop has no stages, so the per-stage timeline has
 * nothing to group by — the per-round record is the track record. Same purpose:
 * a human reads the shape (cost growth, repeated failures) without opening logs.
 */
export function renderRunLine(c: { n: number; label: string; tokens?: number; error?: string; durationMs?: number }): string {
  const bad = !!c.error;
  const sym = bad ? (/超时|timed? ?out/i.test(c.error!) ? "◌" : "✗") : "•";
  const why = bad ? ` · ${clipText(flat(c.error!), 100)}` : "";
  const dur = c.durationMs ? ` · ${fmtDuration(c.durationMs)}` : "";
  return `第 ${c.n} 轮 ${sym} ${c.label}${c.tokens ? ` · ${fmtTok(c.tokens)} tok` : ""}${dur}${why}`;
}

/**
 * The block a human reads after each round. Returns "" when there is nothing
 * worth showing (no attempts yet), so callers can append it unconditionally.
 */
export function renderTrace(c: TraceInput): string {
  const attempts = [...c.attempts].sort((a, b) => a.startedAt - b.startedAt);
  if (!attempts.length) return "";
  const now = c.now ?? Date.now();
  const total = attempts.reduce((s, a) => s + (a.tokens || 0), 0);
  const elapsed = now - c.task.createdAt;
  const head = `**轨迹 · ${attempts.length} 次运行${total ? ` · ${fmtTok(total)} tok` : ""} · 耗时 ${fmtMin(elapsed)}**`;
  const parts = [head, LEGEND, ...stageLines(c.task, attempts, now), ...stopLines(c.task), ...costLines(attempts), ...stateBlock(c.task, c.statePath)];
  return parts.filter(Boolean).join("\n");
}
