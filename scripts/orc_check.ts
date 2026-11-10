// Offline checks for src/orc (no LLM calls): parser, config/patch validation,
// core state machine, and scheduler end-to-end with a fake executor on a temp
// git repo (worktrees, commits, resume, slots, read-only enforcement, split,
// recovery).   npx tsx scripts/orc_check.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, loadPresets, loadRoles, resolvePreset } from "../src/orc/config";
import { decideAfterAttempt, decideParent } from "../src/orc/core";
import { findJsonObjects, parseRoleOutput } from "../src/orc/output";
import type { Executor, RunRequest, RunResult } from "../src/orc/runner";
import { classifyResult, eventToProgress } from "../src/orc/runner";
import { Orchestrator } from "../src/orc/scheduler";
import { OrcStore } from "../src/orc/store";
import type { NotifyPayload, Task } from "../src/orc/types";
import { parseLeadAction, renderCard, resolveChatPreset } from "../src/orc/chat";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}`, detail ?? ""); }
}
function throws(fn: () => unknown, re: RegExp): boolean {
  try { fn(); return false; } catch (e) { return re.test((e as Error).message); }
}

// ---- output parser ----------------------------------------------------------
{
  const t = 'blah {"x":1} more\n```json\n{"verdict":"revise","issues":[{"severity":"major","desc":"a}b"}],"summary":"s"}\n```\ntrailing';
  check("findJsonObjects string-aware", findJsonObjects(t).length === 2);
  const p: any = parseRoleOutput("verdict", t);
  check("verdict parse", p.pass === false && p.value.issues[0].desc === "a}b", p);
  check("verdict last wins", (parseRoleOutput("verdict", '{"verdict":"revise"} {"verdict":"approve"}') as any).pass === true);
  check("missing key", "error" in parseRoleOutput("test", '{"summary":"x"}'));
  check("bad enum", "error" in parseRoleOutput("verdict", '{"verdict":"lgtm"}'));
  check("test bool", (parseRoleOutput("test", '{"pass":false,"cases":[]}') as any).pass === false);
  check("test non-bool", "error" in parseRoleOutput("test", '{"pass":"yes"}'));
  const plan: any = parseRoleOutput("plan", '{"spec":"S","subtasks":[{"title":"a","deps":[1]},{"title":"b","deps":[0,0,5]}]}');
  check("plan deps sanitized", JSON.stringify(plan.subtasks.map((s: any) => s.deps)) === "[[],[0]]", plan.subtasks);
  check("impl blocked", (parseRoleOutput("impl", '{"status":"BLOCKED","summary":"need key"}') as any).pass === false);
  check("classify timeout", classifyResult("⏱️ 任务超过 30 分钟").timedOut);
  check("classify cancel", classifyResult("🛑 任务已被用户终止。").cancelled);
  check("progress from cb tool_use", eventToProgress({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }] } }) === "Bash: npm test");
  check("progress from codex cmd", eventToProgress({ type: "item.started", item: { type: "command_execution", command: "ls" } }) === "shell: ls");
}

// ---- config / patch ---------------------------------------------------------
const roles = loadRoles();
const presets = loadPresets();
{
  check("role library loaded", ["planner", "implementer", "critic", "tester"].every((r) => roles.has(r)), [...roles.keys()]);
  for (const p of presets.values()) check(`preset ${p.name} valid`, (() => { try { resolvePreset(p, roles); return true; } catch (e) { console.log(e); return false; } })());
  const dev = presets.get("dev")!;
  const r0 = resolvePreset(dev, roles);
  check("optional stage off by default", !r0.stages.some((s) => s.id === "design_review"));
  const r1 = resolvePreset(applyPatch(dev, { enable: ["design_review"], roles: { implementer: { count: 2 }, critic: { cli: "claude" } } }, presets), roles);
  check("patch enable+count+cli", r1.stages[1].id === "design_review" && r1.roles.implementer.count === 2 && r1.roles.critic.cli === "claude");
  const r2 = resolvePreset(applyPatch(dev, { roles: { tester: null } }, presets), roles);
  check("patch remove role drops stages", !r2.stages.some((s) => s.role === "tester") && !r2.roles.tester);
  check("reject unknown role", throws(() => resolvePreset(applyPatch(dev, { roles: { wizard: { count: 1 } } }, presets), roles), /not in the role library/));
  check("reject count", throws(() => resolvePreset(applyPatch(dev, { roles: { implementer: { count: 99 } } }, presets), roles), /count must be/));
  check("reject unbounded loop", throws(() => resolvePreset(applyPatch(dev, { maxLoops: { review: 0 } }, presets), roles), /max_loops/));
  check("reject unavailable cli", throws(() => resolvePreset(dev, roles, { availableClis: ["codex"] }), /not configured/));
  check("reject non-optional enable", throws(() => applyPatch(dev, { enable: ["review"] }, presets), /not an optional stage/));
  const bad = structuredClone(dev); bad.stages[2].onFail = "test"; bad.stages[2].maxLoops = 1;
  check("reject forward on_fail", throws(() => resolvePreset(bad, roles), /must point backwards/));
}

// ---- core -------------------------------------------------------------------
const devPreset = resolvePreset(presets.get("dev")!, roles);
const mkTask = (over: Partial<Task> = {}): Task => ({
  id: 1, parentId: null, title: "t", goal: "g", spec: "", repo: "/r", baseRef: "b", branch: null, worktree: null,
  preset: devPreset, stageIdx: 0, status: "running", loops: {}, deps: [], feedback: "", inbox: [], chatId: null,
  progress: "", createdAt: 0, updatedAt: 0, ...over,
});
const parsed = (kind: any, text: string) => ({ kind: "parsed" as const, parsed: parseRoleOutput(kind, text) as any });
{
  const idx = (id: string) => devPreset.stages.findIndex((s) => s.id === id);
  let d = decideAfterAttempt(mkTask(), parsed("plan", '{"spec":"S","subtasks":[]}'));
  check("plan → impl", d.patch.stageIdx === idx("impl") && d.patch.spec === "S" && d.launches[0].stageIdx === idx("impl"));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review") }), parsed("verdict", '{"verdict":"revise","issues":["x"],"summary":"bad"}'));
  check("revise → back to impl with feedback", d.patch.stageIdx === idx("impl") && d.patch.loops!.review === 1 && /review 未通过/.test(d.patch.feedback!) && /- x/.test(d.patch.feedback!));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), loops: { review: 3 } }), parsed("verdict", '{"verdict":"revise"}'));
  check("loop budget exhausted → blocked", d.patch.status === "blocked" && d.notifies[0].kind === "decision");
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), feedback: "【review 未通过】x" }), parsed("verdict", '{"verdict":"approve"}'));
  check("approve clears own feedback", d.patch.feedback === "" && d.patch.stageIdx === idx("test"));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("test") }), parsed("test", '{"pass":true,"cases":[]}'));
  check("last stage pass → ready", d.patch.status === "ready" && d.notifies[0].kind === "ready");
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl") }), { kind: "unparseable", error: "no json" });
  check("unparseable → one retry with note", d.launches.length === 1 && /补交/.test(d.launches[0].note!));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl"), loops: { "parse:impl": 1 } }), { kind: "unparseable", error: "no json" });
  check("unparseable twice → blocked", d.patch.status === "blocked");
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl") }), { kind: "run_error", error: "x", timedOut: true });
  check("timeout → retry with split hint", /拆小步骤/.test(d.launches[0]?.note ?? ""));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl") }), parsed("impl", '{"status":"blocked","summary":"need creds"}'));
  check("impl blocked → decision", d.patch.status === "blocked" && /need creds/.test(d.notifies[0].text));
  d = decideAfterAttempt(mkTask(), parsed("plan", '{"spec":"S","subtasks":[{"title":"a"},{"title":"b","deps":[0]}]}'));
  check("plan split → waiting_children", d.patch.status === "waiting_children" && d.children.length === 2);
  const rv = resolvePreset(presets.get("review")!, roles);
  d = decideAfterAttempt(mkTask({ preset: rv, stageIdx: 0 }), parsed("verdict", '{"verdict":"revise","summary":"meh"}'));
  check("advisory verdict does not gate", d.patch.stageIdx === 1 && d.patch.status === "running");
  const kids = [mkTask({ id: 2, status: "ready", branch: "orc/task-2" }), mkTask({ id: 3, status: "running" })];
  check("parent waits", decideParent(mkTask(), kids) === null);
  kids[1].status = "blocked";
  check("parent blocked by child", decideParent(mkTask(), kids)?.patch.status === "blocked");
}


// ---- lead agent action parsing ----------------------------------------------
{
  const a: any = parseLeadAction('好的，我来安排。\n```json\n{"action":"submit","goal":"加登录限流","preset":"dev"}\n```');
  check("lead submit", a.action === "submit" && a.goal === "加登录限流" && a.preset === "dev", a);
  check("lead attach urgent", (parseLeadAction('{"action":"attach","task":"7","text":"改用 redis","urgent":true}') as any).urgent === true);
  check("lead bad task id", "error" in parseLeadAction('{"action":"stop","task":"x"}'));
  check("lead unknown action ignored", "error" in parseLeadAction('{"action":"rm -rf"}'));
  check("lead announce trims", (parseLeadAction('{"action":"announce","paragraphs":[" 结论先行 ",""]}') as any).paragraphs.join() === "结论先行");
  check("lead config", (parseLeadAction('{"action":"config","patch":{"roles":{"critic":{"cli":"claude"}}}}') as any).patch.roles.critic.cli === "claude");
  const prof = { mode: "orc" as const, preset: "dev", patch: { roles: { implementer: { count: 1 } } }, version: 3 };
  check("chat preset applies profile patch", resolveChatPreset(prof).roles.implementer.count === 1);
  check("chat preset extra patch validated", throws(() => resolveChatPreset(prof, { roles: { ghost: { count: 1 } } }), /role library/));
}

// ---- scheduler end-to-end (fake executor) ------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

class FakeExec implements Executor {
  calls: (RunRequest & { role: string; taskId: number })[] = [];
  active = new Map<string, number>();
  maxActive = new Map<string, number>();
  criticCalls = new Map<number, number>();
  stopped = new Set<string>();
  plan = '{"spec":"写 feature.txt","subtasks":[],"summary":"plan ok","notes":["用 txt 存特性"]}';
  implDelay = 20;
  hang = false;
  available() { return ["codebuddy", "codex", "claude"] as any; }
  stop(key: string) { this.stopped.add(key); return true; }
  async run(req: RunRequest): Promise<RunResult> {
    const role = /你的角色：(\S+)/.exec(req.prompt)![1];
    const taskId = Number(/orc 任务 #(\d+)/.exec(req.prompt)![1]);
    this.calls.push({ ...req, role, taskId });
    this.active.set(role, (this.active.get(role) ?? 0) + 1);
    this.maxActive.set(role, Math.max(this.maxActive.get(role) ?? 0, this.active.get(role)!));
    try {
      if (role === "planner") return this.ok(this.plan);
      if (role === "implementer") {
        if (this.hang) { while (!this.stopped.has(req.sessionKey)) await sleep(10); return { text: "🛑 任务已被用户终止。", tokens: 0, timedOut: false, cancelled: true }; }
        await sleep(this.implDelay);
        mkdirSync(join(req.cwd, "pkg", "__pycache__"), { recursive: true });
        writeFileSync(join(req.cwd, "pkg", "__pycache__", "m.cpython-312.pyc"), "bin");
        const f = join(req.cwd, `feature-${taskId}.txt`);
        writeFileSync(f, (existsSync(f) ? readFileSync(f, "utf8") : "") + "x\n");
        return this.ok('{"status":"done","summary":"wrote feature"}', `sess-impl-${taskId}`);
      }
      if (role === "critic") {
        const n = (this.criticCalls.get(taskId) ?? 0) + 1;
        this.criticCalls.set(taskId, n);
        if (n === 1) {
          writeFileSync(join(req.cwd, "critic-was-here.txt"), "oops");
          return this.ok('{"verdict":"revise","issues":[{"severity":"major","file":"feature.txt","desc":"needs two lines"}],"summary":"too short"}');
        }
        return this.ok('{"verdict":"approve","issues":[],"summary":"lgtm"}');
      }
      if (role === "tester") {
        writeFileSync(join(req.cwd, `test-${taskId}.txt`), "case");
        return this.ok('{"pass":true,"cases":[{"name":"exists","cmd":"cat","result":"pass"}],"summary":"all good"}');
      }
      return this.ok('{"summary":"report"}');
    } finally {
      this.active.set(role, this.active.get(role)! - 1);
    }
  }
  private ok(text: string, sessionId = `s-${Math.random().toString(36).slice(2, 8)}`): RunResult {
    return { text, sessionId, tokens: 10, timedOut: false, cancelled: false };
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "orc-check-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const store = new OrcStore(join(dir, "orc.db"));
  const exec = new FakeExec();
  const notes: NotifyPayload[] = [];
  const orc = new Orchestrator(store, exec, {
    orcHome: join(dir, "home"), notify: async (_t, n) => { notes.push(n); }, progressThrottleMs: 0,
  });
  return { dir, repo, store, exec, notes, orc };
}

async function e2e() {
  // A: full dev pipeline with one rework loop
  {
    const { dir, repo, store, exec, notes, orc } = setup();
    const t = orc.submit({ goal: "add feature", repo, preset: devPreset });
    await orc.runUntilIdle(10);
    const done = store.getTask(t.id)!;
    const seq = store.listAttempts(t.id).map((a) => `${a.stageId}:${a.parsed?.pass}`).join(",");
    check("A ready", done.status === "ready", done);
    check("A stage sequence", seq === "plan:true,impl:true,review:false,impl:true,review:true,test:true", seq);
    const impls = exec.calls.filter((c) => c.role === "implementer");
    check("A impl resumed own session", impls[0].resumeSessionId === undefined && impls[1].resumeSessionId === `sess-impl-${t.id}`, impls.map((c) => c.resumeSessionId));
    check("A rework prompt carries feedback", /review 未通过/.test(impls[1].prompt) && /needs two lines/.test(impls[1].prompt));
    const critics = exec.calls.filter((c) => c.role === "critic");
    check("A critic fresh sessions + readOnly", critics[0].sessionKey !== critics[1].sessionKey && critics.every((c) => c.readOnly && !c.resumeSessionId));
    check("A critic sees diff", /feature-1\.txt/.test(critics[0].prompt));
    check("A critic on codebuddy gpt-6.1-sol, implementer on deepseek", critics.every((c) => c.cli === "codebuddy" && c.model === "gpt-6.1-sol") && impls.every((c) => c.model === "deepseek-v4.1-flash-ioa"), [critics[0].cli, critics[0].model, impls[0].model]);
    check("A tester sees spec", exec.calls.find((c) => c.role === "tester")!.prompt.includes("写 feature.txt"));
    check("A artifacts are not violations", notes.filter((n) => /只读角色/.test(n.text)).length === 1 && !/__pycache__/.test(notes.find((n) => /只读角色/.test(n.text))!.text));
    check("A readonly violation reset", !existsSync(join(done.worktree!, "critic-was-here.txt")) && notes.some((n) => /只读角色/.test(n.text)));
    const log = git(done.worktree!, "log", "--oneline", `${done.baseRef}..HEAD`);
    check("A commits per writer attempt", log.split("\n").length === 3 && /test: tester/.test(log), log);
    check("A artifacts not committed", !git(done.worktree!, "ls-files").includes("__pycache__"), git(done.worktree!, "ls-files"));
    check("A main untouched", git(repo, "rev-parse", "main") === done.baseRef);
    const notesDir = join(dir, "home", "notes");
    check("A notes appended", readFileSync(join(notesDir, readdirSync(notesDir)[0]), "utf8").includes("用 txt 存特性"));
    check("A ready notified", notes.some((n) => n.kind === "ready"));
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
  // B: per-role slots across tasks
  {
    const { dir, repo, store, exec, orc } = setup();
    const p = resolvePreset(applyPatch(presets.get("dev")!, { roles: { implementer: { count: 2 }, critic: null, tester: null } }, presets), roles);
    exec.implDelay = 80;
    const ids = [1, 2, 3, 4].map((i) => orc.submit({ goal: `g${i}`, repo, preset: p }).id);
    await orc.runUntilIdle(5);
    check("B all ready", ids.every((id) => store.getTask(id)!.status === "ready"));
    check("B implementer <= 2 concurrent", exec.maxActive.get("implementer") === 2, exec.maxActive);
    check("B planner <= 1 concurrent", exec.maxActive.get("planner") === 1, exec.maxActive);
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
  // C: planner split with dependency → ordered children, parent settles
  {
    const { dir, repo, store, exec, orc } = setup();
    exec.plan = '{"spec":"two parts","subtasks":[{"title":"part A","spec":"A"},{"title":"part B","spec":"B","deps":[0]}]}';
    const t = orc.submit({ goal: "big", repo, preset: devPreset });
    await orc.runUntilIdle(5);
    const kids = store.listTasks({ parentId: t.id }).sort((a, b) => a.id - b.id);
    check("C two children ready", kids.length === 2 && kids.every((k) => k.status === "ready"), kids.map((k) => k.status));
    check("C parent ready", store.getTask(t.id)!.status === "ready", store.getTask(t.id));
    const firstB = exec.calls.findIndex((c) => c.taskId === kids[1].id);
    const lastA = exec.calls.map((c) => c.taskId).lastIndexOf(kids[0].id);
    check("C dep order", firstB > lastA, { firstB, lastA });
    check("C child B built on A", existsSync(join(kids[1].worktree!, `feature-${kids[0].id}.txt`)));
    check("C child starts after plan", store.listAttempts(kids[0].id)[0].stageId === "impl");
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
  // D: stop a running task
  {
    const { dir, repo, store, exec, orc } = setup();
    exec.hang = true;
    const t = orc.submit({ goal: "slow", repo, preset: devPreset });
    const run = orc.runUntilIdle(5);
    for (let i = 0; i < 200 && !exec.calls.some((c) => c.role === "implementer"); i++) await sleep(10);
    orc.stop(t.id);
    await run;
    check("D dropped", store.getTask(t.id)!.status === "dropped");
    check("D attempt cancelled", store.listAttempts(t.id).at(-1)!.status === "cancelled");
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
  // E: crash recovery
  {
    const { dir, repo, store } = setup();
    const task = store.createTask({ title: "x", goal: "x", repo, baseRef: "b", preset: devPreset });
    const eid = store.addEffect("launch", { taskId: task.id, stageIdx: 0 });
    store.markEffect(eid, "running");
    store.createAttempt({ taskId: task.id, stageId: "plan", role: "planner", slot: 0, cli: "codebuddy", model: null, sessionKey: "k", sessionId: null });
    const r = store.recover();
    const eff = store.pendingEffects()[0];
    check("E recover counts", r.attempts === 1 && r.effects === 1, r);
    check("E effect re-queued with recover flag", eff.status === "pending" && eff.payload.recover === true);
    check("E attempt interrupted", store.listAttempts(task.id)[0].status === "interrupted");
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
}

e2e()
  .catch((e) => { failed++; console.log("FAIL e2e crashed", e); })
  .finally(() => { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); });
