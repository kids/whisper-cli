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
import { existsSync, mkdirSync } from "node:fs";
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

/** Create (or reuse) the task worktree on its own branch starting at `base` */
export function ensureWorktree(repo: string, path: string, branch: string, base: string): void {
  if (existsSync(resolve(path, ".git"))) return;
  mkdirSync(resolve(path, ".."), { recursive: true });
  const exists = git(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFail: true });
  if (exists) git(repo, ["worktree", "add", path, branch]);
  else git(repo, ["worktree", "add", "-b", branch, path, base]);
}

/** Merge extra dependency branches into the worktree; returns conflict message or undefined */
export function mergeBranches(wt: string, branches: string[]): string | undefined {
  for (const b of branches) {
    try {
      execFileSync("git", [...IDENT, "merge", "--no-edit", "-q", b], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e: any) {
      git(wt, ["merge", "--abort"], { allowFail: true });
      return `合并依赖分支 ${b} 冲突：${(e.stderr?.toString() || "").slice(0, 300)}`;
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
  git(wt, ["clean", "-fdq"]);
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

export function diffSince(wt: string, base: string, maxChars = 30_000): { stat: string; diff: string; truncated: boolean } {
  const stat = git(wt, ["diff", "--stat", `${base}..HEAD`], { allowFail: true });
  const full = git(wt, ["diff", `${base}..HEAD`], { allowFail: true });
  const truncated = full.length > maxChars;
  return { stat, diff: truncated ? full.slice(0, maxChars) + "\n… (diff 已截断，用 git diff 查看全文)" : full, truncated };
}

export function logSince(wt: string, base: string): string {
  return git(wt, ["log", "--oneline", `${base}..HEAD`], { allowFail: true });
}
