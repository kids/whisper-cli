// Offline checks for src/orc (no LLM calls): parser, config/patch validation,
// core state machine, and scheduler end-to-end with a fake executor on a temp
// git repo (worktrees, commits, resume, slots, read-only enforcement, split,
// recovery).   npx tsx scripts/orc_check.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, fallbackNote, loadPresets, loadRoles, resolvePreset } from "../src/orc/config";
import { acceptable, decideAccept, decideAfterAttempt, decideParent, depsGate } from "../src/orc/core";
import { knownIssues, renderAutoNote, renderBrief } from "../src/orc/brief";
import { findJsonObjects, formatFeedback, parseRoleOutput } from "../src/orc/output";
import type { Executor, RunRequest, RunResult } from "../src/orc/runner";
import { classifyResult, eventToProgress } from "../src/orc/runner";
import { Orchestrator } from "../src/orc/scheduler";
import { OrcStore } from "../src/orc/store";
import type { NotifyPayload, Task } from "../src/orc/types";
import { parseLeadAction, resolveChatPreset } from "../src/orc/chat";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}`, detail ?? ""); }
}
function throws(fn: () => unknown, re: RegExp): boolean {
  try { fn(); return false; } catch (e) { return re.test((e as Error).message); }
}

// ---- output parser ----------------------------------------------------------
{
  const t = 'blah {"x":1} more\n```json\n{"verdict":"revise"}\n```\ntrailing';
  check("findJsonObjects string-aware", findJsonObjects(t).length === 2);
  // judgment stages: one conclusion line + prose; only plan/brief/action still use JSON
  const v: any = parseRoleOutput("verdict", "看完了\n[[revise]] 归一化丢了方向\n[[major]] src/extract/normalize.py:88 sign() 归一化丢了方向\n[[minor]] 命名\n[[note]] 已确认修复：测试全绿");
  check("verdict: conclusion line + issue lines", v.pass === false && v.issues.length === 2 && v.issues[0].file === "src/extract/normalize.py" && v.issues[0].line === 88, v);
  check("verdict: notes + prose body", v.notes[0] === "已确认修复：测试全绿" && v.body === "看完了", v);
  check("conclusion last wins", (parseRoleOutput("verdict", "[[revise]] 甲\n[[approve]] 乙") as any).pass === true);
  check("unknown marker is not a conclusion", "error" in parseRoleOutput("verdict", "[[lgtm]] 甲"));
  check("no conclusion line → error", "error" in parseRoleOutput("impl", "改完了，没问题"));
  const implBlocked: any = parseRoleOutput("impl", "缺凭据，跑不起来\n[[blocked]] 需要 API key");
  check("impl: [[blocked]]", implBlocked.pass === false && implBlocked.summary === "需要 API key", implBlocked);
  check("impl: code sample cannot hijack the verdict", (parseRoleOutput("impl", '接口样例：{"status":"ok"}\n\n[[done]] 加了幂等校验') as any).pass === true);
  check("test: [[fail]]", (parseRoleOutput("test", "用例 3 挂了\n[[fail]] 边界用例 3 没通过") as any).pass === false);
  check("report: [[report]] is always a pass", (parseRoleOutput("report", "正文\n[[report]] 结论") as any).pass === true);
  const tFail: any = parseRoleOutput("test", "跑了 pytest，用例 3 挂了\n[[fail]] 边界用例 3 没通过");
  check("feedback falls back to the prose body", /用例 3 挂了/.test(formatFeedback("test", tFail)), formatFeedback("test", tFail));
  check("feedback lists issue lines", /src\/extract\/normalize\.py:88/.test(formatFeedback("review", v)), formatFeedback("review", v));
  const plan: any = parseRoleOutput("plan", '{"spec":"S","subtasks":[{"title":"a","deps":[1]},{"title":"b","deps":[0,0,5]}]}');
  check("plan deps sanitized", JSON.stringify(plan.subtasks.map((s: any) => s.deps)) === "[[],[0]]", plan.subtasks);
  check("plan still needs JSON", "error" in parseRoleOutput("plan", "[[done]] 拆好了"));
  check("brief still needs JSON", "error" in parseRoleOutput("brief", "[[done]] 写完了"));
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
  // a role's *default* CLI missing → falls back to the first available one, with that CLI's default model
  const fb = resolvePreset(presets.get("loop")!, roles, { availableClis: ["codex", "claude"] });
  check("default cli missing → fallback to first available",
    Object.values(fb.roles).every((r) => r.cli === "codex" && r.model === undefined) && fb.fallbacks?.length === 3, fb.roles);
  check("fallback note", fallbackNote(fb) === "本机没有配置 codebuddy：supervisor、implementer、critic 改用 codex（默认模型）", fallbackNote(fb));
  const fbc = resolvePreset(dev, roles, { availableClis: ["cursor"] });
  check("fallback to cursor → auto", Object.values(fbc.roles).every((r) => r.cli === "cursor" && r.model === "auto"));
  const ok = resolvePreset(dev, roles, { availableClis: ["codebuddy", "codex"] });
  check("no fallback when default cli present", !ok.fallbacks && fallbackNote(ok) === "" && ok.roles.critic.model === "gpt-6.1-sol");
  // an explicitly chosen CLI is never swapped
  check("reject unavailable explicit cli", throws(() => resolvePreset(applyPatch(dev, { roles: { critic: { cli: "claude" } } }, presets), roles, { availableClis: ["codebuddy", "codex"] }), /critic.*"claude" is not configured \(available: codebuddy, codex\)/));
  check("reject when nothing configured", throws(() => resolvePreset(dev, roles, { availableClis: [] }), /no CLI is configured/));
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
const issuesText = (summary: string, issues: any[]) =>
  `[[revise]] ${summary}\n` + issues.map((i) => `[[${i.severity === "minor" ? "minor" : "major"}]] ${i.file ?? "-"}:${i.line ?? 1} ${i.desc}`).join("\n");
const parsed = (kind: any, text: string) => ({ kind: "parsed" as const, parsed: parseRoleOutput(kind, text) as any });
{
  const idx = (id: string) => devPreset.stages.findIndex((s) => s.id === id);
  let d = decideAfterAttempt(mkTask(), parsed("plan", '{"spec":"S","subtasks":[]}'));
  check("plan → impl", d.patch.stageIdx === idx("impl") && d.patch.spec === "S" && d.launches[0].stageIdx === idx("impl"));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review") }), parsed("verdict", "[[revise]] bad\n[[major]] x"));
  check("revise → back to impl with feedback", d.patch.stageIdx === idx("impl") && d.patch.loops!.review === 1 && /review 未通过/.test(d.patch.feedback!) && /- x/.test(d.patch.feedback!));
  // round count alone no longer stops it; the cap is a runaway guard
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), loops: { review: 5 } }), parsed("verdict", "[[revise]] bad\n[[major]] x"));
  check("still reworks below the cap when nothing new appears", d.patch.stageIdx === idx("impl") && !d.brief, d);
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), loops: { review: 6 } }), parsed("verdict", "[[revise]] bad\n[[major]] x"), { cap: 6 });
  check("cap reached → escalate", d.brief?.mode === "escalate" && d.brief.rounds === 7, d.brief);
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), feedback: "【review 未通过】x" }), parsed("verdict", "[[approve]] 可以"));
  check("approve clears own feedback", d.patch.feedback === "" && d.patch.stageIdx === idx("test"));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("test") }), parsed("test", "[[pass]] 全绿"));
  check("last stage pass → ready", d.patch.status === "ready" && d.notifies[0].kind === "ready");
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl") }), { kind: "unparseable", error: "no json" });
  check("unparseable → one retry with note", d.launches.length === 1 && /补交/.test(d.launches[0].note!));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl"), loops: { "parse:impl": 1 } }), { kind: "unparseable", error: "no json" });
  check("unparseable twice → blocked", d.patch.status === "blocked");
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl") }), { kind: "run_error", error: "x", timedOut: true });
  check("timeout → retry with split hint", /拆小步骤/.test(d.launches[0]?.note ?? ""));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("impl") }), parsed("impl", "[[blocked]] need creds"));
  check("impl blocked → decision", d.patch.status === "blocked" && /need creds/.test(d.notifies[0].text));
  d = decideAfterAttempt(mkTask(), parsed("plan", '{"spec":"S","subtasks":[{"title":"a"},{"title":"b","deps":[0]}]}'));
  check("plan split → waiting_children", d.patch.status === "waiting_children" && d.children.length === 2);
  const rv = resolvePreset(presets.get("review")!, roles);
  d = decideAfterAttempt(mkTask({ preset: rv, stageIdx: 0 }), parsed("verdict", "[[revise]] meh"));
  check("advisory verdict does not gate", d.patch.stageIdx === 1 && d.patch.status === "running");
  const kids = [mkTask({ id: 2, status: "ready", branch: "orc/task-2" }), mkTask({ id: 3, status: "running" })];
  check("parent waits", decideParent(mkTask(), kids) === null);
  kids[1].status = "blocked";
  const pw = decideParent(mkTask(), kids);
  check("child blocked → parent keeps waiting, no message", pw?.patch.status === "waiting_children" && pw.notifies.length === 0 && /等你决定 t/.test(pw.patch.progress!), pw);
  kids[1].status = "failed";
  const pf = decideParent(mkTask(), [...kids, mkTask({ id: 4, status: "dropped", progress: "跳过：前置任务 t 已放弃" })]);
  check("children settled, some not ready → one info summary", pf?.patch.status === "failed" && pf.notifies.length === 1 && pf.notifies[0].kind === "info" && /t（因前置任务没完成而跳过）/.test(pf.notifies[0].text) && /已完成：t/.test(pf.notifies[0].text), pf?.notifies[0]?.text);

  // deps gate: a blocked dependency (waiting for a human) keeps dependents waiting
  check("deps: blocked dep → wait", depsGate([mkTask({ id: 3, status: "blocked" })]) === "wait");
  check("deps: running dep → wait", depsGate([mkTask({ id: 3, status: "running" })]) === "wait");
  check("deps: failed dep → skip", depsGate([mkTask({ id: 3, status: "failed" })]) === "跳过：前置任务 t 已放弃");
  check("deps: all ready → go", depsGate([mkTask({ id: 3, status: "ready" })]) === "go");

  // review budget used up → a message that says what to decide
  // budget used up → ask the advisor for a 决策说明 instead of a canned line
  const verdictText = [
    "[[revise]] 测试全绿，但归一化会把相反的事实合并",
    "[[major]] src/extract/normalize.py:88 sign() 归一化丢了方向（「利润增长 5%」和「利润下降 5%」会被当成同一条事实合并）",
    "[[note]] 已确认修复：测试 107 个全绿",
  ].join("\n");
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), loops: { review: 3 }, branch: "orc/task-3" }), parsed("verdict", verdictText));
  check("first failure without history reworks", d.patch.stageIdx === idx("impl") && !d.brief, d.patch);
  // new problems appear each round → arbitrate instead of another blind round
  const sameBar = (issues: any[]) => parsed("verdict", issuesText("又有新问题", issues));
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review"), bar: "探索性分析，只拦会让结论错的问题" }), sameBar([{ severity: "major", file: "a.py", desc: "问题甲" }]), { prev: parseRoleOutput("verdict", issuesText("上一轮", [{ severity: "major", file: "b.py", desc: "问题乙" }])) as any });
  check("new problems each round → arbitrate (not another round)", d.brief?.mode === "arbitrate" && d.notifies.length === 0, d.brief);
  // same set (nothing new) → keep reworking
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review") }), sameBar([{ severity: "major", file: "a.py", desc: "问题甲" }]), { prev: parseRoleOutput("verdict", issuesText("上一轮", [{ severity: "major", file: "a.py", line: 9, desc: "问题甲" }])) as any });
  check("same problems, only moved → keep reworking", d.patch.stageIdx === idx("impl") && !d.brief && /问题从 1 条到 1 条/.test(d.patch.progress!), d.patch);
  // only advisory left → the task's own bar makes it a pass
  d = decideAfterAttempt(mkTask({ stageIdx: idx("review") }), parsed("verdict", "[[revise]] 只剩建议\n[[minor]] 命名"));
  check("only minor left → carry on, no block", d.patch.stageIdx === idx("test") && d.notifies[0].kind === "info" && /按口径继续/.test(d.notifies[0].text) && /建议/.test(d.patch.feedback!), d);

  const brief = parseRoleOutput("brief", JSON.stringify({
    situation: "在做分布预测的离线可行性检查，卡在归一化会把方向相反的数值当成同一件事。",
    state: { done: ["107 个测试全绿", "增益 6.3% 已按新口径重算并写入报告"], not_done: ["独立 baseline 没补，无法判断这是模型本身还是预处理带来的"] },
    blockers: [{ what: "归一化丢方向", why_stuck: "当前特征设计里没有保留正负号的位置，改要动抽取层的 schema", evidence: "src/extract/normalize.py:88" }],
    options: [
      { name: "补 baseline", what: "按论文口径重建独立 baseline，再对比", cost: "约 2 天", risk: "结论可能整个回到不可行", reversible: "能补救", recommended: true },
      { name: "带已知问题先交付", what: "把这版当探索性结论，报告里写明归一化缺陷", cost: "半天", risk: "被引用后可能误导", reversible: "能补救" },
    ],
    recommendation: "补 baseline：这一步不做，后面所有增益数字都说不清来源。",
    needs_from_human: "这个报告是内部参考还是要对外发布？对外就必须先补 baseline。",
    auto: "none", known_issues: [],
  })) as any;
  const briefText = renderBrief(mkTask({ id: 3, title: "分布预测可行性", branch: "orc/task-3" }), brief, "评审");
  check("brief: header names the task and the stage", briefText.startsWith("**分布预测可行性：评审反复没过，需要你定一件事**"), briefText);
  check("brief: situation + what is done / not done", briefText.includes("在做分布预测") && /已经做到：\n- 107 个测试全绿/.test(briefText) && briefText.includes("还没做到："));
  check("brief: blocker with why and evidence", /1\. 归一化丢方向\n   原因：当前特征设计/.test(briefText) && briefText.includes("依据：src/extract/normalize.py:88"));
  check("brief: real options with cost/risk/undo", /1\. \*\*补 baseline\*\*（建议）：/.test(briefText) && briefText.includes("代价：约 2 天") && briefText.includes("风险：结论可能整个回到不可行") && briefText.includes("补救：能补救"));
  check("brief: recommendation + what is needed from the human", briefText.includes("**建议**：补 baseline") && briefText.includes("**需要你给的**：这个报告是内部参考"));
  check("brief: says how to answer", briefText.includes("直接说选哪个就行") && briefText.includes("orc/task-3"));
  const auto = parseRoleOutput("brief", JSON.stringify({ situation: "x", auto: "continue_with_known_issues", known_issues: ["归一化丢方向，报告里已写明"], recommendation: "不影响主要结论" })) as any;
  check("brief: auto only with known issues", knownIssues(auto).length === 1 && knownIssues(brief).length === 0);
  check("brief: auto note lists what was deferred", renderAutoNote(mkTask({ id: 3, title: "t" }), auto, knownIssues(auto)).includes("归一化丢方向，报告里已写明"));

  // 接受
  const blockedReview = mkTask({ stageIdx: idx("review"), status: "blocked", loops: { review: 3 }, feedback: "【review 未通过】x" });
  check("acceptable: blocked review", acceptable(blockedReview)?.id === "review");
  check("acceptable: not on impl", !acceptable(mkTask({ stageIdx: idx("impl"), status: "blocked" })));
  check("acceptable: not when running", !acceptable(mkTask({ stageIdx: idx("review"), status: "running" })));
  const acc = decideAccept(blockedReview, "baseline 下次再补")!;
  check("accept → next stage, feedback cleared, note passed on", acc.patch.stageIdx === idx("test") && acc.patch.status === "running" && acc.patch.feedback === "" && /baseline 下次再补/.test(acc.launches[0].note!), acc);
  const accLast = decideAccept(mkTask({ stageIdx: idx("test"), status: "blocked", branch: "orc/task-1" }))!;
  check("accept on last stage → ready", accLast.patch.status === "ready" && accLast.notifies[0].kind === "ready" && /orc\/task-1/.test(accLast.notifies[0].text));
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
  alwaysRevise = new Set<number>();
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
        return this.ok("[[done]] wrote feature", `sess-impl-${taskId}`);
      }
      if (role === "critic") {
        const n = (this.criticCalls.get(taskId) ?? 0) + 1;
        this.criticCalls.set(taskId, n);
        if (this.alwaysRevise.has(taskId)) {
          return this.ok('[[revise]] 还不行\n[[major]] feature.txt:1 still wrong（结果会算错）');
        }
        if (n === 1) {
          writeFileSync(join(req.cwd, "critic-was-here.txt"), "oops");
          return this.ok('[[revise]] too short\n[[major]] feature.txt:1 needs two lines');
        }
        return this.ok('[[approve]] lgtm');
      }
      if (role === "tester") {
        writeFileSync(join(req.cwd, `test-${taskId}.txt`), "case");
        return this.ok('[[pass]] all good');
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
  // F: a child stuck on review waits for a human; its dependents wait quietly; 接受 lets everything continue
  {
    const { dir, repo, store, exec, notes, orc } = setup();
    exec.plan = '{"spec":"two parts","subtasks":[{"title":"part A","spec":"A"},{"title":"part B","spec":"B","deps":[0]}]}';
    exec.alwaysRevise.add(2);
    const t = orc.submit({ goal: "big", repo, preset: devPreset });
    const tick = () => (orc as any).tick();
    for (let i = 0; i < 3000 && store.getTask(2)?.status !== "blocked"; i++) { await tick(); await sleep(5); }
    for (let i = 0; i < 60; i++) { await tick(); await sleep(5); }
    const decisions = notes.filter((n) => n.kind === "decision");
    check("F one decision message, for the stuck child only", decisions.length === 1 && decisions[0].taskId === 2, notes.map((n) => `${n.taskId}:${n.kind}`));
    check("F decision says what is held up", /这是「big」的子任务；part B 要等它定下来才会开始/.test(decisions[0]?.text ?? ""), decisions[0]?.text);
    check("F dependent keeps waiting (not blocked / dropped)", store.getTask(3)!.status === "queued" && !store.listAttempts(3).length, store.getTask(3));
    check("F parent keeps waiting", store.getTask(t.id)!.status === "waiting_children" && /等你决定 part A/.test(store.getTask(t.id)!.progress), store.getTask(t.id));
    exec.alwaysRevise.delete(2);
    check("F accept", orc.accept(2, "先这样"));
    await orc.runUntilIdle(5);
    check("F accepted child ran test and finished", store.getTask(2)!.status === "ready" && store.listAttempts(2).at(-1)!.stageId === "test");
    check("F dependent ran after accept", store.getTask(3)!.status === "ready");
    check("F parent ready", store.getTask(t.id)!.status === "ready");
    check("F still only one decision message", notes.filter((n) => n.kind === "decision").length === 1);
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
  // G: the stuck child is given up → dependents skipped quietly, parent sends one summary
  {
    const { dir, repo, store, exec, notes, orc } = setup();
    exec.plan = '{"spec":"two parts","subtasks":[{"title":"part A","spec":"A"},{"title":"part B","spec":"B","deps":[0]}]}';
    exec.alwaysRevise.add(2);
    const t = orc.submit({ goal: "big", repo, preset: devPreset });
    const tick = () => (orc as any).tick();
    for (let i = 0; i < 3000 && store.getTask(2)?.status !== "blocked"; i++) { await tick(); await sleep(5); }
    orc.stop(2);
    await orc.runUntilIdle(5);
    check("G dependent skipped", store.getTask(3)!.status === "dropped" && /跳过：前置任务 part A 已终止/.test(store.getTask(3)!.progress), store.getTask(3));
    const parentNotes = notes.filter((n) => n.taskId === t.id && n.kind !== "info" || (n.taskId === t.id && /没有全部完成/.test(n.text)));
    check("G parent failed with one info summary", store.getTask(t.id)!.status === "failed" && parentNotes.length === 1 && parentNotes[0].kind === "info", parentNotes);
    check("G no extra decision messages", notes.filter((n) => n.kind === "decision").length === 1);
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
