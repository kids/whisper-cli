// =============================================================================
// orc — per-stage prompt assembly
// =============================================================================
// Agents get everything they need in the prompt (goal, spec, feedback, diff,
// notes path) instead of task-board tools, so any CLI can fill any role (002 §4.2).
// =============================================================================
import type { Attempt, LaunchPayload, OutputKind, ResolvedRole, StageDef, Task } from "./types";

export const CONTRACT: Record<OutputKind, string> = {
  plan: `{"spec": "可验收的规格：要做什么、不做什么、验收标准", "subtasks": [{"title": "…", "spec": "…", "deps": [0]}], "summary": "一句话", "notes": ["值得团队记住的发现/决策"]}
- 只有当工作确实可以并行、且每块能独立验收时才拆 subtasks（2～5 个）；否则 subtasks 给空数组 []。
- deps 是本数组里**排在前面**的子任务下标。`,
  impl: `{"status": "done" | "blocked", "summary": "改了什么 / 为什么卡住", "known_issues": ["这次没做或做不彻底的，写清影响"], "notes": ["…"]}
- 不要自己 git commit / push，orc 会在你结束后提交工作区。
- 只有在缺信息、缺权限、需要人做决定时才用 "blocked"。`,
  verdict: `{"verdict": "approve" | "revise", "issues": [{"severity": "blocker" | "major" | "minor", "file": "路径", "line": 12, "desc": "问题与建议（给实现者看，可以用术语）", "impact": "给不看代码的人看：不修会出什么实际问题，举一个具体例子"}], "summary": "一句大白话结论：现在能不能用、差在哪", "notes": ["…"]}
- 只有存在 blocker / major 问题时才给 "revise"；minor 只记录，不阻塞。
- blocker / major 必须写 impact：不用术语和代码名，说清后果并举例（如「"利润增长 5%"和"利润下降 5%"会被当成同一条事实合并」）。人要靠它决定是继续改还是接受现状。
- 你是只读角色：不要修改任何文件（改了会被 orc 回滚并记为违规）。`,
  test: `{"pass": true | false, "cases": [{"name": "…", "cmd": "如何复现", "result": "pass" | "fail", "detail": "…"}], "summary": "一句话", "notes": ["…"]}
- 用例要覆盖规格里的验收标准与边界/异常；你新增的测试文件会被 orc 单独提交。
- 不要修改业务代码；发现缺陷就 pass=false 并写清复现方式。`,
  report: `{"summary": "完整结论（markdown）", "notes": ["…"]}`,
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
  if (task.feedback) out.push(`## 必须处理的反馈\n${task.feedback}`);
  if (c.inbox.length) out.push(`## 新增输入（来自人）\n${c.inbox.map((m) => `- ${m}`).join("\n")}`);
  if (c.diff) {
    out.push(`## 本任务相对基线的改动\n提交：\n\`\`\`\n${c.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${c.diff.stat || "(无改动)"}\n\`\`\``);
    if (c.diff.diff) out.push(`\`\`\`diff\n${c.diff.diff}\n\`\`\``);
  }
  out.push(`## 团队共享笔记\n路径：\`${c.notesPath}\`（只读参考；要新增笔记请写进最终 JSON 的 notes，orc 会追加）` +
    (c.notesTail ? `\n最近内容：\n${c.notesTail}` : ""));

  out.push(`## 角色说明\n${role.prompt}`);
  out.push(`## 进展汇报\n工作较久时，可以单独输出一行 \`[[progress]] 一句话进展\`，会显示在任务卡片上。`);
  out.push(`## 输出约定（必须遵守）\n你的**最后一条回复**必须以一个 JSON 对象结尾（可放在 \`\`\`json 代码块里），格式：\n${CONTRACT[role.output]}`);
  return out.join("\n\n");
}

function historyLine(a: Attempt): string {
  const head = `- ${a.stageId}（${a.role}）：${a.parsed?.summary || "(无摘要)"}`;
  const issues: any[] = a.parsed?.kind === "verdict" ? a.parsed.value?.issues ?? [] : [];
  if (!issues.length) return head;
  const verdict = a.parsed.value?.verdict ? ` [${a.parsed.value.verdict}]` : "";
  return head + verdict + "\n" + issues.slice(0, 15).map((it) =>
    typeof it === "string" ? `  - ${it}` : `  - [${it.severity ?? "issue"}] ${it.file ? it.file + (it.line ? ":" + it.line : "") + " " : ""}${it.desc ?? JSON.stringify(it)}`,
  ).join("\n");
}

/**
 * 决策说明: the advisor's prompt. Unlike a stage prompt it carries every attempt of the task
 * (who said what, round by round), because the point is to explain why trying again is not enough.
 */
export function buildBriefPrompt(c: {
  task: Task; role: ResolvedRole; stageName: string; attempts: Attempt[]; diff?: { diff?: string; stat?: string; log?: string };
  notesPath: string; notesTail?: string;
}): string {
  const { task, role } = c;
  const out: string[] = [];
  out.push(`# orc 任务 #${task.id} · 决策说明 · 你的角色：${role.name}`);
  out.push(`## 为什么找你\n「${c.stageName}」这个环节已经退回几轮，还是没过。你要给人写一份说明，让他看完就能决定：接着改、换个做法、缩小范围，还是不做了。说不清就说明你没看清现场——先读文件、看提交和测试结果，再写。`);
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
  const issues: any[] = p.kind === "verdict" ? p.value?.issues ?? [] : [];
  for (const it of issues.slice(0, 12)) {
    if (typeof it === "string") { lines.push(`  - ${it}`); continue; }
    lines.push(`  - [${it.severity ?? "issue"}] ${it.file ? it.file + (it.line ? ":" + it.line : "") + " " : ""}${it.desc ?? ""}${it.impact ? `（后果：${it.impact}）` : ""}`);
  }
  const cases: any[] = p.kind === "test" ? p.value?.cases ?? [] : [];
  for (const x of cases.filter((x: any) => x && x.result !== "pass" && x.pass !== true).slice(0, 8)) {
    lines.push(`  - ✗ ${x.name ?? "case"}：${x.detail ?? x.result ?? ""}`);
  }
  if (p.kind === "impl" && p.value?.known_issues?.length) lines.push(`  - 自报的已知问题：${p.value.known_issues.join("；")}`);
  return lines.join("\n");
}
