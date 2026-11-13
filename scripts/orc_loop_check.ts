// Offline checks for the supervisor loop (src/orc/ledger.ts + loop.ts), no LLM.
// 协议：监督者写正文 + 至多一行 [[标记]]；没有标记 = 继续，代码不校验、不驳回、不因此问人。
//   npx tsx scripts/orc_loop_check.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "orc-loop-check-"));
process.env.WATCHES_PATH = join(root, "watches.json");
process.env.ORC_LOOP_RETRY_MS = "10"; // 运行故障的退避，别让检查等 30 秒
const W = await import("../src/watch");
const L = await import("../src/orc/ledger");
const { loadPresets, loadRoles, resolvePreset } = await import("../src/orc/config");
const { Orchestrator } = await import("../src/orc/scheduler");
const { OrcStore } = await import("../src/orc/store");
import { classifyResult, type Executor, type RunRequest, type RunResult } from "../src/orc/runner";
import type { NotifyPayload } from "../src/orc/types";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}`, detail ?? ""); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

const roles = loadRoles();
const presets = loadPresets();
const loopPreset = resolvePreset(presets.get("loop")!, roles);
const limits = { maxSteps: 60, maxWorkerRuns: 25, maxActiveHours: 8 };
const mk = (over: Partial<Parameters<typeof L.createLedger>[0]> = {}) =>
  L.createLedger({ goal: "g", criteria: ["测试通过"], constraints: ["只用 JS"], head: "sha0", limits, verbosity: "normal", ...over });

// ---- 协议：正文 + [[标记]]，没有标记就是"还在想" -------------------------------
{
  const p = (t: string) => L.parseSignal(t);
  check("last marker wins", p('先看看。\n[[verify]]\nls -a\n\n再想想\n[[finish]]\n做完了')?.action === "finish");
  const v: any = p("[[verify]]\n- `pytest -q`\n* npm test");
  check("verify: one command per line, decoration stripped", v?.action === "verify" && v.checks.map((c: any) => c.cmd).join("|") === "pytest -q|npm test", v);
  const i: any = p("[[instruct]]\n把 X 改成 Y\n再跑一遍测试");
  check("instruct body keeps multiple lines", i?.action === "instruct" && i.text === "把 X 改成 Y\n再跑一遍测试", i);
  const w: any = p("[[wait]]\npid=123\nlog=out/train.log\ndone=训练完成\nstale=30m\nevery=5m");
  check("wait key=value", w?.action === "wait" && w.watch.pid === 123 && w.watch.log === "out/train.log" && w.watch.done === "训练完成" && w.watch.stale === "30m", w);
  check("wait keep", (p("[[wait]]\nkeep=1\nreason=loss 在降") as any)?.keep === true);
  const a: any = p("[[ask]]\nwhy=irreversible\n要推 main 吗？");
  check("ask why + question", a?.action === "ask" && a.why === "irreversible" && a.question === "要推 main 吗？", a);
  const r: any = p("人要求改成内部参考。\n[[replan]]\nreason: 对外发布改成内部参考\ncriteria:\n- 报告内部可读，数字可复算\n- 不引用未验证数字\nconstraints:\n- 只做离线分析\ninvalidate: E1,E3\nreset_worker: no");
  check("replan: reason / criteria / constraints / invalidate", r?.action === "replan" && r.change.reason === "对外发布改成内部参考" && r.change.criteria.length === 2 && r.change.constraints[0] === "只做离线分析" && r.change.invalidate.join() === "E1,E3" && r.change.resetWorker === false, r);
  check("replan without fields is still a change", (() => { const x: any = p("[[replan]]\n以后先看日志"); return x?.action === "replan" && x.change.reason === "以后先看日志" && !x.change.criteria && x.change.resetWorker === true; })());
  check("no marker → undefined (继续，不是错误)", p("我觉得应该先看日志，然后再决定。") === undefined);
  check("empty marker body → undefined", p("[[instruct]]\n") === undefined);
  check("unknown marker ignored", p("[[dance]]\n跳个舞") === undefined);
  check("budget ask is the only code-raised question", L.budgetAsk(mk(), "轮数 60/60").code === "budget");
}

// ---- 不可逆操作：唯一保留的"看内容"规则 ---------------------------------------
{
  check("irreversible: git push", L.irreversibleHit("改完后 git push origin main") === "git push");
  check("irreversible: negated", L.irreversibleHit("改完提交即可，不要 git push") === undefined);
  check("irreversible: deploy", L.irreversibleHit("部署到生产环境") !== undefined);
  check("irreversible: drop table", L.irreversibleHit("DROP TABLE users") !== undefined);
  check("irreversible: plain work", L.irreversibleHit("跑一下单测，修掉失败的用例") === undefined);
  check("budget: exhausted line", L.budgetState(mk({ limits: { maxSteps: 1, maxWorkerRuns: 1, maxActiveHours: 1 } })).exhausted === undefined);
}

// ---- engine end-to-end (scripted CLIs) -----------------------------------------
type Reply = string | ((req: RunRequest) => string | Promise<string>);
interface Call { taskId: number; role: string; req: RunRequest }

/** 把一个动作对象写成正文 + 标记（测试里只关心内容） */
const S = (o: any): string => {
  const body = (t: unknown) => `[[${o.action}]]\n${t ?? ""}`.trimEnd();
  switch (o.action) {
    case "instruct": return `我看了一下现状。\n\n${body(o.text)}`;
    case "verify": return `先取证。\n\n${body((o.checks ?? []).map((c: any) => (typeof c === "string" ? c : c.cmd)).join("\n"))}`;
    case "review": return body(o.focus ?? "");
    case "wait": {
      const kv: string[] = [];
      for (const [k, v] of Object.entries(o.watch ?? {})) if (v != null && typeof v !== "object") kv.push(`${k}=${v}`);
      if (o.reason) kv.push(`reason=${o.reason}`);
      if (o.heartbeat) kv.push(`heartbeat=${o.heartbeat}`);
      if (o.keep) kv.push("keep=1");
      return `挂起等作业。\n\n${body(kv.join("\n"))}`;
    }
    case "replan": {
      const c = o.change ?? {};
      const kv = [`reason: ${c.reason ?? ""}`];
      if (c.criteria?.length) kv.push("criteria:", ...c.criteria.map((x: string) => `- ${x}`));
      if (c.constraints?.length) kv.push("constraints:", ...c.constraints.map((x: string) => `- ${x}`));
      if (c.invalidate?.length) kv.push(`invalidate: ${c.invalidate.join(",")}`);
      if (c.resetWorker === false) kv.push("reset_worker: no");
      return `人改了口径，我重新安排。\n\n${body(kv.join("\n"))}`;
    }
    case "ask": return body([o.why ? `why=${o.why}` : "", o.question].filter(Boolean).join("\n"));
    case "finish": return `收尾。\n\n${body(o.summary)}`;
    case "abort": return body(o.reason);
    default: return `我不知道该干嘛。`;
  }
};

class LoopFake implements Executor {
  calls: Call[] = [];
  sup = new Map<number, Reply[]>();
  worker = new Map<number, ((req: RunRequest, n: number) => string | Promise<string>)>();
  review: Reply = "[[approve]] 看过了，没问题";
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
    let sessionId = req.resumeSessionId ?? `s-${role}-${this.calls.length}`;
    if (role === "supervisor") {
      const q = this.sup.get(taskId) ?? [];
      const r = q.shift();
      if (r === undefined) throw new Error(`supervisor script for #${taskId} exhausted`);
      text = typeof r === "function" ? await r(req) : r;
    } else if (role === "worker") {
      const n = this.calls.filter((c) => c.taskId === taskId && c.role === "worker").length;
      text = await this.worker.get(taskId)!(req, n);
    } else {
      text = typeof this.review === "function" ? await this.review(req) : this.review;
    }
    // 和真实执行器一样按文本分类（⚠️ 运行失败 / ⏱️ 超时），故障路径也被检查到
    return { text, sessionId, tokens: 10, timedOut: false, cancelled: false, ...classifyResult(text) };
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
  const drive = async (until: () => boolean, ms = 20_000) => {
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

const asks = (notes: NotifyPayload[]) => notes.filter((n) => n.kind === "ask" || n.kind === "decision");

async function e2e() {
  // A: instruct → verify（失败）→ 修 → verify（通过）→ finish；监督者续接同一个会话
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "实现 add(a,b)", repo, preset: loopPreset, criteria: ["add(2,3) 等于 5"], sourceText: "帮我写个 add" });
    const id = t.id;
    const testCmd = `node -e "process.exit(require('./add.js')(2,3)===5?0:1)"`;
    exec.worker.set(id, (req, n) => {
      writeFileSync(join(req.cwd, "add.js"), n === 1 ? "module.exports=(a,b)=>a-b\n" : "module.exports=(a,b)=>a+b\n");
      return `[[done]] ${n === 1 ? "写好了 add.js" : "修好了符号"}`;
    });
    exec.sup.set(id, [
      S({ action: "instruct", text: "新建 add.js，导出 add(a,b)" }),
      S({ action: "verify", checks: [{ cmd: testCmd }] }),
      S({ action: "instruct", text: "add 返回的是 a-b，改成 a+b" }),
      S({ action: "verify", checks: [{ cmd: testCmd }] }),
      S({ action: "finish", summary: "add 实现并通过冒烟" }),
    ]);
    const ok = await drive(() => store.getTask(id)!.status === "ready");
    const task = store.getTask(id)!;
    const l = orc.loop.ledger(id)!;
    const steps = store.listSteps(id);
    const sups = exec.of(id, "supervisor");
    check("A ready", ok && task.status === "ready", { status: task.status, progress: task.progress, obs: l.observations.slice(-3) });
    check("A 5 rounds, all executed", steps.length === 5 && steps.every((s: any) => s.action), steps.map((s: any) => s.action?.action));
    check("A no question was asked", asks(notes).length === 0, notes.map((n) => n.kind));
    check("A supervisor keeps one session", sups[0].req.resumeSessionId === undefined && sups.slice(1).every((c) => c.req.resumeSessionId === "s-supervisor-1"), sups.map((c) => c.req.resumeSessionId));
    check("A resumed rounds get the short delta prompt", sups[1].req.prompt.length < sups[0].req.prompt.length / 2 && /自上一轮以来/.test(sups[1].req.prompt), [sups[0].req.prompt.length, sups[1].req.prompt.length]);
    check("A supervisor is read-only", sups.every((c) => c.req.readOnly));
    check("A worker resumes its session", exec.of(id, "worker").every((c, i) => i === 0 ? !c.req.resumeSessionId : !!c.req.resumeSessionId));
    check("A evidence recorded for both runs", l.evidence.map((e) => `${e.pass ? "+" : "-"}`).join("") === "-+", l.evidence.map((e) => [e.label, e.pass, e.sha]));
    const ready = notes.find((n) => n.kind === "ready");
    check("A finish lists criteria + evidence", /add\(2,3\) 等于 5/.test(ready?.text ?? "") && /最近的验证/.test(ready?.text ?? ""), ready?.text);
    done();
  }

  // B: 人中途插话 / 不可逆操作先被挡住、回答后放行一次 / abort
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "改个函数名", repo, preset: loopPreset, criteria: ["测试通过"], sourceText: "顺便把函数名改成 plusTwo" });
    const id = t.id;
    exec.worker.set(id, () => "[[done]] 改好了");
    exec.sup.set(id, [
      () => { orc.attach(id, "函数名以后改成 plusTwo", false, "顺便把函数名改成 plusTwo 吧"); return S({ action: "instruct", text: "把 add 改名成 plusTwo" }); },
      S({ action: "instruct", text: "改完直接 git push origin main" }),
      S({ action: "instruct", text: "改完直接 git push origin main" }),
      S({ action: "abort", reason: "推不上去，远端拒绝" }),
    ]);
    await drive(() => store.getTask(id)!.status === "blocked");
    const blocked = store.getTask(id)!;
    check("B irreversible instruct asks instead of running", blocked.status === "blocked" && /git push/.test(blocked.progress), blocked.progress);
    check("B question is a plain sentence", /要做吗/.test(asks(notes)[0]?.text ?? "") && !/选项/.test(asks(notes)[0]?.text ?? ""), asks(notes)[0]?.text);
    check("B worker did not run the push turn", exec.of(id, "worker").length === 1);
    orc.loop.answer(id, undefined, "可以推，只推一次");
    const l = orc.loop.ledger(id)!;
    check("B human words are in the ledger", l.observations.some((o) => /可以推，只推一次/.test(o.text)));
    check("B answer records one approval", l.approvals.length === 1);
    await drive(() => store.getTask(id)!.status === "failed");
    check("B second push passes on the approval (single use), then abort stops", exec.of(id, "worker").length === 2 && store.getTask(id)!.status === "failed");
    check("B abort is reported as a fault, not a question", notes.some((n) => n.kind === "failed") && asks(notes).length === 1, notes.map((n) => n.kind));
    done();
  }

  // C: 长作业 — worker 后台跑，监督者挂监控；等待期间不跑轮次；人插话会唤醒；keep=1 继续等
  {
    const { dir, repo, store, exec, notes, orc, drive, watches, done } = setup(true);
    const t = orc.submit({ goal: "等训练跑完", repo, preset: loopPreset, chatId: "oc_test", criteria: ["训练跑完"] });
    const id = t.id;
    const flag = join(dir, "train.done");
    W.registerWatchHost("bot", {
      card: async () => {},
      fire: async (w, r) => { const m = w.sessionKey.match(/^orc-loop:(\d+)$/); if (m) orc.loop.onWatchFired(Number(m[1]), w, r); },
    });
    exec.worker.set(id, (req) => {
      writeFileSync(join(req.cwd, "train.log"), "step 1\nstep 2\n");
      return "[[done]] 已在后台启动，pid 4242，日志 out/train.log";
    });
    exec.sup.set(id, [
      S({ action: "instruct", text: "后台跑训练，报 pid 和日志" }),
      S({ action: "wait", watch: { title: "训练", file: flag, every: "1m" }, reason: "等训练" }),
    ]);
    await drive(() => store.getTask(id)!.status === "waiting");
    let l = orc.loop.ledger(id)!;
    const wid = l.waitWatch!;
    check("C parked on watch", store.getTask(id)!.status === "waiting" && !!wid && watches.includes(wid) && W.getWatch(wid)?.sessionKey === `orc-loop:${id}`);
    check("C patrol heartbeat on by default (30m)", l.heartbeatS === 1800 && store.pendingLoopEffects(id).some((e) => e.payload.reason === "heartbeat"));
    const before = exec.of(id, "supervisor").length;
    for (let i = 0; i < 20; i++) { await orc.tick(); await sleep(10); }
    check("C no rounds while waiting", exec.of(id, "supervisor").length === before);

    exec.sup.get(id)!.push(
      (req) => { check("C mid-wait round sees the wait + the message", /看看显存/.test(req.prompt) && /正在等待/.test(req.prompt), req.prompt.slice(0, 400)); return S({ action: "wait", keep: true, reason: "loss 在降" }); },
      () => S({ action: "finish", summary: "训练跑完" }),
    );
    const stepsBefore = orc.loop.ledger(id)!.budget.steps;
    orc.attach(id, "顺便看看显存");
    await drive(() => exec.of(id, "supervisor").length === before + 1 && store.getTask(id)!.status === "waiting");
    l = orc.loop.ledger(id)!;
    check("C keep waiting keeps the watch", l.waitWatch === wid && W.getWatch(wid)?.status === "active");
    check("C healthy patrol uses no round budget", l.budget.steps === stepsBefore, { stepsBefore, now: l.budget.steps });

    writeFileSync(flag, "ok");
    await W.tickWatches(Date.now() + 10 * 86_400_000, wid);
    await drive(() => store.getTask(id)!.status === "ready");
    l = orc.loop.ledger(id)!;
    check("C fired watch → ready", store.getTask(id)!.status === "ready" && l.evidence.some((e) => e.kind === "watch" && e.pass), { st: store.getTask(id)!.status, ev: l.evidence });
    check("C watch closed", l.waitWatch === undefined && W.getWatch(wid)?.status !== "active");
    done();
  }

  // D: 同一个失败反复出现 —— 没人被问，监督者自己看着办（预算兜底）
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "让测试通过", repo, preset: loopPreset, criteria: ["exit 0"] });
    const id = t.id;
    orc.loop.setVerbosity(id, "quiet");
    exec.sup.set(id, [
      S({ action: "verify", checks: [{ cmd: "echo 'boom at 12'; exit 3" }] }),
      S({ action: "verify", checks: [{ cmd: "echo 'boom at 12'; exit 3" }] }),
      S({ action: "finish", summary: "认了，带着已知问题收尾" }),
    ]);
    await drive(() => store.getTask(id)!.status === "ready");
    const l = orc.loop.ledger(id)!;
    check("D repeated failure does not ask anyone", asks(notes).length === 0, notes.map((n) => n.kind));
    check("D both failures recorded as evidence", l.evidence.filter((e) => !e.pass).length === 2);
    check("D quiet verbosity posts no turns", !notes.some((n) => n.kind === "turn"), notes.map((n) => n.kind));
    check("D finish without passing evidence still completes (记录，不阻塞)", store.getTask(id)!.status === "ready");
    done();
  }

  // E: 一点动作都没有 = 继续，不问人；预算兜底
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "x", repo, preset: loopPreset, criteria: ["c"] });
    const id = t.id;
    exec.sup.set(id, ["我再想想。", "再想想。", S({ action: "abort", reason: "想不出来" })]);
    await drive(() => store.getTask(id)!.status === "failed");
    const l = orc.loop.ledger(id)!;
    const steps = store.listSteps(id);
    check("E no-action rounds are not errors", steps.slice(0, 2).every((s: any) => s.accepted && !s.action && /没有动作/.test(s.verdict)), steps.map((s: any) => s.verdict));
    check("E thoughts are kept in the ledger", l.observations.some((o) => o.kind === "thought"));
    check("E nobody was asked", asks(notes).length === 0, notes.map((n) => n.kind));
    done();
  }

  // F: 运行故障（⚠️）不算"动作无效"，退避重试，到上限判故障
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "x", repo, preset: loopPreset, criteria: ["c"] });
    const id = t.id;
    exec.sup.set(id, Array.from({ length: 5 }, () => "⚠️ CodeBuddy 这轮失败：CLI 报了错但没给原因"));
    await drive(() => store.getTask(id)!.status === "failed");
    const l = orc.loop.ledger(id)!;
    check("F 3 infra failures → failed", store.getTask(id)!.status === "failed" && l.guard.infraErrors === 3, { status: store.getTask(id)!.status, guard: l.guard });
    check("F failure is reported as a fault", notes.some((n) => n.kind === "failed") && asks(notes).length === 0, notes.map((n) => n.kind));
    done();
  }

  // G: 崩溃恢复：带 recover 重跑，监督者被告知先核实
  {
    const { repo, store, exec, orc, drive, done } = setup();
    const t = orc.submit({ goal: "x", repo, preset: loopPreset, criteria: ["c"] });
    const eff = store.pendingLoopEffects(t.id)[0];
    store.markEffect(eff.id, "running");
    store.recover();
    check("G loop effect re-queued with recover", store.pendingLoopEffects(t.id)[0]?.payload.recover === true);
    exec.sup.set(t.id, [(req) => { check("G recover note in prompt", /进程重启/.test(req.prompt)); return S({ action: "abort", reason: "测试" }); }]);
    await drive(() => store.getTask(t.id)!.status === "failed");
    check("G settled", store.getTask(t.id)!.status === "failed");
    done();
  }

  // I: 人中途改口径 → 监督者 [[replan]]：验收整体替换、证据作废、worker 换会话
  {
    const { repo, store, exec, notes, orc, drive, done } = setup();
    const t = orc.submit({ goal: "写一份可行性报告", repo, preset: loopPreset, criteria: ["给出结论"], sourceText: "对外发布用的" });
    const id = t.id;
    exec.worker.set(id, () => "[[done]] 报告写好了");
    exec.sup.set(id, [
      S({ action: "instruct", text: "先写一版报告" }),
      () => { orc.attach(id, "改成内部参考，不用对外发布，数字必须可复算", false, "改成内部参考吧，数字必须可复算"); return S({ action: "verify", checks: [{ cmd: "echo check" }] }); },
      S({ action: "replan", change: { reason: "对外发布改成内部参考", criteria: ["数字可复算", "结论只内部使用"], constraints: ["不引用未验证数字"], invalidate: ["E1"] } } as any),
      S({ action: "instruct", text: "按新口径重写结论部分" }),
      S({ action: "finish", summary: "内部版完成" }),
    ]);
    const ok = await drive(() => store.getTask(id)!.status === "ready");
    const l = orc.loop.ledger(id)!;
    check("I replan replaced criteria", ok && l.criteria.map((c) => c.text).join("|") === "数字可复算|结论只内部使用", l.criteria);
    check("I replan bumped the version", l.constraintsVersion >= 2, l.constraintsVersion);
    check("I named evidence invalidated", l.evidence.some((e) => e.invalidated), l.evidence.map((e) => [e.id, e.invalidated]));
    check("I worker restarted on a fresh session", exec.of(id, "worker").length === 2 && !exec.of(id, "worker")[1].req.resumeSessionId, exec.of(id, "worker").map((c) => c.req.resumeSessionId));
    check("I the group is told what changed", notes.some((n) => n.kind === "info" && /按新的安排继续/.test(n.text) && /验收标准改为 2 条/.test(n.text)), notes.filter((n) => n.kind === "info").map((n) => n.text));
    check("I nobody was asked to decide", asks(notes).length === 0, notes.map((n) => n.kind));
    done();
  }

  // H: 旧版把"没给出动作"挂成待答问题 → 启动时自动放行
  {
    const { repo, store, exec, orc, drive, done } = setup();
    const t = orc.submit({ goal: "x", repo, preset: loopPreset, criteria: ["c"] });
    const legacy = orc.loop.ledger(t.id)!;
    legacy.pendingAsk = { step: 0, question: "监督者连续 3 次给出无效动作：回复里没有包含 \"action\" 字段的 JSON 对象", why: "high_cost", askedAt: Date.now(), code: "invalid" as any };
    store.saveLedger(t.id, legacy);
    store.updateTask(t.id, { status: "blocked" });
    check("H legacy ask released on startup", orc.loop.clearLegacyFormatAsks() === 1);
    const after = orc.loop.ledger(t.id)!;
    check("H cleared: no ask, running", !after.pendingAsk && store.getTask(t.id)!.status === "running");
    exec.sup.set(t.id, [S({ action: "abort", reason: "r" })]);
    await drive(() => store.getTask(t.id)!.status === "failed");
    check("H then continues on its own", store.listSteps(t.id).some((s: any) => s.accepted));
    done();
  }
}

e2e()
  .catch((e) => { failed++; console.log("FAIL e2e crashed", e); })
  .finally(() => { rmSync(root, { recursive: true, force: true }); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); });
