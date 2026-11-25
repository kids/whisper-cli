// =============================================================================
// orc — git worktree isolation (one worktree + branch per task)
// =============================================================================
// Writers' changes are committed after every attempt, so read-only roles always
// see a clean tree; any change a read-only role leaves behind is reset and
// reported as a violation (tool-level denial is best-effort across CLIs).
//
// Critical: never resetHard over pre-existing WIP. Background jobs (training)
// also mutate tracked artifacts under out/ — those must not count as violations,
// or a readonly check will wipe worker edits mid-flight (task #2 abort).
// =============================================================================
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHash } from "node:crypto";

function git(cwd: string, args: string[], opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (e: any) {
    if (opts.allowFail) return "";
    const msg = (e.stderr?.toString() || e.message || "").trim();
    throw new Error(`git ${args.join(" ")} failed: ${msg.slice(0, 500)}`);
  }
}

const IDENT = ["-c", "user.name=orc", "-c", "user.email=orc@localhost", "-c", "commit.gpgsign=false"];

export function repoRoot(path: string): string | undefined {
  return git(path, ["rev-parse", "--show-toplevel"], { allowFail: true }) || undefined;
}

export function headSha(cwd: string, ref = "HEAD"): string {
  return git(cwd, ["rev-parse", ref]);
}

/**
 * Pipeline tasks run in the repo itself by default (`ORC_ISOLATION=workspace`):
 * no branch, no merge. Set `ORC_ISOLATION=worktree` to get the old one-worktree-per-task.
 * Loop tasks always keep a worktree — a round can run for hours with background jobs,
 * and sharing the tree with the human's edits would corrupt both.
 */
export function workspaceMode(): boolean {
  return !/^(worktree|branch)$/i.test(process.env.ORC_ISOLATION || "");
}

/** Current branch short name ("" when detached — callers must refuse to run then) */
export function currentBranch(cwd: string): string {
  return git(cwd, ["symbolic-ref", "--short", "HEAD"], { allowFail: true });
}

/** Dirty paths as `git status --porcelain` reports them (generated artifacts excluded) */
export function dirtyPaths(cwd: string): Set<string> {
  const out = statusPorcelain(cwd);
  const set = new Set<string>();
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    for (const part of line.slice(3).split(" -> ")) {
      const p = part.trim().replace(/^"|"$/g, "");
      if (p) set.add(p);
    }
  }
  return set;
}

/**
 * Commit only what is *not* in `exclude` (the paths already dirty when the attempt started).
 * In workspace mode the human may be editing the same repo; their WIP must never be swept
 * into a task commit, and vice versa.
 */
export function commitAllExcept(cwd: string, exclude: Set<string>, message: string): string | undefined {
  git(cwd, ["add", "-A", "--", ".", ...ARTIFACT_EXCLUDES]);
  if (exclude.size) {
    const list = [...exclude].map((p) => `:(literal)${p}`);
    for (let i = 0; i < list.length; i += 100) {
      git(cwd, ["reset", "-q", "--", ...list.slice(i, i + 100)], { allowFail: true });
    }
  }
  if (!git(cwd, ["diff", "--cached", "--name-only"])) return undefined;
  execFileSync("git", [...IDENT, "commit", "-q", "--no-verify", "-m", message], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return headSha(cwd);
}

/**
 * A task's handle is its title, not a number: branch and directory are derived from it
 * (`orc/分位数可行性-3f9a`). The 4-char tail is a hash of the internal id, so two tasks that
 * happen to share a title still get separate branches. Numbers only exist inside a task
 * (第 2 次评审、第 3 轮) and in the database.
 */
export function taskSlug(title: string, id: number): string {
  const clean = (title || "task")
    .replace(/\s+/g, "-")
    .replace(/[\\:*?"<>|\u0000-\u001f]/g, "")
    .replace(/^[-.]+|[-.]+$/g, "")
    .replace(/-+/g, "-")
    .slice(0, 24)
    .replace(/[-.]+$/g, "");
  return `${clean || "task"}-${createHash("sha1").update(String(id)).digest("hex").slice(0, 4)}`;
}

export function worktreePath(orcHome: string, repo: string, title: string, id: number): string {
  const key = `${basename(repo)}-${createHash("sha1").update(resolve(repo)).digest("hex").slice(0, 8)}`;
  return resolve(orcHome, "worktrees", key, taskSlug(title, id));
}

export function branchName(title: string, id: number): string {
  return `orc/${taskSlug(title, id)}`;
}

function isIgnored(cwd: string, rel: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 任务产物不应留在会被清理的 worktree 里：
 * 若仓库把 `tmp/` 忽略，就把 worktree 的 `tmp` 软链到主仓库 `tmp/orc/<slug>/`，
 * 这样相对路径 `tmp/...` 直接落在主仓库，worktree 删除也不丢数据。
 */
export function ensureArtifactLink(repo: string, path: string): void {
  if (!isIgnored(repo, "tmp")) return;
  const wtTmp = resolve(path, "tmp");
  try {
    if (lstatSync(wtTmp)) return;   // 已存在（真实目录或软链）就不动
  } catch {
    // 不存在，继续
  }
  const shared = resolve(repo, "tmp", "orc", basename(path));
  mkdirSync(shared, { recursive: true });
  try {
    symlinkSync(shared, wtTmp, "dir");
  } catch {
    // 并发/权限问题不影响主流程
  }
}

/** Create (or reuse) the task worktree on its own branch starting at `base` */
export function ensureWorktree(repo: string, path: string, branch: string, base: string): void {
  if (existsSync(resolve(path, ".git"))) {
    ensureArtifactLink(repo, path);
    return;
  }
  mkdirSync(resolve(path, ".."), { recursive: true });
  const exists = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
  if (exists) git(repo, ["worktree", "add", path, branch]);
  else git(repo, ["worktree", "add", "-b", branch, path, base]);
  ensureArtifactLink(repo, path);
}

export interface MergeConflict {
  branch: string;
  /** files git left with conflict markers (empty when the failure was not a content conflict) */
  files: string[];
  /** git's own output, both streams, so the card is never空 again */
  detail: string;
}

/** A dependency merge that cannot be resolved automatically. Deterministic: retrying is pointless. */
export class MergeConflictError extends Error {
  constructor(readonly conflict: MergeConflict) {
    super(`合并依赖分支 ${conflict.branch} 冲突${conflict.files.length ? `（${conflict.files.join("、")}）` : ""}`);
    this.name = "MergeConflictError";
  }
}

function isAncestor(cwd: string, ref: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ref, "HEAD"], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge dependency branches into the worktree. Already-merged branches are skipped (idempotent:
 * a retry after a human resolved the conflict must not fail on the same tree again).
 * Returns the conflict, or undefined when every branch is in.
 */
export function mergeBranches(wt: string, branches: string[]): MergeConflict | undefined {
  for (const b of branches) {
    if (isAncestor(wt, b)) continue;
    try {
      execFileSync("git", [...IDENT, "merge", "--no-edit", "-q", b], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      // git writes CONFLICT lines to stdout; stderr is usually empty. Read both.
      const out = (e.stdout?.toString() || "").trim();
      const err = (e.stderr?.toString() || "").trim();
      const detail = [out, err].filter(Boolean).join("\n").slice(0, 1000);
      const files = git(wt, ["diff", "--name-only", "--diff-filter=U"], { allowFail: true })
        .split("\n").map((s) => s.trim()).filter(Boolean);
      git(wt, ["merge", "--abort"], { allowFail: true });
      return { branch: b, files, detail };
    }
  }
  return undefined;
}

/** Generated artifacts never committed / never treated as readonly violations */
export const ARTIFACT_EXCLUDES = [
  "__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".DS_Store", "*.egg-info",
  // live training / eval mutates these; wiping them (or blaming the supervisor) breaks long jobs
  "out", "*.log", "*.ckpt", "*.pt", "*.pth", "*.onnx", "wandb", ".cache", "mlruns",
].flatMap((p) => [`:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`]);

/** Porcelain status, ignoring generated artifacts */
export function statusPorcelain(wt: string): string {
  return git(wt, ["status", "--porcelain", "--", ".", ...ARTIFACT_EXCLUDES]);
}

/** Uncommitted changes, ignoring generated artifacts (pytest/node caches are not violations) */
export function isDirty(wt: string): boolean {
  return statusPorcelain(wt).length > 0;
}

/** Commit everything in the worktree; returns the new sha or undefined if nothing changed */
export function commitAll(wt: string, message: string): string | undefined {
  git(wt, ["add", "-A", "--", ".", ...ARTIFACT_EXCLUDES]);
  if (!git(wt, ["diff", "--cached", "--name-only"])) return undefined;
  execFileSync("git", [...IDENT, "commit", "-q", "--no-verify", "-m", message], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
  return headSha(wt);
}

/** Throw away uncommitted changes (read-only role violation) — only when the tree started clean */
export function resetHard(wt: string): string {
  const files = statusPorcelain(wt);
  git(wt, ["reset", "--hard", "-q"]);
  git(wt, ["clean", "-fdq", "-e", "tmp"]);   // 保留 tmp 软链（产物在主仓库）
  return files;
}

/**
 * After a readonly role/command.
 *
 * Never resetHard here. A prior bug wiped worker WIP (and live training outputs)
 * whenever the tree looked dirty after the supervisor — including when dirt came
 * from a concurrent writer or from leftover uncommitted worker edits. Tool denial
 * (Write/Edit/Bash) is the real readonly fence; if anything still lands, commit it
 * onto the task branch so it is recoverable, and report a soft violation.
 *
 * `beforePorcelain` is kept for call-site clarity / future delta logic.
 * Returns a human-readable note, or "" if nothing changed.
 */
export function enforceReadonly(wt: string, _beforePorcelain: string, commitMsg: string): { note: string; preserved: boolean; wiped: boolean; sha?: string } {
  const after = statusPorcelain(wt);
  if (!after) return { note: "", preserved: false, wiped: false };
  const sha = commitAll(wt, commitMsg);
  return {
    note: `只读角色/命令期间工作区有未提交改动，已提交保留（不回滚）：\n${after}`,
    preserved: true,
    wiped: false,
    sha,
  };
}

/**
 * `git diff --stat` has one line per file: a task that commits a data snapshot (1300 files)
 * produced a 100 KB list. Past `maxLines`, keep the biggest files and fold the rest per directory.
 */
export function compactStat(stat: string, maxLines = 60): string {
  const lines = (stat || "").split("\n").filter((l) => l.trim());
  if (lines.length <= maxLines + 1) return stat;
  const summary = /files? changed/.test(lines[lines.length - 1]) ? lines.pop()! : "";
  const rows = lines.map((l) => {
    const [path, rest = ""] = l.split("|");
    const n = Number(/(\d+)/.exec(rest)?.[1] ?? 0);
    return { l, path: path.trim(), n };
  });
  const keep = [...rows].sort((a, b) => b.n - a.n).slice(0, Math.floor(maxLines / 2));
  const kept = new Set(keep);
  const byDir = new Map<string, { files: number; n: number }>();
  for (const r of rows) {
    if (kept.has(r)) continue;
    const dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : ".";
    const d = byDir.get(dir) ?? { files: 0, n: 0 };
    d.files++; d.n += r.n;
    byDir.set(dir, d);
  }
  const dirs = [...byDir.entries()].sort((a, b) => b[1].files - a[1].files);
  const shown = dirs.slice(0, Math.ceil(maxLines / 2));
  return [
    ...rows.filter((r) => kept.has(r)).map((r) => r.l),
    `（另有 ${rows.length - keep.length} 个文件，按目录汇总；看全部用 git diff --stat）`,
    ...shown.map(([d, v]) => ` ${d}/  ${v.files} 个文件，${v.n} 行改动`),
    dirs.length > shown.length ? ` …其余 ${dirs.length - shown.length} 个目录` : "",
    summary,
  ].filter(Boolean).join("\n");
}

export function diffSince(wt: string, base: string, maxChars = 30_000): { stat: string; diff: string; truncated: boolean } {
  const stat = compactStat(git(wt, ["diff", "--stat=200", `${base}..HEAD`], { allowFail: true }));
  const full = git(wt, ["diff", `${base}..HEAD`], { allowFail: true });
  const truncated = full.length > maxChars;
  return { stat, diff: truncated ? full.slice(0, maxChars) + "\n… (diff 已截断，用 git diff 查看全文)" : full, truncated };
}

export function logSince(wt: string, base: string): string {
  return git(wt, ["log", "--oneline", `${base}..HEAD`], { allowFail: true });
}
