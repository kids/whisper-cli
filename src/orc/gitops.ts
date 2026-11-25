// =============================================================================
// orc — git helpers
//
// 所有任务都在主工作区原地跑：不建独立工作树，不建任务分支，不做合并。
// 写入角色的改动在每轮结束后提交到当前分支；只读角色越权写入会被提交保留并报告。
// =============================================================================
import { execFileSync } from "node:child_process";

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
 * 人工可能在同一工作区编辑：双方的 WIP 都不能被扫进对方的提交。
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

/** Generated artifacts never committed / never treated as readonly violations */
export const ARTIFACT_EXCLUDES = [
  "__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".DS_Store", "*.egg-info",
  // live training / eval mutates these; wiping them (or blaming the supervisor) breaks long jobs
  "out", "*.log", "*.ckpt", "*.pt", "*.pth", "*.onnx", "wandb", ".cache", "mlruns",
].flatMap((p) => [`:(exclude,glob)**/${p}`, `:(exclude,glob)**/${p}/**`]);

/** Porcelain status, ignoring generated artifacts */
export function statusPorcelain(cwd: string): string {
  return git(cwd, ["status", "--porcelain", "--", ".", ...ARTIFACT_EXCLUDES]);
}

/** Uncommitted changes, ignoring generated artifacts (pytest/node caches are not violations) */
export function isDirty(cwd: string): boolean {
  return statusPorcelain(cwd).length > 0;
}

/** Commit everything in the working tree; returns the new sha or undefined if nothing changed */
export function commitAll(cwd: string, message: string): string | undefined {
  git(cwd, ["add", "-A", "--", ".", ...ARTIFACT_EXCLUDES]);
  if (!git(cwd, ["diff", "--cached", "--name-only"])) return undefined;
  execFileSync("git", [...IDENT, "commit", "-q", "--no-verify", "-m", message], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  return headSha(cwd);
}

/** Throw away uncommitted changes (read-only role violation) — only when the tree started clean */
export function resetHard(cwd: string): string {
  const files = statusPorcelain(cwd);
  git(cwd, ["reset", "--hard", "-q"]);
  git(cwd, ["clean", "-fdq", "-e", "tmp"]);
  return files;
}

/**
 * After a readonly role/command.
 *
 * Never resetHard here. A prior bug wiped worker WIP (and live training outputs)
 * whenever the tree looked dirty after the supervisor — including when dirt came
 * from a concurrent writer or from leftover uncommitted worker edits. Tool denial
 * (Write/Edit/Bash) is the real readonly fence; if anything still lands, commit it
 * onto the current branch so it is recoverable, and report a soft violation.
 *
 * `beforePorcelain` is kept for call-site clarity / future delta logic.
 * Returns a human-readable note, or "" if nothing changed.
 */
export function enforceReadonly(cwd: string, _beforePorcelain: string, commitMsg: string): { note: string; preserved: boolean; wiped: boolean; sha?: string } {
  const after = statusPorcelain(cwd);
  if (!after) return { note: "", preserved: false, wiped: false };
  const sha = commitAll(cwd, commitMsg);
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

export function diffSince(cwd: string, base: string, maxChars = 30_000): { stat: string; diff: string; truncated: boolean } {
  const stat = compactStat(git(cwd, ["diff", "--stat=200", `${base}..HEAD`], { allowFail: true }));
  const full = git(cwd, ["diff", `${base}..HEAD`], { allowFail: true });
  const truncated = full.length > maxChars;
  return { stat, diff: truncated ? full.slice(0, maxChars) + "\n… (diff 已截断，用 git diff 查看全文)" : full, truncated };
}

export function logSince(cwd: string, base: string): string {
  return git(cwd, ["log", "--oneline", `${base}..HEAD`], { allowFail: true });
}
