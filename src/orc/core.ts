// =============================================================================
// orc — pure state machine (no I/O). The only writer of task progression rules.
// =============================================================================
// decideAfterAttempt(): given a task and how its current stage's attempt ended,
// return the task patch + effects to persist in the same transaction (001 §4.5:
// record first, execute after commit). Easy to test with plain objects.
// =============================================================================
import { conclusionHint, formatFeedback, type ParsedOutput, type PlanSubtask } from "./output";
import type { LaunchPayload, NotifyPayload, StageDef, Task, TaskStatus } from "./types";
import { TERMINAL } from "./types";

/** Stages a human may 「接受」 past when they block: reviewer / tester verdicts */
export function acceptable(task: Task): StageDef | undefined {
  if (task.kind === "loop" || task.status !== "blocked" || !task.preset?.stages) return undefined;
  const stage = task.preset.stages[task.stageIdx];
  const out = stage && task.preset.roles[stage.role]?.output;
  return out === "verdict" || out === "test" ? stage : undefined;
}

/** Human said 「接受」 on a blocked review / test stage: treat it as passed and move on */
export function decideAccept(task: Task, note?: string): Decision | undefined {
  const stage = acceptable(task);
  if (!stage) return undefined;
  const d: Decision = { patch: {}, launches: [], notifies: [], children: [] };
  const next = task.stageIdx + 1;
  const why = `人工接受${stageName(stage.id)}未通过的版本${note ? `：${note}` : ""}`;
  if (next >= task.preset.stages.length) {
    d.patch = { stageIdx: next, status: "ready", feedback: "", progress: why };
    d.notifies.push({ taskId: task.id, kind: "ready", text: `按你的决定，接受了现在这版${task.branch ? `（分支 \`${task.branch}\`）` : ""}，任务完成。` });
  } else {
    d.patch = { stageIdx: next, status: "running", feedback: "", progress: why };
    d.launches.push({ taskId: task.id, stageIdx: next, note: note ? `人接受了上一环节（${stageName(stage.id)}）未通过的版本，并补充：${note}` : undefined });
  }
  return d;
}

export type Outcome =
  | { kind: "parsed"; parsed: ParsedOutput }
  | { kind: "unparseable"; error: string }
  | { kind: "run_error"; error: string; timedOut: boolean }
  | { kind: "cancelled" };

export interface TaskPatch {
  stageIdx?: number;
  status?: TaskStatus;
  loops?: Record<string, number>;
  feedback?: string;
  spec?: string;
  progress?: string;
}

export interface Decision {
  patch: TaskPatch;
  launches: LaunchPayload[];
  notifies: NotifyPayload[];
  /** ask the engine to write a 决策说明 (advisor role): arbitrate the bar, or hand the decision to a human */
  brief?: { stageIdx: number; mode?: "arbitrate" | "escalate"; rounds?: number };
  children: PlanSubtask[];
}

/** One automatic retry for crashes/timeouts and for missing structured output */
export const AUTO_RETRY = 1;

const empty = (): Decision => ({ patch: {}, launches: [], notifies: [], children: [] });

export interface DecideCtx {
  /** the previous failed verdict/test of the same stage — used to see whether the problem set is shrinking */
  prev?: ParsedOutput;
  /** safety cap on rework rounds regardless of progress (a runaway guard, not the normal exit) */
  cap?: number;
}

export function decideAfterAttempt(task: Task, outcome: Outcome, ctx: DecideCtx = {}): Decision {
  const d = empty();
  const stage = task.preset.stages[task.stageIdx];
  const loops = { ...task.loops };
  const bump = (k: string) => (loops[k] = (loops[k] ?? 0) + 1);
  const block = (why: string) => {
    d.patch = { ...d.patch, status: "blocked", loops, progress: why };
    d.notifies.push({ taskId: task.id, kind: "decision", text: why });
    return d;
  };

  if (outcome.kind === "cancelled") {
    d.patch = { status: "dropped", progress: "已被用户终止" };
    d.notifies.push({ taskId: task.id, kind: "info", text: "任务已终止" });
    return d;
  }

  if (outcome.kind === "run_error") {
    const k = `err:${stage.id}`;
    if ((loops[k] ?? 0) < AUTO_RETRY) {
      bump(k);
      d.patch = { loops, progress: `${stage.id} 运行异常，自动重试一次` };
      d.launches.push({
        taskId: task.id,
        stageIdx: task.stageIdx,
        note: outcome.timedOut
          ? "上一次运行超时被终止。请拆小步骤，优先把已完成的部分落盘，再继续。"
          : `上一次运行异常退出：${outcome.error.slice(0, 300)}。请先检查工作区当前状态再继续。`,
      });
      return d;
    }
    return block(`${stage.id} 连续运行失败：${outcome.error.slice(0, 300)}`);
  }

  if (outcome.kind === "unparseable") {
    const k = `parse:${stage.id}`;
    if ((loops[k] ?? 0) < AUTO_RETRY) {
      bump(k);
      const kind = task.preset.roles[stage.role]?.output;
      d.patch = { loops, progress: `${stage.id} 输出格式不符，要求补交结论` };
      d.launches.push({
        taskId: task.id,
        stageIdx: task.stageIdx,
        note: `你上一次的回复不符合输出约定（${outcome.error}）。不要重做工作，直接补交最终结论：${kind ? conclusionHint(kind) : "按约定给结论"}。`,
      });
      return d;
    }
    return block(`${stage.id} 两次都没有按约定输出结论：${outcome.error}`);
  }

  const p = outcome.parsed;

  if (p.kind === "plan") {
    d.patch.spec = p.spec;
    if ((p.subtasks?.length ?? 0) >= 2) {
      d.patch = { ...d.patch, status: "waiting_children", loops, progress: `已拆成 ${p.subtasks!.length} 个子任务` };
      d.children = p.subtasks!;
      return d;
    }
  }

  if (p.kind === "impl" && !p.pass) {
    return block(`${stage.id} 无法继续：${p.summary || "（未说明原因）"}`);
  }

  if (p.pass || stage.advisory) {
    const next = task.stageIdx + 1;
    // A pass on the stage that produced the feedback means it has been addressed
    const clears = task.feedback.startsWith(`【${stage.id} 未通过】`);
    if (next >= task.preset.stages.length) {
      d.patch = { ...d.patch, stageIdx: next, status: "ready", loops, feedback: clears ? "" : task.feedback, progress: p.summary || "全部阶段通过" };
      d.notifies.push({ taskId: task.id, kind: "ready", text: p.summary || "全部阶段通过，等待验收" });
      return d;
    }
    d.patch = { ...d.patch, stageIdx: next, status: "running", loops, feedback: clears ? "" : task.feedback, progress: `${stage.id} 通过` };
    d.launches.push({ taskId: task.id, stageIdx: next });
    return d;
  }

  // ---- did not pass: judge by progress, not by counting rounds -----------------
  if (!stage.onFail) return block(`${stage.id} 未通过，且编排未定义退回目标：${p.summary}`);

  const now = issueKeys(p);
  const before = ctx.prev ? issueKeys(ctx.prev) : undefined;
  const carry = (label: string, nextStageIdx: number) => {
    // leftovers do not block: continue, with them written down where the next role sees them
    d.patch = { ...d.patch, stageIdx: nextStageIdx, loops, progress: `${stage.id} 剩下的不是会让结论错的问题，带已知问题继续` };
    if (nextStageIdx >= task.preset.stages.length) {
      d.patch.status = "ready";
      d.patch.feedback = "";
      d.notifies.push({ taskId: task.id, kind: "ready", text: `剩下的都只是建议级问题，按评审口径不影响结论。\n${label}` });
    } else {
      d.patch.status = "running";
      d.patch.feedback = `${label}`;
      d.launches.push({ taskId: task.id, stageIdx: nextStageIdx });
      d.notifies.push({ taskId: task.id, kind: "info", text: `${stageName(stage.id)}没给通过，但剩下的不是会让结论错的问题，按口径继续。\n${label}` });
    }
    return d;
  };

  // only advisory-level issues left → the task's own bar says that is a pass
  if (!now.major.length && p.kind === "verdict") {
    return carry(`【${stageName(stage.id)}的建议（不阻塞）】\n${formatFeedback(stage.id, p, p.issues?.filter((it) => it.severity === "minor")).replace(/^【[^】]*未通过】[^\n]*\n?/, "")}`, task.stageIdx + 1);
  }

  const used = bump(stage.id);
  const cap = ctx.cap ?? stage.maxLoops ?? 8;
  const fresh = before ? now.major.filter((k) => !before.major.includes(k)) : [];

  // Nothing new (the set shrank or stayed the same) → keep reworking: that is progress.
  // New problems keep appearing → the bar is the question, not the work: let the advisor arbitrate
  // instead of spending another blind round. The cap is only a runaway guard.
  const keepGoing = used <= cap && fresh.length === 0;
  if (keepGoing) {
    const target = task.preset.stages.findIndex((s) => s.id === stage.onFail);
    d.patch = {
      stageIdx: target,
      status: "running",
      loops,
      feedback: formatFeedback(stage.id, p),
      progress: `${stage.id} 未通过，退回 ${stage.onFail}（第 ${used} 次；问题从 ${before?.major.length ?? "?"} 条到 ${now.major.length} 条）`,
    };
    d.launches.push({ taskId: task.id, stageIdx: target });
    return d;
  }

  d.patch = { ...d.patch, status: "running", loops, progress: `${stageName(stage.id)}这一轮又换了新问题，正在核对评审口径` };
  d.brief = { stageIdx: task.stageIdx, mode: before && used <= cap ? "arbitrate" : "escalate", rounds: used };
  return d;
}

/** normalize issues to comparable keys (file may move lines between rounds; description is the identity) */
export function issueKeys(p: ParsedOutput): { major: string[]; minor: string[] } {
  const out = { major: [] as string[], minor: [] as string[] };
  for (const it of p.issues ?? []) {
    const key = norm(`${(it.file ?? "").split("/").pop() ?? ""} ${it.desc}`);
    (it.severity === "major" ? out.major : out.minor).push(key);
  }
  return out;
}

const norm = (t: any) => String(t ?? "").toLowerCase().replace(/[\s`'"“”()（）：:，,。.;；、\-_/\\]+/g, "").slice(0, 40);


/**
 * Parent of planner-split children. A blocked child is waiting for a human — the parent keeps
 * waiting too (progress only, no message: the child's own decision message is the one to act on).
 * Settles once every child is final (ready / failed / dropped).
 */
export function decideParent(parent: Task, children: Task[]): Decision | null {
  if (!children.length || !children.every((c) => TERMINAL.includes(c.status))) return null;
  const d = empty();
  const blocked = children.filter((c) => c.status === "blocked");
  if (blocked.length) {
    const waiting = children.filter((c) => c.status !== "ready" && c.status !== "blocked" && c.progress.startsWith("跳过"));
    d.patch = { status: "waiting_children", progress: `等你决定 ${blocked.map((c) => c.title).join("、")}${waiting.length ? `（${waiting.map((c) => c.title).join("、")} 在等它）` : ""}` };
    return d;
  }
  const bad = children.filter((c) => c.status !== "ready");
  if (bad.length) {
    const ok = children.filter((c) => c.status === "ready");
    const why = [
      `没有全部完成：${bad.map((c) => `${c.title}（${c.status === "dropped" ? (c.progress.startsWith("跳过") ? "因前置任务没完成而跳过" : "已终止") : "已放弃"}）`).join("；")}`,
      ok.length ? `已完成：${ok.map((c) => `${c.title} → \`${c.branch}\``).join("；")}` : "",
    ].filter(Boolean).join("\n");
    d.patch = { status: "failed", progress: `子任务没有全部完成（${ok.length}/${children.length}）` };
    d.notifies.push({ taskId: parent.id, kind: "info", text: why });
    return d;
  }
  const text = `全部 ${children.length} 个子任务已通过：\n` + children.map((c) => `- ${c.title} → \`${c.branch}\``).join("\n");
  d.patch = { status: "ready", stageIdx: parent.preset.stages.length, progress: "子任务全部通过" };
  d.notifies.push({ taskId: parent.id, kind: "ready", text });
  return d;
}

/**
 * Deps gate for a child task: "go" | "wait" | reason to skip it.
 * A blocked dependency is waiting for a human and may still be retried / accepted → keep waiting.
 */
export function depsGate(deps: Task[]): "go" | "wait" | string {
  const bad = deps.find((t) => t.status === "failed" || t.status === "dropped");
  if (bad) return `跳过：前置任务 ${bad.title} ${bad.status === "dropped" ? "已终止" : "已放弃"}`;
  return deps.every((t) => t.status === "ready") ? "go" : "wait";
}

// ---- human-facing decision text ------------------------------------------------

const STAGE_NAME: Record<string, string> = {
  plan: "规划", design_review: "设计评审", impl: "实现", review: "评审", critique: "评审", test: "测试",
  repro: "复现", fix: "修复", research: "调研", summary: "汇总", review_a: "评审", review_b: "第二评审",
};
export const stageName = (id: string) => STAGE_NAME[id] ?? id;
const clipLine = (s: string, n: number) => { const t = (s || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const sv = (v: any) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const isMajor = (it: any) => typeof it !== "string" && /blocker|major|critical|high|严重/i.test(String(it?.severity ?? ""));

/** Stage after `stageIdx` that a human 「接受」 would continue with (undefined = task would be done) */
export function nextStageAfter(task: Task, stageIdx: number): StageDef | undefined {
  return task.preset.stages[stageIdx + 1];
}


/** Stage index children start from: the stage right after the planner stage */
export function childStartStage(task: Task): number {
  const i = task.preset.stages.findIndex((s) => task.preset.roles[s.role]?.output === "plan");
  return i >= 0 ? i + 1 : 0;
}
