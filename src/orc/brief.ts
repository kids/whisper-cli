// =============================================================================
// orc — 决策说明 (the advisor's brief, rendered for a human)
// =============================================================================
// When a task cannot settle itself (a stage used up its rework budget with two
// defensible ways forward, or a blocker with no good option), the advisor reads
// the whole history and writes this. The point is that the human can decide from
// the message alone: where the work stands, what is actually stuck and why it
// cannot be fixed by trying again, which real choices exist and what each costs,
// what the advisor recommends, and what it needs from the human.
// =============================================================================
import type { ParsedOutput } from "./output";
import type { Task } from "./types";

const s = (v: any) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const cut = (t: string, n: number) => { const x = (t || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };
const list = (v: any): any[] => (Array.isArray(v) ? v : []);

export interface BriefValue {
  situation?: string;
  state?: { done?: string[]; not_done?: string[] };
  blockers?: { what?: string; why_stuck?: string; evidence?: string }[];
  options?: { name?: string; what?: string; cost?: string; risk?: string; reversible?: string; recommended?: boolean }[];
  recommendation?: string;
  needs_from_human?: string;
  auto?: string;
  known_issues?: string[];
}

/** The block a human reads when a decision is needed */
export function renderBrief(task: Task, p: ParsedOutput, stageName: string): string {
  const v = (p.value ?? {}) as BriefValue;
  const out: string[] = [];
  const head = `**#${task.id} ${task.title}：${stageName}反复没过，需要你定一件事**`;
  out.push(head);
  if (v.situation) out.push("", cut(v.situation, 400));

  const done = list(v.state?.done).map(s).filter(Boolean);
  const todo = list(v.state?.not_done).map(s).filter(Boolean);
  if (done.length || todo.length) {
    out.push("", "**现在到哪一步**");
    if (done.length) out.push(`已经做到：`, ...done.slice(0, 6).map((x) => `- ${cut(x, 200)}`));
    if (todo.length) out.push(`还没做到：`, ...todo.slice(0, 6).map((x) => `- ${cut(x, 200)}`));
  }

  const blockers = list(v.blockers).filter((b) => b && (b.what || b.why_stuck));
  if (blockers.length) {
    out.push("", "**卡在哪、为什么再试一轮也多半不动**");
    blockers.slice(0, 5).forEach((b, i) => {
      out.push(`${i + 1}. ${cut(s(b.what), 200)}`);
      if (b.why_stuck) out.push(`   原因：${cut(s(b.why_stuck), 260)}`);
      if (b.evidence) out.push(`   依据：${cut(s(b.evidence), 160)}`);
    });
  }

  const options = list(v.options).filter((o) => o && (o.name || o.what));
  if (options.length) {
    out.push("", "**可以怎么走**");
    options.slice(0, 4).forEach((o, i) => {
      const rec = o.recommended ? "（建议）" : "";
      out.push(`${i + 1}. **${cut(s(o.name) || `方案 ${i + 1}`, 40)}**${rec}：${cut(s(o.what), 260)}`);
      const meta = [o.cost ? `代价：${cut(s(o.cost), 80)}` : "", o.risk ? `风险：${cut(s(o.risk), 120)}` : "", o.reversible ? `补救：${cut(s(o.reversible), 60)}` : ""].filter(Boolean);
      if (meta.length) out.push(`   ${meta.join(" · ")}`);
    });
  }

  if (v.recommendation) out.push("", `**建议**：${cut(s(v.recommendation), 400)}`);
  if (v.needs_from_human) out.push("", `**需要你给的**：${cut(s(v.needs_from_human), 300)}`);
  out.push("", `直接说选哪个就行（说「第 2 条」「按你的建议」都可以）；想改口径、缩小范围、或者不做了，也直接说。${task.branch ? `\n现在的版本在分支 \`${task.branch}\`。` : ""}`);
  return out.join("\n");
}

/** Framework keeps going on its own (the advisor said the leftover issues are acceptable to defer) */
export function renderAutoNote(task: Task, p: ParsedOutput, kept: string[]): string {
  const v = (p.value ?? {}) as BriefValue;
  return [
    `**#${task.id} ${task.title}：我先带着已知问题往下走了一步**`,
    v.situation ? `\n${cut(s(v.situation), 300)}` : "",
    kept.length ? "\n**暂不解决的（记为已知问题）**：\n" + kept.slice(0, 8).map((x) => `- ${cut(x, 220)}`).join("\n") : "",
    v.recommendation ? `\n**为什么这样处理**：${cut(s(v.recommendation), 300)}` : "",
    "\n要改回来就说「退回这一版」或者补充要求，我会重新安排。",
  ].filter(Boolean).join("\n");
}

/** Issues to keep on record when the framework continues on its own */
export function knownIssues(p: ParsedOutput): string[] {
  const v = (p.value ?? {}) as BriefValue;
  if (v.auto !== "continue_with_known_issues") return [];
  return list(v.known_issues).map(s).filter(Boolean).slice(0, 12);
}
