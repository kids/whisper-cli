// =============================================================================
// orc — per-stage prompt assembly
// =============================================================================
// Agents get everything they need in the prompt (goal, spec, feedback, diff,
// notes path) instead of task-board tools, so any CLI can fill any role (002 §4.2).
// =============================================================================
import type { Issue } from "./output";
import type { Attempt, LaunchPayload, OutputKind, ResolvedRole, StageDef, Task } from "./types";

// Roles judged by a conclusion line (see orc/output.ts CONCL). The prompt states the rule
// a second time as a self-check, because "写完了" in prose is the most common way a stage stalls.
const CONCL_TAG: Partial<Record<OutputKind, string>> = { impl: "done", verdict: "approve", test: "pass", report: "report" };
const ROLE_HAS_CONCLUSION = new Set<OutputKind>(Object.keys(CONCL_TAG) as OutputKind[]);

export const CONTRACT: Record<OutputKind, string> = {
  plan: `{"spec": "可验收的规格：要做什么、不做什么、验收标准", "subtasks": [{"title": "…", "spec": "…", "deps": [0], "files": ["path/to/file"]}], "summary": "一句话", "notes": ["值得团队记住的发现/决策"]}
- 只有当工作确实可以并行、且每块能独立验收时才拆 subtasks（2～5 个）；否则 subtasks 给空数组 []。
- deps 是本数组里**排在前面**的子任务下标。
- 每个子任务必须写 "files"：它计划修改或新建的文件路径（目录写到目录）。**并行子任务的 files 不能有交集**；同一文件只能有一个 owner，别的子任务要改它就通过 deps 排到它后面，不能并行。
- 共享文档（README、*_REPORT.md、EXPERIMENT_LOG.md、CHANGELOG.md 等）尤其如此：要么只让一个子任务写，要么各写各的小节并指定唯一 owner 合并；禁止两个并行子任务改同一段。`,
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

  brief: `正文写清楚，人看完就能决定：
- 现在到哪一步：已经做到并验证过的事（带测试名/数字/提交号），还没做到或没验证的
- 卡在哪、为什么再试一轮也多半不动（技术约束 / 缺信息 / 评审口径不一致，带文件:行号或命令输出）
- 可以怎么走：2～4 条真正不同的路，各自的代价、风险、能不能补救，标出你建议的那条和理由
- 需要人给你什么：一句话、一个口径，还是一个选择

如果按这份任务的评审口径，剩下的问题可以接受、可以带着往下走：正文照写，末尾单独一行写
[[continue_with_known_issues]]
后面逐条列出暂不解决的问题（人能看到）。`,
  action: `{"action": "…"}（监督者动作，格式见 loop 提示词）`,
};

/**
 * Rework discipline, appended to every "必须处理的反馈". A bare issue list (file:line + text)
 * makes the agent patch exactly those lines: the number is fixed, the table is not; one file
 * is fixed, another still says the opposite. Classification first, then a repo-wide sweep.
 */
export const REVISION_RULES = [
  "### 修订要求（别只改被点名的行）",
  "1. 先归类：定义/判据（怎么算命中、怎么判泄漏）、数据/口径（时间窗、计数、来源）、实现/调用点、文档与注释同步。",
  "2. 定义/判据类先定死，只定一次；再改数据与实现，最后同步文档。顺序反了会来回返工。",
  "3. 每改一个说法，在整仓搜同类表述：相反的说法、表格里的旧数字、中英文对应段落、复制过去的实现，一次改完。",
  "4. 收尾逐条自查：上面每条反馈现在还能在原处（或别处）找到没改的内容吗？能就还没改完。",
  "5. 否决要分清是哪种失败再下结论：**方法本身错了**（换了思路才行）、**细节没做到位**（方向对，参数/边界/口径/覆盖范围差一点）、**环境或资源问题**（缺数据、跑不动、没网）三种是完全不同的结论。只有第一种才能写「这个方法不行」；第二种要写清楚「差在哪、下次补上哪一点就能再试」，不要因为一次没做成就把思路判死；第三种明确写「不是因为方法不行」。写不出属于哪一种，就说明还没查清失败原因。",
].join("\n");

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
  /** this task's own working-state file — the handover doc a new session starts from */
  statePath?: string;
  /** contents of that file (already trimmed by the caller) */
  prevState?: string;
  /** true when this attempt starts a session with no history to lean on */
  freshSession?: boolean;
}

export function buildStagePrompt(c: PromptContext): string {
  const { task, stage, role } = c;
  const total = task.preset.stages.length;
  const slug = (task.branch || "").replace(/^orc\//, "");
  const out: string[] = [];
  out.push(`# orc 任务 #${task.id} · 阶段 ${stage.id}（${task.stageIdx + 1}/${total}）· 你的角色：${role.name}`);
  if (c.launch.recover) {
    out.push(`> ⚠️ 恢复运行：上一次运行被中断（进程重启）。在重复任何对外操作（提交、推送、发消息、改远端）之前，先检查工作区、git 历史和远端状态，确认哪些已经做过。`);
  }
  if (c.launch.note) out.push(`> ⚠️ ${c.launch.note}`);

  out.push(`## 目标\n${task.goal}`);
  if (task.parentId) out.push(`（这是父任务 #${task.parentId} 拆出的子任务：${task.title}）`);
  out.push(`## 规格\n${task.spec || "（尚无规格）"}`);
  out.push(`## 工作区\n当前目录是本任务专用的 git worktree（分支 \`${task.branch}\`，基线 \`${task.baseRef.slice(0, 12)}\`）。代码改动只在这里工作。` +
    `\n**产物落盘**：仓库忽略的 \`tmp/\` 已软链到主仓库 \`tmp/orc/${slug}/\`，数据、日志、中间结果直接写 \`tmp/...\` 就会落在主仓库；不要把大文件写进 git 跟踪目录，也不要留在 worktree 里。`);
  if (role.output === "impl") {
    out.push(`## 依赖与共享文件\n- 依赖分支已由 orc 合并进当前分支；先 \`git log --oneline -8\` 确认，不要再自己 merge 一遍。\n- 改共享文档（README、*_REPORT.md、EXPERIMENT_LOG.md、CHANGELOG.md 等）只在自己的小节追加，不要重写别人段落。若发现依赖分支改过同一段、两边结论无法两全，用 [[blocked]] 写清文件和两边内容，不要自行删改对方结论。`);
  }

  if (c.history.length) {
    out.push(`## 之前阶段的结论\n` + c.history.map(historyLine).join("\n"));
  }
  if (role.output === "verdict" || role.output === "test") {
    out.push(`## 评审口径（按任务性质定的，以它为准）\n${task.bar || "没有特别说明：按「目标是否达成、结论是否站得住」把关。会让结论错的问题才算不过；风格、可维护性、更进一步的严谨性记为建议。"}`);
  }
  if (task.feedback) out.push(`## 必须处理的反馈\n${task.feedback}\n\n${REVISION_RULES}`);
  if (c.inbox.length) out.push(`## 新增输入（来自人）\n${c.inbox.map((m) => `- ${m}`).join("\n")}`);
  if (c.diff) {
    out.push(`## 本任务相对基线的改动\n提交：\n\`\`\`\n${c.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${c.diff.stat || "(无改动)"}\n\`\`\``);
    if (c.diff.diff) out.push(`\`\`\`diff\n${c.diff.diff}\n\`\`\``);
  }
  // Task working state: the handover doc. This is what keeps knowledge out of
  // the conversation — a fresh session (or a rotated one) reads it instead of
  // re-reading the repo to rebuild context, which is where the token blowups
  // came from (#38 re-read an 84K module all afternoon).
  if (c.statePath) {
    const head = c.freshSession
      ? `## 本任务状态文件（新会话，先读它）\n这是接手本任务的交接说明，上一轮不在你的会话里。**先按它了解进度，不要为了重建上下文把大文件整份重读**；只有它没覆盖到的地方，才用 grep/局部读取去核实。`
      : `## 本任务状态文件\n上一轮结束时写下的进度、决策和待办。以它为准继续，不要凭记忆重推。`;
    out.push(
      `${head}\n路径：\`${c.statePath}\`（本轮结束前改写它，见「输出约定」）` +
      (c.prevState ? `\n\n${c.prevState}` : `\n（还没有内容：这是本任务的第一次，写完这一轮就把当前进度、已定的决策、还没做的事写进去。）`),
    );
  }
  out.push(`## 团队共享笔记\n路径：\`${c.notesPath}\`（只读参考；要新增笔记就写 \`[[note]] 一句话\`，orc 会追加进去）` +
    (c.notesTail ? `\n最近内容：\n${c.notesTail}` : ""));
  out.push(`## 怎么读代码（省上下文）\n上下文里放的每一段源码，后面每一轮都要重新付一次费。要定位一个行为，先用 \`grep -n\` 拿到文件:行号，再只读那一段（Read 的 offset/limit，或 \`sed -n 'a,bp'\`）。\n- 超过约 500 行的文件不要整份读；确实需要通读时，先读目录/函数签名（\`grep -n "^\\(export \\)\\?\\(function\\|class\\|const .*=>\\)"\`）再按段读。\n- 报告、日志、CSV 一律先 \`wc -l\` / \`head\` / \`grep\` 定位，不要整份吐进上下文；需要反复用的中间结果落盘到 \`tmp/\`，下一轮从文件读结论而不是重新算一遍。\n- 已经确认过的结论写进状态文件，不要每轮重新推导；同一份大文件在一轮里读了一次以上，说明该把结论记下来了。`);

  out.push(`## 角色说明\n${role.prompt}`);
  out.push(`## 进展汇报\n工作较久时，可以单独输出一行 \`[[progress]] 一句话进展\`，会原样写到任务卡上（卡片没有别的状态壳）。`);
  out.push(`## 输出约定（必须遵守）\n这一轮回复结束就等于交付：后台作业要等它跑完、结果落盘再收尾，不要以「继续」「等它跑完」结束。\n你的**最后一条回复**要给出结论，格式：\n${CONTRACT[role.output]}${
    ROLE_HAS_CONCLUSION.has(role.output) ? `\n- 自检：回复发出前看最后一行是不是上面的标记行。**整条回复以结论行开头的那一行结尾**——不写这句话，本轮会被判为没收尾、白跑一次。别的任何写法（「完成了」「已修复」、或者在段落里夹一句 [[${CONCL_TAG[role.output]}]]）都不算。` : ""
  }${
    c.statePath ? `\n- 收尾前**改写状态文件** \`${c.statePath}\`（覆盖写，不是追加）。它是下一轮和下一个接手的角色唯一的交接物，控制在 4000 字内，只写这几节：\n  \`\`\`\n  ## 当前进度\n  做到哪一步、哪一步没做完（一到三行）\n  ## 已定的决策\n  - 决定 + 为什么（只写会影响后续判断的，不要抄代码）\n  ## 待办\n  - 还没做的事，按顺序\n  ## 已否决\n  - 先标失败类型：[方法错] / [细节没到位] / [环境问题]\n  - 只有 [方法错] 才算这条路不通；[细节没到位] 要写清楚差在哪一步、下次补什么就能再试，不要写「这条路不行」\n  ## 关键位置\n  文件:行号 —— 一眼要看哪里\n  \`\`\`\n  写状态文件优先于在回复里长篇复述；上下文里说过的结论，这里没写就等于丢了。` : ""
  }`);
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
    : `## 为什么找你\n「${c.stageName}」这个环节已经退回几轮，还是没过。你要给人写一份说明，让他看完就能决定：接着改、换个做法、缩小范围，还是不做了。说不清就说明你没看清现场——先读文件、看提交和测试结果，再写。
写的时候分开三种情况，别混成一句「反复失败」：**方法本身不行**、**方法对但某个细节一直没做到位**、**环境或资源不行**。后两种都还有救——要写清楚差的是哪一点、补上之后怎么再试一次，只把真正做不通的路判死。`);
  out.push(`## 这份任务的评审口径（主 agent 按任务性质定的）\n${c.task.bar || "（没写特别口径）按「目标是否达成、结论是否站得住」把关；更进一步的严谨性属于建议。"}`);
  out.push(`## 任务目标\n${task.goal}`);
  out.push(`## 规格（验收标准在这里面）\n${task.spec || "（没有单独写规格）"}`);
  if (task.branch) out.push(`## 工作区\n当前目录是本任务的分支 \`${task.branch}\`（基线 \`${task.baseRef.slice(0, 12)}\`）。仓库里的报告、代码、测试都在这里。`);
  out.push(`## 这个任务的完整经过\n` + c.attempts.map(briefAttemptLine).join("\n"));
  if (c.diff) out.push(`## 现在相对基线的改动\n提交：\n\`\`\`\n${c.diff.log || "(无提交)"}\n\`\`\`\n统计：\n\`\`\`\n${c.diff.stat || "(无改动)"}\n\`\`\``);
  if (c.notesTail) out.push(`## 团队共享笔记（最近的）\n${c.notesTail}`);
  out.push(`## 角色说明\n${role.prompt}`);
  out.push(`## 输出约定\n你的**最后一条回复**就是这份说明，用 markdown 写清楚：\n${CONTRACT.brief}`);
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

export interface ReplanCtx {
  task: Task; role: ResolvedRole; text: string; stageId: string; stages: { id: string; name: string }[];
}

/** 人中途插话时先判断影响面：要重做就从某个阶段重跑，不要就当补充信息 */
export function buildReplanPrompt(c: ReplanCtx): string {
  return [
    `# orc 任务 #${c.task.id} · 你的角色：${c.role.name} · 人在中途插话，先判断影响面`,
    `## 目标\n${c.task.goal}`,
    `## 规格\n${c.task.spec || "（没有单独写规格）"}`,
    `## 阶段\n${c.stages.map((s, k) => `${k + 1}. ${s.name}（${s.id}）${s.id === c.stageId ? " ← 现在停在这里" : ""}`).join("\n")}`,
    `## 人刚说\n${c.text}`,
    [
      `## 你要回答`,
      `如果这句话改了目标 / 验收口径 / 范围，已经做完的部分需要重做：只输出一个标记块`,
      "[[replan]]",
      "reason: 一句为什么",
      "restart_from: <上面某个阶段 id>",
      `如果只是补充信息（不影响已完成的工作）：不要输出任何标记——这句话会照常交给下一步。`,
    ].join("\n"),
  ].join("\n\n");
}
