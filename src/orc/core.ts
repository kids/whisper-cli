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
  /** dependency branch merge hit a content conflict: deterministic, never retried as a model fault */
  | { kind: "merge_conflict"; branch: string; files: string[]; detail: string }
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

/**
 * A role that stops without a conclusion (crash, timeout, turn ended mid-work) has simply not
 * finished: it is continued, never handed to a human. Only this many stops in a row with nothing
 * new committed mean the model or whisper itself is broken.
 */
export const STALL_LIMIT = 3;
/** Runaway guard: continuations of one stage in total, even when each one commits something */
export const CONTINUE_CAP = 20;

/** 实现者 block 时，先分清是“环境缺东西”还是“口径/测试断言冲突”，不要一律推给人 */
const ENV_BLOCK = /(缺数据|数据[^\n]{0,12}(为空|空的|缺失|丢失|没有)|data\s*\/[^\n]{0,12}(为空|空|不存在)|OOM|out of memory|内存不足|显存不足|磁盘[^\n]{0,8}(满|不足)|空间不足|permission denied|EACCES|ENOENT|no such file|网络不通|无法访问|代理不可用|GPU[^\n]{0,8}(不可用|没有|不足))/i;
const SPEC_CONFLICT = /(断言[^\n]{0,40}(冲突|不符|失败|==|写死|硬编码|读数)|硬编码[^\n]{0,30}(测试|断言)|测试[^\n]{0,20}(写死|硬编码)|与[^\n]{0,16}(冻结)?口径[^\n]{0,10}(冲突|不一致)|规格[^\n]{0,16}冲突|口径[^\n]{0,12}(冲突|不一致))/i;

const empty = (): Decision => ({ patch: {}, launches: [], notifies: [], children: [] });

const normPath = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
const pathOverlap = (a: string, b: string): boolean => {
  const x = normPath(a), y = normPath(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

/**
 * Planner declares each subtask's files. If two siblings that could run in parallel touch the same
 * path, make the later one depend on the earlier one, so the worktree merge has nothing to resolve.
 * Deps only point backwards, so this cannot create a cycle.
 */
export function serializeOverlapping(subtasks: PlanSubtask[]): PlanSubtask[] {
  const kids = subtasks.map((s) => ({ ...s, deps: [...s.deps], files: [...(s.files ?? [])] }));
  for (let i = 1; i < kids.length; i++) {
    for (let j = 0; j < i; j++) {
      if (kids[i].deps.includes(j)) continue;
      if (!kids[i].files.some((f) => kids[j].files.some((g) => pathOverlap(f, g)))) continue;
      kids[i].deps.push(j);
    }
    kids[i].deps = [...new Set(kids[i].deps)].sort((a, b) => a - b);
  }
  return kids;
}

/**
 * An implementer "blocked" whose only reason is being cut off (CLI loop detection, timeout, turn
 * limit) and asking to be told 「继续」. Real blockers (missing access, a choice for the human)
 * do not match: they name a decision or a missing resource, not an interruption.
 */
export function interruptedOnly(summary: string): boolean {
  const s = summary || "";
  const cutOff = /被.{0,10}(中断|打断|终止|判定为循环)|判定为(死)?循环|中途(停|断)|interrupted|cut off|loop detect/i.test(s)
    || /(请|可以|麻烦)?回复\s*[「"“]?\s*继续/.test(s);
  const needsHuman = /(需要|请)(你|人|用户)?(决定|确认|选择|提供|授权|批准)|权限|密钥|token|账号|无法访问|拒绝访问|二选一/i.test(s.replace(/(请|可以|麻烦)?回复\s*[「"“]?\s*继续[」"”]?/g, ""));
  return cutOff && !needsHuman;
}

export interface DecideCtx {
  /** the previous failed verdict/test of the same stage — used to see whether the problem set is shrinking */
  prev?: ParsedOutput;
  /** safety cap on rework rounds regardless of progress (a runaway guard, not the normal exit) */
  cap?: number;
  /** this attempt committed something new to the worktree */
  progressed?: boolean;
}

export function decideAfterAttempt(task: Task, outcome: Outcome, ctx: DecideCtx = {}): Decision {
  const d = empty();
  const stage = task.preset.stages[task.stageIdx];
  const loops = { ...task.loops };
  const bump = (k: string) => (loops[k] = (loops[k] ?? 0) + 1);
  const block = (why: string) => {
    d.patch = { ...d.patch, status: "blocked", loops, progress: why };
    // a human deciding here needs the situation, not a menu: what was tried and where the work is
    const tried = loops[stage.id] ? `\n这一环已经来回 ${loops[stage.id]} 次。` : "";
    const where = task.branch ? `\n改动都在分支 \`${task.branch}\` 里，没有丢。` : "";
    d.notifies.push({ taskId: task.id, kind: "decision", text: `${why}${tried}${where}` });
    return d;
  };

  if (outcome.kind === "cancelled") {
    d.patch = { status: "dropped", progress: "已被用户终止" };
    d.notifies.push({ taskId: task.id, kind: "info", text: "任务已终止" });
    return d;
  }

  // A content conflict is a planning/dependency problem, not a transient failure. Retrying merges the
  // same commits onto the same base and fails the same way, so stop at once and hand over the file list.
  if (outcome.kind === "merge_conflict") {
    const files = outcome.files.length
      ? outcome.files.join("、")
      : `（git 没有列出冲突文件：${outcome.detail.slice(0, 200) || "无输出"}）`;
    return block(`依赖分支 \`${outcome.branch}\` 合并冲突：${files}。这是两边改了同一处的确定性冲突，不是模型或 whisper 故障；已停止自动重试。解掉冲突后说「重试」会从这里继续。`);
  }

  // "blocked" that only says "I got cut off, tell me to continue" is an unfinished run, not a decision
  const selfStopped = outcome.kind === "parsed" && outcome.parsed.kind === "impl" && !outcome.parsed.pass && interruptedOnly(outcome.parsed.summary);

  if (outcome.kind === "run_error" || outcome.kind === "unparseable" || selfStopped) {
    const k = `stall:${stage.id}`;
    loops[k] = ctx.progressed ? 0 : (loops[k] ?? 0) + 1;
    const total = bump(`cont:${stage.id}`);
    const name = stageName(stage.id);
    if (loops[k] >= STALL_LIMIT || total >= CONTINUE_CAP) {
      const what = loops[k] >= STALL_LIMIT
        ? `连续 ${loops[k]} 次${outcome.kind === "run_error" ? `运行失败（${outcome.error.slice(0, 200)}）` : selfStopped ? "中途被打断" : "停下时没给结论"}，期间没有任何新改动`
        : `已续跑 ${total} 次仍没收尾`;
      d.patch = { status: "failed", loops, progress: `${name}${what}` };
      // spawn errors (E2BIG, ENOENT…) are whisper's own: the agent never started, the task is fine
      const ours = outcome.kind === "run_error" && /spawn|E2BIG|ENOENT|EACCES/i.test(outcome.error);
      d.notifies.push({
        taskId: task.id,
        kind: "failed",
        text: ours
          ? `${name}${what}。agent 根本没能启动，是 whisper 自己的问题，任务本身和已做的改动都没事，已停下。修好后说「继续团队任务」会从这里接着跑。`
          : `${name}${what}。这不是任务本身的问题，是上游模型或 whisper 出了故障，已停下。修好后说「重试」会从这里接着跑。`,
      });
      return d;
    }
    const kind = task.preset.roles[stage.role]?.output;
    const why = outcome.kind === "unparseable"
      ? "上一轮你停下时还没写结论行。"
      : outcome.kind === "parsed"
        ? `上一轮你中途停了（${outcome.parsed.summary.slice(0, 200)}）。不用等人说「继续」，现在就接着做；长作业放后台跑、看日志文件，别高频轮询。`
        : outcome.timedOut
          ? "上一轮运行到了时长上限被终止。耗时长的步骤放后台跑、结果落盘。"
          : `上一轮运行异常退出：${outcome.error.slice(0, 300)}。`;
    d.patch = { loops, progress: `${name}还没收尾，接着跑` };
    d.launches.push({
      taskId: task.id,
      stageIdx: task.stageIdx,
      resume: true,
      note: `${why}先看工作区和后台作业的现状，已完成的不要重做；做完了就直接给结论，没做完就接着做完再给：${kind ? conclusionHint(kind) : "按约定给结论"}。`,
    });
    return d;
  }

  delete loops[`stall:${stage.id}`];
  delete loops[`cont:${stage.id}`];
  const p = outcome.parsed;

  if (p.kind === "plan") {
    d.patch.spec = p.spec;
    if ((p.subtasks?.length ?? 0) >= 2) {
      d.patch = { ...d.patch, status: "waiting_children", loops, progress: `已拆成 ${p.subtasks!.length} 个子任务` };
      d.children = serializeOverlapping(p.subtasks!);
      return d;
    }
  }

  if (p.kind === "impl" && !p.pass) {
    const why = p.summary || "（未说明原因）";
    const flat = why.replace(/\s+/g, " ");
    // 环境缺东西：先挂起定时检查，不叫人；连续 3 次还没恢复才交给人
    if (ENV_BLOCK.test(flat)) {
      const key = `env:${stage.id}`;
      const n = (loops[key] ?? 0) + 1;
      loops[key] = n;
      if (n <= 3) {
        d.patch = { ...d.patch, status: "waiting", loops, progress: `等环境：${clipLine(why, 80)}（第 ${n}/3 次检查）` };
        d.launches.push({
          taskId: task.id, stageIdx: task.stageIdx, resume: true, delayMs: 10 * 60_000,
          note: `上一轮因为环境缺失停下：${clipLine(why, 400)}。先只检查环境是否恢复，不要重复已完成的；恢复了再继续，仍然缺就照原样 [[blocked]] 说明。`,
        });
        d.notifies.push({ taskId: task.id, kind: "info", text: `**${task.title}：先等环境，不用你处理**\n${clipLine(why, 300)}\n每 10 分钟自动检查一次（第 ${n}/3 次）。` });
        return d;
      }
      return block(`缺环境，已检查 3 次仍未恢复：${why}`);
    }
    // 测试断言 / 口径冲突：这是技术选择，先让实现者按冻结口径修一次，不推给人
    if (SPEC_CONFLICT.test(why)) {
      const key = `spec:${stage.id}`;
      const n = (loops[key] ?? 0) + 1;
      loops[key] = n;
      if (n <= 1) {
        d.patch = { ...d.patch, status: "running", loops, progress: "口径冲突：已让实现者按冻结口径修正后继续" };
        d.launches.push({
          taskId: task.id, stageIdx: task.stageIdx, resume: true,
          note: `这是测试断言/规格口径冲突，不是缺资源，也不是要人拍板：以任务书和冻结口径为准修正测试或实现，改完给 [[done]]；只有确实要改目标/验收才 [[blocked]]。原因：${clipLine(why, 400)}`,
        });
        d.notifies.push({ taskId: task.id, kind: "info", text: `**${task.title}：按冻结口径继续**\n${clipLine(why, 300)}\n已让实现者先修口径冲突，不把技术选择推给人。` });
        return d;
      }
      return block(`口径冲突，已让实现者按冻结口径修过一次仍未过：${why}`);
    }
    return block(`${stage.id} 无法继续：${why}`);
  }

  if (p.pass || stage.advisory) {
    const next = task.stageIdx + 1;
    // A pass on the stage that produced the feedback means it has been addressed
    const clears = task.feedback.startsWith(`【${stage.id} 未通过】`);
    if (next >= task.preset.stages.length) {
      d.patch = { ...d.patch, stageIdx: next, status: "ready", loops, feedback: clears ? "" : task.feedback, progress: p.summary || "全部阶段通过" };
      d.notifies.push({ taskId: task.id, kind: "ready", text: p.summary || "全部阶段通过" });
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
  const cap = ctx.cap ?? stage.maxLoops ?? 500;
  const fresh = before ? now.major.filter((k) => !before.major.includes(k)) : [];

  // Key equality is too strict an identity for LLM prose: re-wording an issue, or moving it to
  // another file, mints a new key. So convergence is judged by the major count first — a drop
  // means issues are really closing, whatever the wording. Only "new problems, and no drop"
  // means the bar (not the work) may be the question → let the advisor arbitrate.
  const converging = !!before && now.major.length < before.major.length;
  const keepGoing = used <= cap && (fresh.length === 0 || converging);
  if (keepGoing) {
    const target = task.preset.stages.findIndex((s) => s.id === stage.onFail);
    d.patch = {
      stageIdx: target,
      status: "running",
      loops,
      feedback: formatFeedback(stage.id, p),
      progress: `${stage.id} 未通过，退回 ${stage.onFail}（第 ${used} 次；问题从 ${before?.major.length ?? "?"} 条到 ${now.major.length} 条${fresh.length && converging ? `，其中 ${fresh.length} 条换了说法` : ""}）`,
    };
    d.launches.push({ taskId: task.id, stageIdx: target });
    return d;
  }

  d.patch = { ...d.patch, status: "running", loops, progress: `${stageName(stage.id)}又冒出新问题、数量没降（${before?.major.length ?? "?"} → ${now.major.length}），正在核对评审口径` };
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
