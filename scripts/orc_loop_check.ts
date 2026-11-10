// Offline checks for the Supervisor loop (src/orc/ledger.ts + loop.ts), no LLM:
// pure guards, then scripted Supervisor / worker / reviewer on a temp git repo.
//   npx tsx scripts/orc_loop_check.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "orc-loop-check-"));
process.env.WATCHES_PATH = join(root, "watches.json");
const W = await import("../src/watch");
const L = await import("../src/orc/ledger");
const { loadPresets, loadRoles, resolvePreset, presetSummary } = await import("../src/orc/config");
const { Orchestrator } = await import("../src/orc/scheduler");
const { OrcStore } = await import("../src/orc/store");
const { parseLeadAction, buildLeadPrompt, renderCard } = await import("../src/orc/chat");
import type { Executor, RunRequest, RunResult } from "../src/orc/runner";
import type { NotifyPayload } from "../src/orc/types";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}`, detail ?? ""); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
const J = (o: unknown) => JSON.stringify(o);

const roles = loadRoles();
const presets = loadPresets();
const loopPreset = resolvePreset(presets.get("loop")!, roles);
const limits = { maxSteps: 60, maxWorkerRuns: 25, maxActiveHours: 8 };
const mk = (over: Partial<Parameters<typeof L.createLedger>[0]> = {}) =>
  L.createLedger({ goal: "g", criteria: ["测试通过"], constraints: ["只用 JS"], head: "sha0", limits, verbosity: "normal", ...over });
const ctx = { hasReviewer: true, requireReview: false, canWait: true };
const act = (o: object) => L.parseLoopAction(J(o)) as any;
const v = (l: any, o: object, c: Partial<typeof ctx> = {}) => L.validateAction(l, act(o), { ...ctx, ...c });

// ---- preset / parsing ---------------------------------------------------------
{
  check("loop preset resolves", loopPreset.kind === "loop" && loopPreset.loop?.worker === "implementer" && loopPreset.stages.length === 0, loopPreset);
  check("loop preset summary", /监督\[.+\] ⇄ 执行\[.+\]/.test(presetSummary(loopPreset)), presetSummary(loopPreset));
  check("supervisor role is read-only action", roles.get("supervisor")?.output === "action" && roles.get("supervisor")?.isolation === "readonly");
  const p = L.parseLoopAction('分析一下……\n```json\n{"action":"report","progress":"a"}\n```\n最后：{"action":"instruct","text":"写测试","plan":["x",{"text":"y","status":"done"}],"decision":"先测后写"}');
  check("last action JSON wins + plan/decision", !("error" in p) && p.action === "instruct" && p.plan?.[1].status === "done" && p.decision === "先测后写", p);
  check("unknown action rejected", "error" in L.parseLoopAction('{"action":"rm"}'));
  check("no JSON rejected", "error" in L.parseLoopAction("我觉得可以"));
  const ask: any = act({ action: "ask", question: "q", why: "high_cost", options: ["甲", "乙"], default: "a" });
  check("ask string options get ids", ask.options.map((o: any) => o.id).join() === "a,b");
  check("verify shorthand cmd", act({ action: "verify", cmd: "npm test" }).checks[0].cmd === "npm test");
}

// ---- code-side guards ---------------------------------------------------------
{
  check("irreversible: git push", L.irreversibleHit("改完后 git push origin main") === "git push");
  check("irreversible: negated", L.irreversibleHit("改完提交即可，不要 git push") === undefined);
  check("irreversible: deploy", L.irreversibleHit("部署到生产环境") !== undefined);
  check("irreversible: drop table", L.irreversibleHit("DROP TABLE users") !== undefined);
  check("irreversible: plain work", L.irreversibleHit("跑一下单测，修掉失败的用例") === undefined);

  const l = mk();
  check("instruct irreversible needs approval", /不可逆/.test(v(l, { action: "instruct", text: "然后 git push" }) ?? ""));
  l.approvals.push({ step: 1, question: "推吗", answer: "推", at: 0 });
  check("instruct irreversible with approval", v(l, { action: "instruct", text: "然后 git push" }) === undefined);
  l.approvals[0].used = true;
  check("approval is single-use", v(l, { action: "instruct", text: "然后 git push" }) !== undefined);

  check("verify must be read-only", /只读/.test(v(l, { action: "verify", checks: [{ cmd: "kubectl apply -f x.yaml" }] }) ?? ""));
  check("verify bad regex", /正则/.test(v(l, { action: "verify", checks: [{ cmd: "ls", expect: "(" }] }) ?? ""));
  check("verify timeout cap", /timeout_s/.test(v(l, { action: "verify", checks: [{ cmd: "ls", timeout_s: 4000 }] }) ?? ""));
  check("verify max 8", /最多 8/.test(v(l, { action: "verify", checks: Array(9).fill("ls") }) ?? ""));

  l.guard.lastAction = "report";
  check("no report twice", /连续两轮/.test(v(l, { action: "report", progress: "x" }) ?? ""));
  l.guard.lastAction = "verify";
  check("report ok after work", v(l, { action: "report", progress: "x" }) === undefined);

  // constraints: tightening is free, loosening only on a human's quoted words
  check("add constraint by supervisor", v(l, { action: "update_constraints", changes: [{ op: "add", text: "加日志" }], reason: "r" }) === undefined);
  check("modify by supervisor rejected", /只能由人提出/.test(v(l, { action: "update_constraints", changes: [{ op: "modify", id: "K1", text: "随意" }], reason: "r", source: "supervisor" }) ?? ""));
  check("modify needs existing id", /已有的 id/.test(v(l, { action: "update_constraints", changes: [{ op: "remove", id: "K9" }], reason: "r", source: "human", quote: "x" }) ?? ""));
  check("fabricated quote rejected", /原样引用/.test(v(l, { action: "update_constraints", changes: [{ op: "remove", id: "K1" }], reason: "r", source: "human", quote: "人说可以删" }) ?? ""));
  L.noteHuman(l, "K1 不要了，TypeScript 也行");
  check("real quote accepted (whitespace-insensitive)", v(l, { action: "update_constraints", changes: [{ op: "remove", id: "K1" }], reason: "r", source: "human", quote: "K1不要了" }) === undefined);
  check("reason required", /reason/.test(v(l, { action: "update_constraints", changes: [{ op: "add", text: "x" }] }) ?? ""));
  const a = act({ action: "update_constraints", changes: [{ op: "add", target: "criterion", text: "覆盖率>80%" }, { op: "remove", id: "K1" }], reason: "人要求", source: "human", quote: "K1 不要了" });
  const lines = L.applyChanges(l, a, 3);
  check("applyChanges add+remove+version", l.criteria.map((c) => c.id).join() === "C1,C2" && l.constraints.length === 0 && l.constraintsVersion === 2 && lines.length === 2, { lines, c: l.criteria });

  // ask
  const irr = (opts: any[], d = "a") => v(l, { action: "ask", question: "推送吗", why: "irreversible", options: opts, default: d });
  check("ask why must be in set", /why 必须/.test(v(l, { action: "ask", question: "q", why: "curious", options: ["a", "b"], default: "a" }) ?? ""));
  check("ask irreversible needs go option", /go/.test(irr([{ id: "a", label: "不推" }, { id: "b", label: "推" }]) ?? ""));
  check("ask irreversible default not go", /默认/.test(irr([{ id: "a", label: "不推" }, { id: "b", label: "推", go: true }], "b") ?? ""));
  check("ask irreversible ok", irr([{ id: "a", label: "不推" }, { id: "b", label: "推", go: true }]) === undefined);
  check("ask default must exist", /default/.test(v(l, { action: "ask", question: "q", why: "high_cost", options: ["x", "y"], default: "z" }) ?? ""));

  // wait
  check("wait needs chat", /没有绑定群/.test(v(l, { action: "wait", watch: { pid: 9 } }, { canWait: false }) ?? ""));
  check("wait keep without watch", /keep 无效/.test(v(l, { action: "wait", keep: true }) ?? ""));
  check("wait spec validated", /watch 不合法/.test(L.validateAction(l, act({ action: "wait", watch: { title: "x" } }), { ...ctx, checkWatch: (r) => W.parseWatchSpec(r, root) }) ?? ""));

  // finish gate: every criterion needs passing evidence collected on the current code version
  const f = mk();
  const fin = (acc: object[], c: Partial<typeof ctx> = {}) => v(f, { action: "finish", summary: "done", acceptance: acc }, c);
  check("finish without criteria", /验收标准/.test(v(mk({ criteria: [] }), { action: "finish", summary: "s", acceptance: [] }) ?? ""));
  check("finish missing evidence", /C1 没有对应证据/.test(fin([]) ?? ""));
  L.addEvidence(f, { kind: "verify", label: "npm test", pass: false, detail: "", sha: "sha0", step: 1 });
  check("finish with failing evidence", /没有通过/.test(fin([{ criterion: "C1", evidence: "E1" }]) ?? ""));
  L.addEvidence(f, { kind: "verify", label: "npm test", pass: true, detail: "", sha: "sha0", step: 2 });
  check("finish with passing evidence", fin([{ criterion: "C1", evidence: "E2" }]) === undefined);
  L.codeChanged(f, "sha1");
  check("finish rejects stale evidence", /旧版本/.test(fin([{ criterion: "C1", evidence: "E2" }]) ?? ""));
  L.addEvidence(f, { kind: "verify", label: "npm test", pass: true, detail: "", sha: "sha1", step: 4 });
  check("finish requireReview", /review/.test(fin([{ criterion: "C1", evidence: "E3" }], { requireReview: true }) ?? ""));
  L.addEvidence(f, { kind: "review", label: "ok", pass: true, detail: "", sha: "sha1", step: 5 });
  check("finish with review ok", fin([{ criterion: "C1", evidence: "E3" }], { requireReview: true }) === undefined);
  check("finish nonexistent evidence", /不存在/.test(fin([{ criterion: "C1", evidence: "E99" }]) ?? ""));

  // abort
  check("abort needs tried", /tried/.test(v(f, { action: "abort", reason: "r", blockers: ["b"], unmet: ["C1"] }) ?? ""));
  check("abort needs unmet", /unmet/.test(v(f, { action: "abort", reason: "r", tried: ["t"], blockers: ["b"] }) ?? ""));
  check("abort unknown criterion", /不存在/.test(v(f, { action: "abort", reason: "r", tried: ["t"], blockers: ["b"], unmet: ["C7"] }) ?? ""));

  // budget + guards
  const b = mk({ limits: { maxSteps: 10, maxWorkerRuns: 5, maxActiveHours: 1 } });
  b.budget.steps = 8;
  check("budget ratio", Math.abs(L.budgetState(b).ratio - 0.8) < 1e-9 && !L.budgetState(b).exhausted);
  b.budget.workerRuns = 5;
  check("budget exhausted", /worker/.test(L.budgetState(b).exhausted ?? ""));
  L.extendBudget(b);
  check("budget extended", !L.budgetState(b).exhausted && b.limits.maxWorkerRuns === 8 && b.limits.maxSteps === 15, b.limits);
  const g = L.guardAsk(b, "idle", "x", 1000);
  check("guard ask defaults to stop", g.code === "idle" && g.default === "stop" && g.options.some((o) => o.id === "continue") && !!g.timeoutAt);

  // events: a fired awaited watch becomes evidence + wakes the task
  const e = mk();
  e.waitWatch = 7;
  e.events.push({ at: 1, kind: "watch", watchId: 7, title: "训练", fireKind: "done", reason: "日志出现 Training finished", evidence: "loss=0.1" });
  e.events.push({ at: 2, kind: "note", text: "人调整了角色" });
  const woke = L.drainEvents(e);
  check("drain: awaited watch wakes", woke && e.waitWatch === undefined && e.events.length === 0);
  check("drain: watch evidence passes", e.evidence[0]?.kind === "watch" && e.evidence[0].pass && e.evidence[0].sha === e.lastChangeSha);
  check("drain: note observed", e.observations.some((o) => o.text === "人调整了角色"));
  e.events.push({ at: 3, kind: "watch", watchId: 8, title: "其他", fireKind: "error", reason: "Traceback", evidence: "" });
  check("drain: unrelated watch does not wake", !L.drainEvents(e) && e.evidence[1].pass === false);

  // prompts
  const sp = L.buildSupervisorPrompt(e, { taskId: 3, title: "t", worktree: "/w", branch: "b", diffStat: "", worker: "implementer/codex", reviewer: "critic/claude", reason: "start", canWait: false });
  check("supervisor prompt: actions + rules", /"action":"finish"/.test(sp) && /当前版本/.test(sp) && !/"action":"wait"/.test(sp) && /"action":"review"/.test(sp));
  const wp = L.buildWorkerPrompt(e, "写测试", { taskId: 3, fresh: true, rolePrompt: "你是实现者", branch: "b" });
  check("worker prompt: fresh carries goal + background-job hint", /任务目标/.test(wp) && /setsid/.test(wp) && /写测试/.test(wp));
}

// ---- lead agent: steering actions ----------------------------------------------
{
  const pa = (s: string) => parseLeadAction(s) as any;
  check("lead answer", J(pa('{"action":"answer","task":"5","option":"b"}')) === J({ action: "answer", task: 5, option: "b" }));
  check("lead answer free text", pa('{"action":"answer","task":5,"text":"先别推，等我看完"}').text === "先别推，等我看完");
  check("lead answer needs content", "error" in pa('{"action":"answer","task":5}'));
  const c = pa('{"action":"config","task":5,"patch":{"roles":{"implementer":{"cli":"claude","model":"opus"}}}}');
  check("lead config on running task", c.task === 5 && c.patch.roles.implementer.model === "opus");
  check("lead verbosity only", J(pa('{"action":"config","task":5,"verbosity":"quiet"}')) === J({ action: "config", task: 5, patch: {}, verbosity: "quiet" }));
  check("lead verbosity inside patch", J(pa('{"action":"config","task":5,"patch":{"verbosity":"quiet"}}')) === J({ action: "config", task: 5, patch: {}, verbosity: "quiet" }));
  check("lead confirm / cancel", pa('{"action":"confirm"}').action === "confirm" && pa('{"action":"cancel"}').action === "cancel");
  check("lead submit with criteria", J(pa('{"action":"submit","goal":"g","preset":"loop","criteria":["测试通过"," "],"constraints":["不改接口"]}').criteria) === '["测试通过"]');
  const l = mk();
  l.pendingAsk = { step: 2, question: "要推送到远端吗？", why: "irreversible", options: [{ id: "a", label: "先不推" }, { id: "b", label: "推送", go: true }], default: "a", askedAt: 0 };
  const t: any = { id: 5, title: "调参", status: "blocked", progress: "等你决定", kind: "loop", preset: loopPreset, createdAt: Date.now(), chatId: "c" };
  const prompt = buildLeadPrompt({ userText: "推吧", presetLine: "loop", tasks: [t], presets: ["loop"], roles: ["supervisor"], store: { getLedger: () => l } as any, pending: "调整编排 {}", threadTask: 5 });
  check("lead prompt shows open question + options", prompt.includes("要推送到远端吗") && prompt.includes("b) 推送") && prompt.includes("默认 a"));
  check("lead prompt shows thread task + pending", prompt.includes("任务 #5 卡片的回复串") && prompt.includes("待用户确认的提议"));
  check("lead prompt shows roles", /implementer=\w+/.test(prompt));
  const card = renderCard(t, { getLedger: () => l } as any);
  check("loop card", /监督循环/.test(card) && /等你决定：要推送/.test(card) && /预算/.test(card), card);
}

// ---- engine end-to-end (scripted CLIs) -----------------------------------------
type Reply = string | ((req: RunRequest) => string | Promise<string>);
interface Call { taskId: number; role: string; req: RunRequest }

class LoopFake implements Executor {
  calls: Call[] = [];
  sup = new Map<number, Reply[]>();
  worker = new Map<number, ((req: RunRequest, n: number) => string | Promise<string>)>();
  review: Reply = '{"verdict":"approve","issues":[],"summary":"看过了，没问题"}';
  stopped = new Set<string>();
  available() { return ["codebuddy", "codex", "claude"] as any; }
  stop(key: string) { this.stopped.add(key); return true; }
  async run(req: RunRequest): Promise<RunResult> {
    const m = /^orc-loop:(\d+)#(\w+)/.exec(req.sessionKey)!;
    const taskId = Number(m[1]);
    const role = m[2];
    this.calls.push({ taskId, role, req });
    await sleep(5);
    let text: string;
    let sessionId = `s-${role}-${this.calls.length}`;
    if (role === "supervisor") {
      const q = this.sup.get(taskId) ?? [];
      const r = q.shift();
      if (r === undefined) throw new Error(`supervisor script for #${taskId} exhausted`);
      text = typeof r === "function" ? await r(req) : r;
    } else if (role === "worker") {
      const n = this.calls.filter((c) => c.taskId === taskId && c.role === "worker").length;
      text = await this.worker.get(taskId)!(req, n);
      sessionId = req.resumeSessionId ?? `w-${taskId}-${n}`;
    } else {
      text = typeof this.review === "function" ? await this.review(req) : this.review;
    }
    return { text, sessionId, tokens: 10, timedOut: false, cancelled: false };
  }
  of(taskId: number, role: string) { return this.calls.filter((c) => c.taskId === taskId && c.role === role); }
}

function setup(chat = false) {
  const dir = mkdtempSync(join(root, "case-"));
  const repo = join(dir, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  const store = new OrcStore(join(dir, "orc.db"));
  const exec = new LoopFake();
  const notes: NotifyPayload[] = [];
  const watches: number[] = [];
  const orc = new Orchestrator(store, exec, {
    orcHome: join(dir, "home"), notify: async (_t, n) => { notes.push(n); }, progressThrottleMs: 0,
    loop: chat ? { watchBot: () => "bot", onWatchCreated: (_t, w) => { watches.push(w.id); } } : {},
  });
  const drive = async (until: () => boolean, ms = 15_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await orc.tick();
      if (until() && store.dueEffects().every((e) => e.kind !== "notify")) {
        for (let i = 0; i < 200 && [...Array(50).keys()].some((id) => orc.loop.isBusy(id)); i++) await sleep(10);
        await orc.tick();
        return true;
      }
      await sleep(10);
    }
    return false;
  };
  const done = () => { store.close(); rmSync(dir, { recursive: true, force: true }); };
  return { dir, repo, store, exec, notes, orc, drive, watches, done };
}

const S = (o: object) => `我看了一下现状。\n${J(o)}`;

async function e2e() {
  // A: implement → verify (fails) → premature finish rejected → correct → verify → review → finish
  {
    const { dir, repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "实现 add(a,b)", repo, preset: loopPreset, criteria: ["add(2,3) 等于 5"], sourceText: "帮我写个 add" });
    const id = t.id;
    const testCmd = `node -e "process.exit(require('./add.js')(2,3)===5?0:1)"`;
    exec.worker.set(id, (req, n) => {
      writeFileSync(join(req.cwd, "add.js"), n === 1 ? "module.exports=(a,b)=>a-b\n" : "module.exports=(a,b)=>a+b\n");
      return J({ status: "done", summary: n === 1 ? "写好了 add.js" : "修好了符号" });
    });
    exec.sup.set(id, [
      S({ action: "instruct", text: "新建 add.js，导出 add(a,b)", plan: [{ text: "实现 add", status: "doing" }] }),
      () => { orc.attach(id, "函数名以后改成 plusTwo", false, "顺便把函数名改成 plusTwo 吧"); return S({ action: "verify", checks: [{ cmd: testCmd, label: "add 冒烟" }] }); },
      S({ action: "finish", summary: "做完了", acceptance: [{ criterion: "C1", evidence: "E1" }] }),
      S({ action: "instruct", text: "add 返回的是 a-b，改成 a+b" }),
      S({ action: "verify", checks: [{ cmd: testCmd }] }),
      S({ action: "review", focus: "边界" }),
      S({ action: "finish", summary: "add 实现并通过冒烟", acceptance: [{ criterion: "C1", evidence: "E2" }] }),
    ]);
    const ok = await drive(() => store.getTask(id)!.status === "ready");
    const task = store.getTask(id)!;
    const l = orc.loop.ledger(id)!;
    const steps = store.listSteps(id);
    const sups = exec.of(id, "supervisor");
    const workers = exec.of(id, "worker");
    check("A ready", ok && task.status === "ready", { status: task.status, progress: task.progress, obs: l.observations.slice(-3) });
    check("A 7 rounds, #3 rejected", steps.length === 7 && steps[2].accepted === false && /完成门禁未通过/.test(steps[2].verdict), steps.map((s: any) => [s.n, s.accepted, s.verdict]));
    check("A rejection fed back", /完成门禁未通过/.test(sups[3]?.req.prompt ?? ""));
    check("A mid-round human message reaches next round", /plusTwo/.test(sups[2]?.req.prompt ?? "") && !/plusTwo/.test(sups[1]?.req.prompt ?? ""), sups.map((s, i) => i + ":" + /plusTwo/.test(s.req.prompt)).join(" "));
    check("A human's own words kept for quotes", l.humanLog.some((h) => h.text === "顺便把函数名改成 plusTwo 吧") && l.humanLog.some((h) => h.text === "帮我写个 add"));
    check("A supervisor fresh + read-only", sups.every((c) => c.req.readOnly && !c.req.resumeSessionId));
    check("A worker resumes its session", workers.length === 2 && !workers[0].req.resumeSessionId && workers[1].req.resumeSessionId === `w-${id}-1` && !workers[1].req.readOnly);
    check("A reviewer read-only", exec.of(id, "reviewer").every((c) => c.req.readOnly));
    check("A evidence: E1 fail on v1, E2 pass on v2, E3 review", l.evidence.map((e) => `${e.id}${e.pass ? "+" : "-"}${e.kind[0]}`).join() === "E1-v,E2+v,E3+r" && l.evidence[0].sha !== l.evidence[1].sha, l.evidence);
    check("A two worker commits on branch, main untouched", git(task.worktree!, "log", "--oneline", `${task.baseRef}..HEAD`).split("\n").length === 2 && git(repo, "rev-parse", "main") === task.baseRef);
    check("A turns posted (主 → 子)", notes.filter((n) => n.kind === "turn").length >= 5 && notes.some((n) => n.kind === "turn" && /主 → 子/.test(n.text)));
    check("A ready notify lists acceptance", notes.some((n) => n.kind === "ready" && /C1 .+ ← E2 ✓/.test(n.text)), notes.filter((n) => n.kind === "ready"));
    check("A plan kept", l.plan[0]?.text === "实现 add");
    check("A budget counted", l.budget.steps === 7 && l.budget.workerRuns === 2);
    check("A prompts/outputs kept on disk", existsSync(join(dir, "home", "tasks", String(id), "loop-1-supervisor.prompt.md")) && existsSync(join(dir, "home", "tasks", String(id), "loop-1-worker.output.md")));
    done();
  }

  // B: human steering — loosen a constraint by quote, irreversible ask → approval (single use), live model switch, abort
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "做个 CLI 工具", repo, preset: loopPreset, criteria: ["测试通过"], constraints: ["只用 JavaScript"], sourceText: "做个工具" });
    const id = t.id;
    orc.attach(id, "去掉 K1 的限制", false, "K1 不要了，可以用 TypeScript");
    let switched = "";
    exec.worker.set(id, (req, n) => {
      if (n === 1) switched = orc.loop.setRoles(id, { implementer: { cli: "claude" } }, ["codebuddy", "codex", "claude"]);
      writeFileSync(join(req.cwd, `f${n}.txt`), "x");
      return J({ status: "done", summary: `第 ${n} 次完成` });
    });
    exec.sup.set(id, [
      S({ action: "update_constraints", changes: [{ op: "remove", target: "constraint", id: "K1" }], reason: "人说不限语言了", source: "human", quote: "K1 不要了" }),
      S({ action: "update_constraints", changes: [{ op: "modify", target: "criterion", id: "C1", text: "能跑就行" }], reason: "简化", source: "human", quote: "能跑就行" }),
      S({ action: "ask", question: "要推送到远端吗？", why: "irreversible", options: [{ id: "a", label: "先不推" }, { id: "b", label: "推送", go: true }], default: "a" }),
    ]);
    await drive(() => store.getTask(id)!.status === "blocked");
    let l = orc.loop.ledger(id)!;
    check("B quote-backed loosening applied", l.constraints.length === 0 && l.constraintsVersion === 2 && notes.some((n) => n.kind === "constraints"), l.constraints);
    check("B fabricated quote rejected", store.listSteps(id)[1]?.accepted === false && l.criteria[0].text === "测试通过");
    check("B first round saw the human message", /K1 不要了/.test(exec.of(id, "supervisor")[0].req.prompt));
    check("B irreversible ask blocks, no timeout", store.getTask(id)!.status === "blocked" && !l.pendingAsk?.timeoutAt && store.pendingLoopEffects(id).length === 0);
    check("B ask posted with options", notes.some((n) => n.kind === "ask" && /b\)\*\* 推送/.test(n.text) && /不会自动执行/.test(n.text)), notes.filter((n) => n.kind === "ask"));
    check("B wrong option refused", /没有选项/.test(orc.loop.answer(id, "z")));

    exec.sup.get(id)!.push(
      S({ action: "instruct", text: "提交后 git push origin HEAD" }),
      S({ action: "instruct", text: "再 git push 一次" }),
      S({ action: "instruct", text: "补一个 README" }),
      S({ action: "abort", reason: "远端仓库不存在", tried: ["推送"], blockers: ["没有 remote"], unmet: ["C1"], resume_hint: "配好 remote 再试" }),
    );
    check("B answer go", /继续推进/.test(orc.loop.answer(id, "b", undefined, "推吧")));
    l = orc.loop.ledger(id)!;
    check("B approval recorded", l.approvals.length === 1 && !l.approvals[0].used && store.getTask(id)!.status === "running");
    await drive(() => store.getTask(id)!.status === "failed");
    l = orc.loop.ledger(id)!;
    const steps = store.listSteps(id);
    const workers = exec.of(id, "worker");
    check("B approved irreversible instruct ran", steps[3]?.accepted && workers[0]?.req.prompt.includes("git push origin HEAD"), steps.map((s: any) => [s.n, s.accepted]));
    check("B approval single-use", steps[4]?.accepted === false && /不可逆/.test(steps[4].verdict) && l.approvals[0].used === true);
    check("B role switch reported", switched === "implementer：codebuddy:deepseek-v4.1-flash-ioa → claude", switched);
    check("B switched worker: new CLI, fresh session + handoff", workers[1]?.req.cli === "claude" && !workers[1].req.resumeSessionId && /任务目标/.test(workers[1].req.prompt), workers.map((w) => [w.req.cli, w.req.resumeSessionId]));
    check("B switch visible to supervisor", exec.of(id, "supervisor").slice(-2).some((c) => /人调整了角色/.test(c.req.prompt)));
    check("B abort → failed with summary", store.getTask(id)!.status === "failed" && notes.some((n) => n.kind === "failed" && /没有 remote/.test(n.text) && /C1/.test(n.text)));
    check("B retry resumes", orc.retry(id, "remote 配好了") && store.getTask(id)!.status === "running" && store.pendingLoopEffects(id).length === 1);
    orc.stop(id);
    check("B stop after retry", store.getTask(id)!.status === "dropped" && store.pendingLoopEffects(id).length === 0);
    done();
  }

  // C: long job — worker starts it in the background, supervisor parks on a watch (no rounds while waiting),
  //    a human message mid-wait keeps waiting, the watch fires → evidence → finish
  {
    const { dir, repo, store, exec, notes, orc, drive, watches, done } = setup(true);
    const flag = join(dir, "train.done");
    const t = orc.submit({ goal: "跑一次训练", repo, preset: loopPreset, chatId: "oc_test", criteria: ["训练跑完"] });
    const id = t.id;
    W.registerWatchHost("bot", {
      card: async () => {},
      fire: async (w, r) => { const m = w.sessionKey.match(/^orc-loop:(\d+)$/); if (m) orc.loop.onWatchFired(Number(m[1]), w, r); },
    });
    exec.worker.set(id, (req) => {
      writeFileSync(join(req.cwd, "train.sh"), "sleep 1\n");
      return J({ status: "done", summary: "已后台启动", job: { pid: 4242, log: "out/train.log" } });
    });
    exec.sup.set(id, [
      S({ action: "instruct", text: "后台启动训练，报告 pid 和日志" }),
      S({ action: "wait", watch: { title: "训练", file: flag, every: "1m" }, heartbeat: "1m", reason: "等训练结束" }),
    ]);
    await drive(() => store.getTask(id)!.status === "waiting");
    let l = orc.loop.ledger(id)!;
    const wid = l.waitWatch!;
    check("C parked on watch", store.getTask(id)!.status === "waiting" && !!wid && watches.includes(wid) && W.getWatch(wid)?.sessionKey === `orc-loop:${id}`);
    check("C worker reported job", l.observations.some((o) => /后台作业：.*4242/.test(o.text)));
    check("C heartbeat ≥ 10min", l.heartbeatS === 600 && store.pendingLoopEffects(id).some((e) => e.payload.reason === "heartbeat" && e.nextAt > Date.now() + 500_000));
    const before = exec.of(id, "supervisor").length;
    for (let i = 0; i < 20; i++) { await orc.tick(); await sleep(10); }
    check("C no rounds while waiting", exec.of(id, "supervisor").length === before);

    exec.sup.get(id)!.push(
      (req) => { check("C mid-wait round sees the wait + message", /看看显存/.test(req.prompt) && /监控 #\d+ 训练/.test(req.prompt)); return S({ action: "wait", keep: true }); },
      (req) => { check("C watch round sees fired evidence", /监控 #\d+「训练」触发/.test(req.prompt)); return S({ action: "finish", summary: "训练跑完", acceptance: [{ criterion: "C1", evidence: "E1" }] }); },
    );
    orc.attach(id, "顺便看看显存");
    await drive(() => exec.of(id, "supervisor").length === before + 1 && store.getTask(id)!.status === "waiting");
    l = orc.loop.ledger(id)!;
    check("C keep waiting keeps the watch", l.waitWatch === wid && W.getWatch(wid)?.status === "active");

    writeFileSync(flag, "ok");
    await W.tickWatches(Date.now() + 10 * 86_400_000, wid);
    await drive(() => store.getTask(id)!.status === "ready");
    l = orc.loop.ledger(id)!;
    check("C fired watch → ready", store.getTask(id)!.status === "ready" && l.evidence[0]?.kind === "watch" && l.evidence[0].pass, { st: store.getTask(id)!.status, ev: l.evidence });
    check("C watch closed", l.waitWatch === undefined && W.getWatch(wid)?.status !== "active");
    check("C wait turn posted", notes.some((n) => n.kind === "turn" && /⏳ 监控 #/.test(n.text)));
    done();
  }

  // D: the same failure over and over → hint at 3, ask at 5; quiet verbosity posts no turns; "stop" drops it
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "让测试通过", repo, preset: loopPreset, criteria: ["exit 0"] });
    const id = t.id;
    orc.loop.setVerbosity(id, "quiet");
    exec.sup.set(id, Array.from({ length: 5 }, () => S({ action: "verify", checks: [{ cmd: "echo 'boom at 12'; exit 3" }] })));
    await drive(() => store.getTask(id)!.status === "blocked");
    const l = orc.loop.ledger(id)!;
    check("D repeated error → ask", l.pendingAsk?.code === "errors" && !!l.pendingAsk.timeoutAt, l.pendingAsk);
    check("D hint at 3rd repeat", l.observations.some((o) => /同一个失败已经出现 3 次/.test(o.text)));
    check("D quiet: no turns, ask still posted", !notes.some((n) => n.kind === "turn") && notes.some((n) => n.kind === "ask"));
    check("D ask_timeout scheduled", store.pendingLoopEffects(id).some((e) => e.payload.reason === "ask_timeout"));
    check("D answer stop → dropped", /停下/.test(orc.loop.answer(id, "stop")) && store.getTask(id)!.status === "dropped");
    done();
  }

  // E: crash mid-round → re-run with recover flag; supervisor told to verify before repeating
  {
    const { repo, store, exec, orc, drive, done } = setup();
    const t = orc.submit({ goal: "x", repo, preset: loopPreset, criteria: ["c"] });
    const eff = store.pendingLoopEffects(t.id)[0];
    store.markEffect(eff.id, "running");
    store.recover();
    const re = store.pendingLoopEffects(t.id)[0];
    check("E loop effect re-queued with recover", re?.status === "pending" && re.payload.recover === true, re);
    exec.sup.set(t.id, [(req) => { check("E recover note in prompt", /进程重启/.test(req.prompt)); return S({ action: "abort", reason: "测试", tried: ["t"], blockers: ["b"], unmet: ["C1"] }); }]);
    await drive(() => store.getTask(t.id)!.status === "failed");
    check("E settled", store.getTask(t.id)!.status === "failed");
    done();
  }

  // F: invalid proposals 3× → ask; human "continue" resets the guard
  {
    const { repo, store, exec, orc, drive, done } = setup();
    const t = orc.submit({ goal: "x", repo, preset: loopPreset, criteria: ["c"] });
    exec.sup.set(t.id, ["不知道", S({ action: "dance" }), S({ action: "finish", summary: "s", acceptance: [] })]);
    await drive(() => store.getTask(t.id)!.status === "blocked");
    const l = orc.loop.ledger(t.id)!;
    check("F invalid ×3 → ask", l.pendingAsk?.code === "invalid" && store.listSteps(t.id).every((s: any) => !s.accepted));
    exec.sup.get(t.id)!.push(S({ action: "abort", reason: "r", tried: ["t"], blockers: ["b"], unmet: ["C1"] }));
    orc.loop.answer(t.id, "continue", "换个思路");
    check("F continue resets guard", orc.loop.ledger(t.id)!.guard.invalidStreak === 0 && store.getTask(t.id)!.status === "running");
    await drive(() => store.getTask(t.id)!.status === "failed");
    check("F then proceeds", store.getTask(t.id)!.status === "failed");
    done();
  }
}

e2e()
  .catch((e) => { failed++; console.log("FAIL e2e crashed", e); })
  .finally(() => { rmSync(root, { recursive: true, force: true }); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); });
