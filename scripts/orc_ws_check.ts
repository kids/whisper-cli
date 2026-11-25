// 离线检查：workspace（无 worktree）模式的关键行为
//   npx tsx scripts/orc_ws_check.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPresets, loadRoles, resolvePreset } from "../src/orc/config";
import { Orchestrator } from "../src/orc/scheduler";
import { OrcStore } from "../src/orc/store";
import type { Executor, RunRequest, RunResult } from "../src/orc/runner";
import type { NotifyPayload } from "../src/orc/types";

const presets = loadPresets();
const roles = loadRoles();
const devPreset = resolvePreset(presets.get("dev")!, roles);
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Fake implements Executor {
  calls: { role: string; taskId: number; cwd: string }[] = [];
  active = 0; maxActive = 0;
  available() { return ["codebuddy", "codex", "claude"] as any; }
  stop() { return true; }
  async run(req: RunRequest): Promise<RunResult> {
    const role = /你的角色：(\S+)/.exec(req.prompt)![1];
    const taskId = Number(/orc 任务 #(\d+)/.exec(req.prompt)![1]);
    this.calls.push({ role, taskId, cwd: req.cwd });
    this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (role === "planner") return ok('{"spec":"add feature","subtasks":[],"summary":"ok"}');
      if (role === "implementer") { await sleep(60); writeFileSync(join(req.cwd, `f-${taskId}.txt`), "x\n"); return ok("[[done]] wrote"); }
      if (role === "critic") return ok("[[approve]] lgtm");
      if (role === "tester") { writeFileSync(join(req.cwd, `t-${taskId}.txt`), "case"); return ok("[[pass]] ok"); }
      return ok('{"summary":"report"}');
    } finally { this.active--; }
  }
}
const ok = (text: string): RunResult => ({ text, sessionId: `s-${Math.random()}`, tokens: 5, timedOut: false, cancelled: false });

function setup(dirty = false) {
  const dir = mkdtempSync(join(tmpdir(), "ws-check-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A"); git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  if (dirty) writeFileSync(join(repo, "wip.txt"), "my work\n");
  const store = new OrcStore(join(dir, "orc.db"));
  const exec = new Fake();
  const notes: NotifyPayload[] = [];
  const orc = new Orchestrator(store, exec, {
    orcHome: join(dir, "home"), notify: async (_t, n) => { notes.push(n); }, progressThrottleMs: 0,
  } as any);
  return { dir, repo, store, exec, notes, orc };
}

let failed = 0;
const check = (name: string, good: boolean, detail?: unknown) => { if (!good) { failed++; console.log("FAIL", name, detail ?? ""); } else console.log("ok  ", name); };

{
  const { dir, repo, store, exec, orc } = setup();
  const t = orc.submit({ goal: "add feature", repo, preset: devPreset });
  await orc.runUntilIdle(10);
  const done = store.getTask(t.id)!;
  check("ready", done.status === "ready", done.status);
  check("bound to repo", done.workspace === repo, done.workspace);
  check("branch = current", done.branch === "main", done.branch);
  check("commits on main", /orc\(#/.test(git(repo, "log", "--oneline")), git(repo, "log", "--oneline"));
  check("no orc branch", !git(repo, "branch", "--list", "orc/*"), git(repo, "branch", "--list", "orc/*"));
  check("never creates a worktree dir", !existsSync(join(dir, "home", "worktrees")));
  check("exec ran in repo", exec.calls.every((c) => c.cwd === repo), exec.calls.map((c) => c.cwd));
  store.close(); rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, repo, store, exec, notes, orc } = setup(true);
  const t = orc.submit({ goal: "add feature", repo, preset: devPreset });
  await orc.runUntilIdle(10);
  const st = store.getTask(t.id)!;
  check("dirty -> blocked", st.status === "blocked", st.status);
  check("dirty -> no agent", exec.calls.length === 0, exec.calls.length);
  check("dirty -> explained", notes.some((n) => /未提交改动/.test(n.text)), notes.map((n) => n.text));
  store.close(); rmSync(dir, { recursive: true, force: true });
}

{
  const { dir, repo, store, exec, orc } = setup();
  orc.submit({ goal: "a", repo, preset: devPreset });
  orc.submit({ goal: "b", repo, preset: devPreset });
  await orc.runUntilIdle(15);
  check("serial per repo", exec.maxActive === 1, exec.maxActive);
  store.close(); rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `FAILED ${failed}` : "ALL OK");
process.exit(failed ? 1 : 0);
