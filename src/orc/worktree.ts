// =============================================================================
// orc — git worktree isolation (one worktree + branch per task)
// =============================================================================
// Writers' changes are committed after every attempt, so read-only roles always
// see a clean tree; any change a read-only role leaves behind is reset and
// reported as a violation (tool-level denial is best-effort across CLIs).
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

export function worktreePath(orcHome: string, repo: string, taskId: number): string {
  const key = `${basename(repo)}-${createHash("sha1").update(resolve(repo)).digest("hex").slice(0, 8)}`;
  return resolve(orcHome, "worktrees", key, `task-${taskId}`);
}

export function branchName(taskId: number): string {
  return `orc/task-${taskId}`;
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

/** Uncommitted changes, ignoring generated artifacts (pytest/node caches are not violations) */
export function isDirty(wt: string): boolean {
  return git(wt, ["status", "--porcelain", "--", ".", ...ARTIFACT_EXCLUDES]).length > 0;
}

/** Generated artifacts never committed even if the repo forgot to .gitignore them */
export const ARTIFACT_EXCLUDES = [
  "__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".DS_Store", "*.egg-info",
].flatMap((p) => [`:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`]);

/** Commit everything in the worktree; returns the new sha or undefined if nothing changed */
export function commitAll(wt: string, message: string): string | undefined {
  git(wt, ["add", "-A", "--", ".", ...ARTIFACT_EXCLUDES]);
  if (!git(wt, ["diff", "--cached", "--name-only"])) return undefined;
  execFileSync("git", [...IDENT, "commit", "-q", "--no-verify", "-m", message], { cwd: wt, stdio: ["ignore", "pipe", "pipe"] });
  return headSha(wt);
}

/** Throw away uncommitted changes (read-only role violation) */
export function resetHard(wt: string): string {
  const files = git(wt, ["status", "--porcelain", "--", ".", ...ARTIFACT_EXCLUDES]);
  git(wt, ["reset", "--hard", "-q"]);
  git(wt, ["clean", "-fdq"]);
  return files;
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
