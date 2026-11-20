// =============================================================================
// orc — end a finished task's leftover background jobs (processes only, no files)
// =============================================================================
// Workers detach long jobs (`setsid nohup …`) so they survive the agent turn. When the
// task ends nobody owns them any more: an EF eval loop ran 3 days after its task was done.
// On ready / failed / dropped we stop whatever still runs *from that task's worktree*:
// cwd inside it, or the worktree path in the command line — plus their descendants.
// Never touched: this process and its ancestors, anything with a terminal (a human's shell),
// files of any kind, jobs started elsewhere (remote hosts, other directories).
// =============================================================================
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";

export interface Stray { pid: number; cmd: string }

interface Proc { pid: number; ppid: number; tty: number; cwd: string; cmd: string }

function readProc(pid: number): Proc | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // fields after the ")" of comm: state ppid pgrp session tty_nr …
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    let cwd = "";
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { /* other user / gone */ }
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+/g, " ").trim();
    return { pid, ppid: Number(f[1]), tty: Number(f[4]), cwd, cmd };
  } catch { return undefined; }
}

/** Processes started from `worktree` (and their children); see the header for what is excluded */
export function findStrays(worktree: string): Stray[] {
  if (!worktree || !worktree.startsWith("/") || worktree.split("/").filter(Boolean).length < 3) return [];
  if (!existsSync("/proc")) return [];
  const wt = worktree.replace(/\/+$/, "");
  const procs = new Map<number, Proc>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const p = readProc(Number(name));
    if (p) procs.set(p.pid, p);
  }
  const protect = new Set<number>();
  for (let pid = process.pid; pid > 1 && !protect.has(pid); pid = procs.get(pid)?.ppid ?? 0) protect.add(pid);

  // path boundary: …/foo-ab12 must not match …/foo-ab12x
  const inside = (p: Proc) => p.cwd === wt || p.cwd.startsWith(wt + "/")
    || p.cmd.includes(wt + "/") || p.cmd.includes(wt + " ") || p.cmd.endsWith(wt);
  const hit = new Set<number>();
  for (const p of procs.values()) if (inside(p)) hit.add(p.pid);
  // descendants (a `sleep` inside the loop, a python child that chdir'ed elsewhere)
  for (let grew = true; grew;) {
    grew = false;
    for (const p of procs.values()) if (!hit.has(p.pid) && hit.has(p.ppid)) { hit.add(p.pid); grew = true; }
  }
  return [...hit]
    .map((pid) => procs.get(pid)!)
    .filter((p) => !protect.has(p.pid) && p.tty === 0)
    .map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 160) }));
}

/** SIGTERM now, SIGKILL whatever is still alive a few seconds later */
export function reapStrays(worktree: string, graceMs = 5000): Stray[] {
  const strays = findStrays(worktree);
  for (const s of strays) { try { process.kill(s.pid, "SIGTERM"); } catch { /* already gone */ } }
  if (strays.length) {
    const t = setTimeout(() => { for (const s of strays) { try { process.kill(s.pid, "SIGKILL"); } catch { /* gone */ } } }, graceMs);
    t.unref?.();
  }
  return strays;
}
