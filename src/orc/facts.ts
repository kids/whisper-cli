// =============================================================================
// orc — task facts: one collector, two renderings, one detail file
// =============================================================================
// Why this exists: the lead agent runs stateless, read-only and with Bash denied,
// so anything not put in its prompt is invisible to it. The single agent has
// tools, but its cwd is the project repo while the orchestration DB lives
// elsewhere. Both used to get a single `progress` line,
// which made "为什么没过" unanswerable ("我这边看不到评审的具体意见").
//
// So: collect once (taskFacts), then
//   - push a clipped line into the prompt          (renderTaskFacts)
//   - leave the full picture at <workspace>/.whisper/task-<id>.md (writeTaskFacts)
//     Both agents have that path in their cwd, so "不知道就去查" actually works.
//
// Pure data in, pure text out: no DB handles, no IM clients, easy to unit test.
// =============================================================================
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stageName } from "./core";
import type { Attempt, Task, TaskStatus } from "./types";

/** Directory under the chat workspace; git-excluded locally, never committed */
export const FACTS_DIR = ".whisper";

/** Chars per part of a prompt line (title + status + blocker + advice + branch + path) */
const SUMMARY_CHARS = 220;
const ADVICE_CHARS = 320;
const PROGRESS_CHARS = 120;

export const STATUS_WORD: Record<string, string> = {
  queued: "排队", running: "进行中", waiting: "等外部作业", waiting_children: "子任务在跑",
  ready: "已完成", blocked: "等人决定", failed: "失败", dropped: "已终止", done: "已完成",
};

/** The slice of OrcStore this module needs (duck-typed so tests can fake it) */
export interface FactsSource {
  listAttempts(taskId: number): Attempt[];
  getLedger<T = any>(taskId: number): T | undefined;
}

export interface FactsIssue {
  severity: string;
  where: string;
  desc: string;
}

export interface FactsFail {
  stage: string;
  stageLabel: string;
  role: string;
  at: number;
  summary: string;
  notes: string[];
  issues: FactsIssue[];
}

export interface TaskFacts {
  id: number;
  title: string;
  kind: "pipeline" | "loop";
  status: TaskStatus;
  statusWord: string;
  origin: "human" | "agent";
  progress: string;
  updatedAt: number;
  branch: string | null;
  workspace: string | null;
  /** Current pipeline stage (undefined for loop / finished tasks) */
  stage?: { id: string; label: string; role: string; index: number; total: number; acceptable: boolean };
  /** Loop task: the supervisor's open question */
  ask?: string;
  /** Human-readable rework counters, e.g. ["评审退回 2 次"] */
  loops: string[];
  /** Latest failing verdict / test — the "why it did not pass" answer */
  lastFail?: FactsFail;
  /** Latest advisor decision brief (现状 / 卡点 / 选项 / 建议) */
  brief?: { at: number; summary: string; body: string };
  /** Last few runs, oldest first */
  recent: { stage: string; role: string; pass: boolean | null; at: number; summary: string }[];
}

/** Markdown / protocol lines in agent prose read badly inside one prompt line: keep words, drop noise */
const plain = (s: unknown): string => String(s ?? "")
  .replace(/\[\[[^\]]*\]\]/g, "")
  .replace(/[*`]/g, "")
  .replace(/^[ \t]*#{1,6}[ \t]*/gm, "")
  .replace(/^[ \t]*[-*+][ \t]+/gm, "")
  .replace(/\s+/g, " ")
  .trim();

const squash = (s: unknown, n: number): string => {
  const t = plain(s);
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** The lead needs the recommendation and what the human must decide, not the "what we did" list */
function briefDigest(summary: string, body: string): string {
  const section = (re: RegExp, n: number): string => {
    const m = re.exec(body);
    return m ? squash(m[1], n) : "";
  };
  const advice = section(/(?:\n|^)#{1,6}\s*我的建议[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/, 200)
    || section(/(?:\n|^)#{1,6}\s*建议[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/, 200);
  const ask = section(/(?:\n|^)#{1,6}\s*需要你给的?[^\n]*\n([\s\S]*?)(?=\n#{1,6}\s|$)/, 120);
  if (!advice && !ask) return squash(summary, 200);
  return [advice, ask ? `需要你定：${ask}` : ""].filter(Boolean).join("｜");
}

const fmtAt = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export const ago = (ms: number): string => {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`;
};

function issueLine(it: any): FactsIssue {
  const where = [it?.file, it?.line].filter((x) => x != null && x !== "").join(":");
  return { severity: String(it?.severity ?? "issue"), where, desc: squash(it?.desc ?? it?.text ?? "", 240) };
}

function factsFromAttempt(src: FactsSource | undefined, task: Task): TaskFacts {
  const attempts = src ? src.listAttempts(task.id) : [];
  const done = attempts.filter((a) => a.parsed && a.status === "done");
  const desc = [...done].reverse();

  const failAttempt = desc.find((a) => a.parsed?.pass === false && (a.parsed?.kind === "verdict" || a.parsed?.kind === "test"))
    ?? desc.find((a) => a.parsed?.pass === false);
  const briefAttempt = desc.find((a) => a.parsed?.kind === "brief");

  const stages = task.preset?.stages ?? [];
  const stage = task.kind === "pipeline" && stages.length
    ? stages[Math.min(task.stageIdx, stages.length - 1)]
    : undefined;
  const roleDef = stage ? task.preset.roles[stage.role] : undefined;
  const ledger = task.kind === "loop" && src ? src.getLedger<any>(task.id) : undefined;
  const ask = typeof ledger?.pendingAsk?.question === "string" ? ledger.pendingAsk.question : undefined;

  const lastFail: FactsFail | undefined = failAttempt ? {
    stage: failAttempt.stageId,
    stageLabel: stageName(failAttempt.stageId),
    role: failAttempt.role,
    at: failAttempt.endedAt ?? failAttempt.startedAt,
    summary: squash(failAttempt.parsed?.summary, 600),
    notes: (failAttempt.parsed?.notes ?? []).map((n: unknown) => squash(n, 240)).filter(Boolean).slice(0, 6),
    issues: (failAttempt.parsed?.issues ?? []).map(issueLine).slice(0, 12),
  } : undefined;

  const briefBody = String(briefAttempt?.parsed?.body ?? "").trim();
  const brief = briefAttempt ? {
    at: briefAttempt.endedAt ?? briefAttempt.startedAt,
    summary: briefDigest(briefAttempt.parsed?.summary ?? "", briefBody),
    body: briefBody,
  } : undefined;

  return {
    id: task.id,
    title: squash(task.title, 40),
    kind: task.kind,
    status: task.status,
    statusWord: STATUS_WORD[task.status] ?? task.status,
    origin: task.origin === "agent" ? "agent" : "human",
    progress: squash(task.status === "ready" ? task.progress.replace(/[，,]\s*等待验收$/, "") : task.progress, 400),
    updatedAt: task.updatedAt,
    branch: task.branch,
    workspace: task.workspace,
    stage: stage ? {
      id: stage.id,
      label: stageName(stage.id),
      role: stage.role,
      index: Math.min(task.stageIdx, stages.length - 1),
      total: stages.length,
      acceptable: roleDef?.output === "verdict" || roleDef?.output === "test",
    } : undefined,
    ask: ask ? squash(ask, 400) : undefined,
    loops: Object.entries(task.loops ?? {})
      .filter(([k]) => !k.includes(":"))
      .map(([k, v]) => `${stageName(k)}退回 ${v} 次`),
    lastFail,
    brief,
    recent: done.slice(-5).map((a) => ({
      stage: a.stageId,
      role: a.role,
      pass: typeof a.parsed?.pass === "boolean" ? a.parsed.pass : null,
      at: a.endedAt ?? a.startedAt,
      summary: squash(a.parsed?.summary ?? a.progress ?? "", 160),
    })),
  };
}

export function taskFacts(src: FactsSource | undefined, task: Task): TaskFacts {
  return factsFromAttempt(src, task);
}

/**
 * One prompt line: identity + blocker + advice + branch + detail path.
 * `detailPath` is relative to the agent's cwd (the chat workspace).
 */
export function renderTaskFacts(f: TaskFacts, audience: "lead" | "single", detailPath?: string): string {
  const head = `- #${f.id} ${f.title}｜${f.statusWord}${f.kind === "loop" ? " · 监督循环" : f.stage ? ` · ${f.stage.label}` : ""}`;
  // A passed task keeps its history in the detail file, but its old failures must
  // not read like a live blocker in the prompt.
  const live = f.status !== "ready" && f.status !== "dropped";
  const fail = live ? f.lastFail : undefined;
  const parts: string[] = [];
  if (detailPath) parts.push(`明细 ${detailPath}`);
  if (f.ask) parts.push(`在等你回答：${squash(f.ask, 120)}`);
  if (fail) parts.push(`卡点：${squash(fail.summary, SUMMARY_CHARS)}`);
  if (f.brief) parts.push(`决策说明：${squash(f.brief.summary, ADVICE_CHARS)}`);
  if (!fail && !f.brief && f.progress) parts.push(squash(f.progress, PROGRESS_CHARS));
  if (f.branch) parts.push(`分支 ${f.branch}`);
  parts.push(`${ago(Date.now() - f.updatedAt)}更新`);

  const line = [head, ...parts].join("｜");
  if (audience !== "lead") return line;

  const detail = detailPath ? `；需要全文读 ${detailPath}` : "";
  // Loop ask sets status=blocked too — ask must win, or lead sees pipeline
  // retry/stop and may terminate on "继续…" (rl-close incident).
  if (f.ask) {
    return `${line}\n  ⚠️ 正在等人回答：人随口说一句 / 继续 / 纠偏 / 扩目标 →[[answer]]（把原话带上）；`
      + `只有明确说放弃、停掉、终止、算了才 →[[stop]]；问到细节照上面答${detail}`;
  }
  if (f.status === "blocked") {
    const acts = f.stage?.acceptable
      ? "「再试一次」→[[retry]]、「接受这版」→[[accept]]、「放弃」→[[stop]]"
      : "「再试一次」→[[retry]]、「放弃」→[[stop]]";
    return `${line}\n  ⚠️ 卡在${f.stage?.label ?? "这一步"}上等人决定：${acts}；`
      + `问到细节（为什么没过、做到哪）就照上面答，别答“看不到”${detail}`;
  }
  if (f.status === "ready") return `${line}\n  已收工：不占资源，也不需要人验收或停掉；接着改就 submit 新任务${detail}`;
  return line;
}

/** Full markdown for <workspace>/.whisper/task-<id>.md */
export function renderFactsMarkdown(f: TaskFacts, commits: string[] = []): string {
  const L: string[] = [`# #${f.id} ${f.title}`, ""];
  L.push(`- 状态：${f.statusWord}（${f.status}）${f.origin === "agent" ? " · agent 自己起的" : ""}`);
  if (f.stage) L.push(`- 阶段：${f.stage.label}（${f.stage.index + 1}/${f.stage.total}）${f.stage.role ? ` · 角色 ${f.stage.role}` : ""}`);
  if (f.loops.length) L.push(`- 退回：${f.loops.join("，")}`);
  if (f.branch) L.push(`- 分支：\`${f.branch}\``);
  if (f.workspace) L.push(`- 工作区：\`${f.workspace}\``);
  L.push(`- 更新：${fmtAt(f.updatedAt)}`);
  if (f.progress) L.push(`- 进展：${f.progress}`);
  L.push("", "> 本文件由 whisper-cli 自动生成，只读；要推进任务请在群里说话。", "");

  if (f.ask) L.push("## 在等你回答", "", f.ask, "");
  if (f.lastFail) {
    L.push(`## 卡在哪：最近一次未通过（${f.lastFail.stageLabel} · ${f.lastFail.role} · ${fmtAt(f.lastFail.at)}）`, "", f.lastFail.summary, "");
    if (f.lastFail.issues.length) {
      L.push("### 问题清单", "");
      for (const it of f.lastFail.issues) L.push(`- [${it.severity}] ${it.where ? `\`${it.where}\` ` : ""}${it.desc}`);
      L.push("");
    }
    if (f.lastFail.notes.length) L.push("### 评审备注", "", ...f.lastFail.notes.map((n) => `- ${n}`), "");
  }
  if (f.brief) {
    L.push("## 决策说明（advisor）", "", f.brief.summary, "");
    if (f.brief.body) L.push(f.brief.body.slice(0, 2000), "");
  }
  if (f.recent.length) {
    L.push("## 最近运行", "");
    for (const r of f.recent) {
      const mark = r.pass === true ? "✓" : r.pass === false ? "✗" : "·";
      L.push(`${mark} ${fmtAt(r.at)} ${r.stage}/${r.role} — ${r.summary || "-"}`);
    }
    L.push("");
  }
  if (commits.length) L.push("## 工作树最近提交", "", ...commits.map((c) => `- ${c}`), "");
  return L.join("\n");
}

/** Relative path as the agent sees it from the chat workspace */
export const factsRelPath = (id: number): string => `${FACTS_DIR}/task-${id}.md`;

// `git info/exclude` is local-only: no repo file changes, no dirty status.
// `.gitignore` would be a business-repo edit.
const excluded = new Set<string>();
function ensureExcluded(workspace: string): void {
  if (excluded.has(workspace)) return;
  excluded.add(workspace);
  try {
    const common = execFileSync("git", ["-C", workspace, "rev-parse", "--git-common-dir"], { timeout: 2000, encoding: "utf8" }).trim();
    if (!common) return;
    const dir = resolve(workspace, common, "info");
    const file = resolve(dir, "exclude");
    const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (cur.split(/\r?\n/).some((l) => l.trim() === `${FACTS_DIR}/`)) return;
    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${cur && !cur.endsWith("\n") ? "\n" : ""}${FACTS_DIR}/\n`);
  } catch { /* not a git repo → nothing to exclude */ }
}

function recentCommits(cwd: string): string[] {
  try {
    return execFileSync("git", ["-C", cwd, "log", "--oneline", "-5"], { timeout: 2000, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

const wrote = new Map<string, number>();

/**
 * Write the detail file unless this task's facts are unchanged since last time.
 * Returns the relative path for the prompt; undefined when the workspace is unusable.
 */
export function writeTaskFacts(f: TaskFacts, workspace: string | undefined): string | undefined {
  if (!workspace) return undefined;
  const key = `${workspace}:${f.id}`;
  if (wrote.get(key) === f.updatedAt) return factsRelPath(f.id);
  try {
    const dir = resolve(workspace, FACTS_DIR);
    mkdirSync(dir, { recursive: true });
    ensureExcluded(workspace);
    const commits = f.workspace ? recentCommits(f.workspace) : [];
    writeFileSync(resolve(dir, `task-${f.id}.md`), renderFactsMarkdown(f, commits), "utf8");
    wrote.set(key, f.updatedAt);
    return factsRelPath(f.id);
  } catch { return undefined; }
}
