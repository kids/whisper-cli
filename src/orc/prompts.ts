// =============================================================================
// orc — per-stage prompt assembly
// =============================================================================
// Agents get everything they need in the prompt (goal, spec, feedback, diff,
// notes path) instead of task-board tools, so any CLI can fill any role (002 §4.2).
// =============================================================================
import type { Issue } from "./output";
import type { Attempt, LaunchPayload, OutputKind, ResolvedRole, StageDef, Task } from "./types";

export const CONTRACT: Record<OutputKind, string> = {
  plan: `{"spec": "可验收的规格：要做什么、不做什么、验收标准", "subtasks": [{"title": "…", "spec": "…", "deps": [0]}], "summary": "一句话", "notes": ["值得团队记住的发现/决策"]}
- 只有当工作确实可以并行、且每块能独立验收时才拆 subtasks（2～5 个）；否则 subtasks 给空数组 []。
- deps 是本数组里**排在前面**的子任务下标。`,
  impl: `最后**单独一行**写结论（这是唯一判定依据，不要放进代码块）：
[[done]] 改了什么、怎么验证的
或
[[blocked]] 卡在哪、需要人做什么
- 想给团队留笔记，就单独写 [[note]] 一句话（会进共享笔记），可以写多行。
- 不要自己 git commit / push，orc 会在你结束后提交工作区。
- 只有在缺信息、缺权限、需要人做决定时才用 [[blocked]]。`,
  verdict: `最后**单独一行**写结论（这是唯一判定依据，不要放进代码块）：
[[approve]] 一句大白话结论：现在能不能用
或
[[revise]] 一句大白话结论：差在哪
- 每条问题单独一行：[[major]] 文件:行 问题与建议，并写清不修会出什么实际问题、举一个具体例子；次要的用 [[minor]] 文件:行 建议。
- 只有 major 才算不过；minor 只记录，不阻塞。
- 后果不用术语和代码名（如「"利润增长 5%"和"利润下降 5%"会被当成同一条事实合并」）。人要靠它决定继续改还是接受现状。
- 想留笔记给团队就单独写 [[note]] 一句话。
- 你是只读角色：不要修改任何文件（改了会被 orc 回滚并记为违规）。`,
  test: `最后**单独一行**写结论（这是唯一判定依据，不要放进代码块）：
[[pass]] 一句话
或
[[fail]] 一句话：哪条没过
- 没过的用例逐条写在正文里（名称 / 怎么复现 / 实际结果）。
- 用例要覆盖规格里的验收标准与边界/异常；你新增的测试文件会被 orc 单独提交。
- 不要修改业务代码；发现缺陷就 [[fail]] 并写清复现方式。`,
  report: `最后**单独一行**写 [[report]] 一句话摘要，正文写完整结论（markdown）。`,

  brief: `{"situation": "一两句话：现在在做什么、卡在哪", "state": {"done": ["已经做到并验证过的事（带证据：测试名/数字/提交号）"], "not_done": ["还没做到或没验证的，以及为什么重要"]}, "blockers": [{"what": "卡点", "why_stuck": "为什么改不动：技术约束 / 缺信息 / 评审口径不一致", "evidence": "文件:行号 或 命令输出"}], "options": [{"name": "简短名字", "what": "具体怎么做", "cost": "要花的时间/代价", "risk": "风险", "reversible": "能补救 / 不能补救", "recommended": true}], "recommendation": "建议哪条，为什么", "needs_from_human": "要他补的一句话、一个口径或一个选择", "auto": "none" | "continue_with_known_issues", "known_issues": ["auto=continue_with_known_issues 时逐条写清放弃/暂缓的是什么，用户会看到"]}
- 2～4 个方案，必须是真有差别的路，不是同一个方向的微调。
- 拿不准能不能带着问题继续时，auto 用 "none"。`.replace("$",""),
  action: `{"action": "…"}（监督者动作，格式见 loop 提示词）`,
};

export interface PromptContext {
  task: Task;
  stage: StageDef;
  role: ResolvedRole;
  launch: LaunchPayload;
  /** Last passing attempt per earlier stage (summaries) */
  history: Attempt[];
  diff?: { stat: string; diff: string; log: string };
  notesPath: string;
  notesTail: string;
  inbox: string[];
}

export function buildStagePrompt(c: PromptContext): string {
  const { task, stage, role } = c;
  const total = task.preset.stages.length;
  const out: string[] = [];
  out.push(`# orc 任务 #${task.id} · 阶段 ${stage.id}（${task.stageIdx + 1}/${total}）· 你的角色：${role.name}`);
  if (c.launch.recover) {
    out.push(`> ⚠️ 恢复运行：上一次运行被中断（进程重启）。在重复任何对外操作（提交、推送、发消息、改远端）之前，先检查工作区、git 历史和远端状态，确认哪些已经做过。`);
  }
  if (c.launch.note) out.push(`> ⚠️ ${c.launch.note}`);

  out.push(`## 目标\n${task.goal}`);
  if (task.parentId) out.push(`（这是父任务 #${task.parentId} 拆出的子任务：${task.title}）`);
  out.push(`## 规格\n${task.spec || "（尚无规格）"}`);
  out.push(`## 工作区\n当前目录是本任务专用的 git worktree（分支 \`${task.branch}\`，基线 \`${task.baseRef.slice(0, 12)}\`）。只在这里工作。`);

  if (c.history.length) {
    out.push(`## 之前阶段的结论\n` + c.history.map(historyLine).join("\n"));
  }
  if (role.output === "verdict" || role.output === "test") {
    out.push(`## 评审口径（按任务性质定的，以它为准）\n${task.bar || "没有特别说明：按「目标是否达成、结论是否站得住」把关。会让结论错的问题才算不过；风格、可维护性、更进一步的严谨性记为建议。"}`);
  }
  if (task.feedback) out.push(`## 必须处理的反馈\n${task.feedback}`);
  if (c.inbox.length) out.push(`## 新增输入（来自人）\n${c.inbox.map((m) => `- ${m}`).join("\n")}`);
  if (c.diff) {
    out.push(`## 本任务相对基线的改动\n提交：\n\`\`\`\n${c.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${c.diff.stat || "(无改动)"}\n\`\`\``);
    if (c.diff.diff) out.push(`\`\`\`diff\n${c.diff.diff}\n\`\`\``);
  }
  out.push(`## 团队共享笔记\n路径：\`${c.notesPath}\`（只读参考；要新增笔记就写 \`[[note]] 一句话\`，orc 会追加进去）` +
    (c.notesTail ? `\n最近内容：\n${c.notesTail}` : ""));

  out.push(`## 角色说明\n${role.prompt}`);
  out.push(`## 进展汇报\n工作较久时，可以单独输出一行 \`[[progress]] 一句话进展\`，会原样写到任务卡上（卡片没有别的状态壳）。`);
  out.push(`## 输出约定（必须遵守）\n你的**最后一条回复**要给出结论，格式：\n${CONTRACT[role.output]}`);
  return out.join("\n\n");
}

function historyLine(a: Attempt): string {
  const head = `- ${a.stageId}（${a.role}）：${a.parsed?.summary || "(无摘要)"}`;
  const issues: Issue[] = a.parsed?.issues ?? [];
  if (!issues.length) return head;
  const verdict = a.parsed?.kind === "verdict" ? ` [${a.parsed.pass ? "approve" : "revise"}]` : "";
  return head + verdict + "\n" + issues.slice(0, 15).map((it) =>
    `  - [${it.severity}] ${it.file ? `${it.file}${it.line ? ":" + it.line : ""} ` : ""}${it.desc}`,
  ).join("\n");
}

/**
 * 决策说明: the advisor's prompt. Unlike a stage prompt it carries every attempt of the task
 * (who said what, round by round), because the point is to explain why trying again is not enough.
 */
export function buildBriefPrompt(c: {
  task: Task; role: ResolvedRole; stageName: string; attempts: Attempt[]; diff?: { diff?: string; stat?: string; log?: string };
  notesPath: string; notesTail?: string; mode?: "arbitrate" | "escalate"; rounds?: number;
}): string {
  const { task, role } = c;
  const out: string[] = [];
  out.push(`# orc 任务 #${task.id} · 决策说明 · 你的角色：${role.name}`);
  out.push(c.mode === "arbitrate"
    ? `## 为什么找你\n「${c.stageName}」第 ${c.rounds ?? "?"} 轮又没过，而且这次挑出来的问题跟上一轮不一样——是**每轮都在换新问题**，说明可能不是工作没做到位，而是评审的尺子跟任务的定位对不上。\n先判断：按这份任务的**评审口径**（见下），剩下这些问题里有哪些真的会让结论站不住？哪些只是更进一步的严谨性、按口径不该阻塞？\n- 如果按口径剩下的都不影响结论：auto 设 continue_with_known_issues，把不修的逐条写进 known_issues（人能看到）。\n- 如果确实还有影响结论的问题：auto 用 none，把剩下的路写清楚交给人决定。`
    : `## 为什么找你\n「${c.stageName}」这个环节已经退回几轮，还是没过。你要给人写一份说明，让他看完就能决定：接着改、换个做法、缩小范围，还是不做了。说不清就说明你没看清现场——先读文件、看提交和测试结果，再写。`);
  out.push(`## 这份任务的评审口径（主 agent 按任务性质定的）\n${c.task.bar || "（没写特别口径）按「目标是否达成、结论是否站得住」把关；更进一步的严谨性属于建议。"}`);
  out.push(`## 任务目标\n${task.goal}`);
  out.push(`## 规格（验收标准在这里面）\n${task.spec || "（没有单独写规格）"}`);
  if (task.branch) out.push(`## 工作区\n当前目录是本任务的分支 \`${task.branch}\`（基线 \`${task.baseRef.slice(0, 12)}\`）。仓库里的报告、代码、测试都在这里。`);
  out.push(`## 这个任务的完整经过\n` + c.attempts.map(briefAttemptLine).join("\n"));
  if (c.diff) out.push(`## 现在相对基线的改动\n提交：\n\`\`\`\n${c.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${c.diff.stat || "(无改动)"}\n\`\`\``);
  if (c.notesTail) out.push(`## 团队共享笔记（最近的）\n${c.notesTail}`);
  out.push(`## 角色说明\n${role.prompt}`);
  out.push(`## 输出约定（必须遵守）\n你的**最后一条回复**必须以一个 JSON 对象结尾（可放在 \`\`\`json 代码块里），格式：\n${CONTRACT.brief}`);
  return out.join("\n\n");
}

function briefAttemptLine(a: Attempt): string {
  const p = a.parsed;
  const head = `- 第 ${a.id} 次 · ${a.stageId}（${a.role}）· ${a.status === "done" ? "完成" : a.status}`;
  if (!p) return `${head}${a.error ? `：${a.error.slice(0, 200)}` : ""}`;
  const lines = [`${head}：${p.summary || "(无摘要)"}`];
  for (const it of (p.issues ?? []).slice(0, 12)) {
    lines.push(`  - [${it.severity}] ${it.file ? `${it.file}${it.line ? ":" + it.line : ""} ` : ""}${it.desc}`);
  }
  return lines.join("\n");
}
