// =============================================================================
// orc — per-stage prompt assembly
// =============================================================================
// Agents get everything they need in the prompt (goal, spec, feedback, diff,
// notes path) instead of task-board tools, so any CLI can fill any role (002 §4.2).
// =============================================================================
import type { Attempt, LaunchPayload, OutputKind, ResolvedRole, StageDef, Task } from "./types";

const CONTRACT: Record<OutputKind, string> = {
  plan: `{"spec": "可验收的规格：要做什么、不做什么、验收标准", "subtasks": [{"title": "…", "spec": "…", "deps": [0]}], "summary": "一句话", "notes": ["值得团队记住的发现/决策"]}
- 只有当工作确实可以并行、且每块能独立验收时才拆 subtasks（2～5 个）；否则 subtasks 给空数组 []。
- deps 是本数组里**排在前面**的子任务下标。`,
  impl: `{"status": "done" | "blocked", "summary": "改了什么 / 为什么卡住", "notes": ["…"]}
- 不要自己 git commit / push，orc 会在你结束后提交工作区。
- 只有在缺信息、缺权限、需要人做决定时才用 "blocked"。`,
  verdict: `{"verdict": "approve" | "revise", "issues": [{"severity": "blocker" | "major" | "minor", "file": "路径", "line": 12, "desc": "问题与建议"}], "summary": "一句话结论", "notes": ["…"]}
- 只有存在 blocker / major 问题时才给 "revise"；minor 只记录，不阻塞。
- 你是只读角色：不要修改任何文件（改了会被 orc 回滚并记为违规）。`,
  test: `{"pass": true | false, "cases": [{"name": "…", "cmd": "如何复现", "result": "pass" | "fail", "detail": "…"}], "summary": "一句话", "notes": ["…"]}
- 用例要覆盖规格里的验收标准与边界/异常；你新增的测试文件会被 orc 单独提交。
- 不要修改业务代码；发现缺陷就 pass=false 并写清复现方式。`,
  report: `{"summary": "完整结论（markdown）", "notes": ["…"]}`,
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
