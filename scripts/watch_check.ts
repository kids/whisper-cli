// Offline checks for src/watch.ts (real processes / files in a temp dir).
//   npx tsx scripts/watch_check.ts
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "watch-check-"));
process.env.WATCHES_PATH = join(dir, "watches.json");
const W = await import("../src/watch");

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + (typeof detail === "string" ? detail : JSON.stringify(detail)) : ""}`);
  if (!ok) failed++;
};
const throws = (f: () => unknown, re: RegExp) => { try { f(); return false; } catch (e) { return re.test((e as Error).message); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mk = (spec: any, chatId = "oc_w") => W.addWatch({ chatId, bot: "bot", sessionKey: chatId, cwd: dir, spec: W.parseWatchSpec(spec, dir) });

// --- spec parsing ---
check("duration units", W.parseDuration("30s") === 30 && W.parseDuration("10m") === 600 && W.parseDuration("2h") === 7200 && W.parseDuration("1.5d") === 129600 && W.parseDuration(45) === 45);
check("bad duration", throws(() => W.parseDuration("soon"), /bad duration/));
const sp = W.parseWatchSpec({ title: "t", log: "out/train.log", done: "finished", wake_on: "Traceback", every: "5s", timeout: "30d", on_wake: "eval" }, dir);
check("relative log resolved to cwd", sp.log === join(dir, "out/train.log"));
check("every clamped to min", sp.everyS === W.MIN_EVERY_S);
check("timeout clamped to max", sp.timeoutS === W.MAX_TIMEOUT_S);
check("wake_on string → array; on_wake kept", sp.wakeOn?.[0] === "Traceback" && sp.onWake === "eval");
check("defaults every 10m / timeout 2d", (() => { const s = W.parseWatchSpec({ pid: 999999 }, dir); return s.everyS === 600 && s.timeoutS === 172800 && s.title === "pid 999999"; })());
check("nothing to watch rejected", throws(() => W.parseWatchSpec({ title: "x" }, dir), /nothing to watch/));
check("done without log rejected", throws(() => W.parseWatchSpec({ pid: 5, done: "x" }, dir), /need a log/));
check("bad regex rejected", throws(() => W.parseWatchSpec({ log: "a", wake_on: ["("] }, dir), /invalid regex/));
check("bad pid rejected", throws(() => W.parseWatchSpec({ pid: "abc" }, dir), /pid/));
check("bad metric cond rejected", throws(() => W.parseWatchSpec({ metrics: { path: "m.jsonl", stop: "loss is low" } }, dir), /metrics.stop/));

// --- protocol extraction ---
const reply = '已在后台启动训练。\n\n`[[watch]] {"title":"训练","pid":123,"log":"out/a.log"}`\n[[watch]] {bad json}\n[[unwatch]] #4, 5\n';
const ops = W.extractWatchOps(reply);
check("extract watch json", ops.add[0]?.raw?.pid === 123 && ops.add[0]?.raw?.title === "训练");
check("bad json reported, not thrown", !!ops.add[1]?.error);
check("extract unwatch ids", JSON.stringify(ops.remove) === "[4,5]");
check("protocol lines stripped", ops.text === "已在后台启动训练。", ops.text);
check("inline mention ignored", W.extractWatchOps("用 [[watch]] {..} 登记").add.length === 0);
check("command kinds", W.watchCommandKind("/watch")?.kind === "list" && W.watchCommandKind("/watch stop 3,4")?.ids.join() === "3,4" && W.watchCommandKind("/监控 check #2")?.kind === "check" && W.watchCommandKind("/watch foo")?.kind === "usage" && W.watchCommandKind("/watcher") === undefined);

// --- process probe ---
const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
child.unref();
const wp = mk({ title: "proc", pid: child.pid });
check("pidStart captured", !!wp.pidStart);
let r = await W.checkWatch(wp);
check("alive process: no fire", !r.fire && /运行中/.test(r.summary), r.summary);
check("pid reuse guard", !W.pidAlive(child.pid!, "not-the-same-start"));
process.kill(child.pid!, "SIGKILL");
await sleep(200);
r = await W.checkWatch(wp);
check("exited process fires", r.fire?.kind === "exited", r.fire);

// --- log probe ---
const log = join(dir, "train.log");
writeFileSync(log, "epoch 1 loss 2.0\nepoch 2 loss 1.5\n");
const wl = mk({ title: "log", log, done: "Training finished", wake_on: ["Traceback", "CUDA out of memory"], every: "1m" });
check("fresh log scanned from 0", wl.logOffset === 0);
r = await W.checkWatch(wl);
check("no marker: no fire, last line shown", !r.fire && r.summary.includes("epoch 2 loss 1.5"), r.summary);
W.updateWatch(wl.id, { logOffset: r.logOffset });
appendFileSync(log, "step 30 [=====>   ] 30%\rstep 60 [========>] 60%\npartial line without newl");
r = await W.checkWatch(W.getWatch(wl.id)!);
const pb = join(dir, "pb.log");
writeFileSync(pb, "step 30 [===>  ] 30%\rstep 60 [=====>] 60%\n");
check("progress-bar \\r keeps last frame", W.tailLines(pb, 1)[0] === "step 60 [=====>] 60%", W.tailLines(pb, 1));
check("partial last line not consumed", r.logOffset < readFileSync(log).length);
W.updateWatch(wl.id, { logOffset: r.logOffset });
appendFileSync(log, "ine\nTraining finished in 3h\n");
r = await W.checkWatch(W.getWatch(wl.id)!);
check("done marker fires", r.fire?.kind === "done" && /Training finished/.test(r.fire.reason), r.fire);
check("evidence has log tail", r.evidence.includes("Training finished in 3h"));
W.updateWatch(wl.id, { logOffset: r.logOffset });
r = await W.checkWatch(W.getWatch(wl.id)!);
check("old content not rescanned", !r.fire);
appendFileSync(log, "Traceback (most recent call last):\n  RuntimeError: CUDA out of memory\n");
r = await W.checkWatch(W.getWatch(wl.id)!);
check("wake_on fires as error", r.fire?.kind === "error" && /Traceback/.test(r.fire.reason), r.fire);
writeFileSync(log, "restarted\n");
r = await W.checkWatch({ ...W.getWatch(wl.id)!, logOffset: 10_000 });
check("truncated log rescanned", r.logOffset === "restarted\n".length && !r.fire);
const old = join(dir, "old.log");
writeFileSync(old, "Traceback from last week\n");
utimesSync(old, new Date(Date.now() - 3600e3), new Date(Date.now() - 3600e3));
const wo = mk({ log: old, wake_on: ["Traceback"], stale: "2h" });
check("old log: start at end", wo.logOffset === readFileSync(old).length);
r = await W.checkWatch(wo);
check("old content ignored", !r.fire, r.fire);
const ws = mk({ log: old, stale: "30m" });
r = await W.checkWatch(ws);
check("stale log fires", r.fire?.kind === "stale", r.fire);
const wm = mk({ log: join(dir, "missing.log"), done: "x" });
r = await W.checkWatch(wm);
check("missing log: no fire", !r.fire && /尚未生成/.test(r.summary));

// --- metrics ---
const mj = join(dir, "m.jsonl");
writeFileSync(mj, '{"step":100,"loss":1.83,"lr":0.0003}\n{"step":200,"loss":0.92,"lr":0.0003}\n');
const wmj = mk({ metrics: { path: mj, show: ["step", "loss"], stop: "loss<0.5" } });
r = await W.checkWatch(wmj);
check("jsonl shown fields", r.summary === "step 200 · loss 0.92" && !r.fire, r.summary);
appendFileSync(mj, '{"step":300,"loss":0.41}\n');
r = await W.checkWatch(wmj);
check("metrics stop cond fires", r.fire?.kind === "metrics", r.fire);
appendFileSync(mj, '{"step":400,"loss":"NaN"}\n');
r = await W.checkWatch(wmj);
check("NaN metric fires as error", r.fire?.kind === "error" && /loss/.test(r.fire.reason), r.fire);
const mc = join(dir, "m.csv");
writeFileSync(mc, "step,loss,acc\n10,2.5,0.1\n20,2.1,0.3\n");
r = await W.checkWatch(mk({ metrics: { path: mc, stop: "acc>=0.3" } }));
check("csv metrics + cond", r.summary.includes("acc 0.3") && r.fire?.kind === "metrics", [r.summary, r.fire]);
check("evalCond", W.evalCond("step>=50000", { step: 50000 }) === true && W.evalCond("loss<1", { loss: "x" }) === undefined && W.evalCond("loss<1", {}) === undefined);

// --- file / cmd / timeout ---
for (const w of W.listWatches({ chatId: "oc_w", status: ["active"] })) W.cancelWatch(w.id);
const ck = join(dir, "ckpt.pt");
const wf = mk({ file: ck });
check("file absent: no fire", !(await W.checkWatch(wf)).fire);
writeFileSync(ck, "x");
check("file appears: fire", (await W.checkWatch(wf)).fire?.kind === "file");
check("cmd exit 1: no fire", !(await W.checkWatch(mk({ cmd: "exit 1" }))).fire);
const rc = await W.checkWatch(mk({ cmd: "echo job DONE; exit 0" }));
check("cmd exit 0: fire with output", rc.fire?.kind === "cmd" && /job DONE/.test(rc.fire.reason), rc.fire);
const wt = mk({ cmd: "exit 1", timeout: "1m" });
check("timeout → expired fire", (await W.checkWatch(wt, Date.now() + 120_000)).fire?.kind === "timeout");

// --- manager ---
const fired: number[] = [], cards: number[] = [];
W.registerWatchHost("bot", { card: async (w) => { cards.push(w.id); }, fire: async (w) => { fired.push(w.id); } });
for (const w of W.listWatches({ status: ["active"] })) W.cancelWatch(w.id);
const done = join(dir, "done.flag");
const wa = mk({ title: "mgr", file: done, every: "1m" });
const wb = W.addWatch({ chatId: "oc_other", bot: "absent-bot", sessionKey: "oc_other", cwd: dir, spec: W.parseWatchSpec({ file: done }, dir) });
check("first check within a minute", wa.nextAt - wa.createdAt <= 60_000);
check("not due yet → nothing", (await W.tickWatches(Date.now())) === 0);
let n = await W.tickWatches(Date.now() + 61_000);
check("due → probed, card updated, not fired", n === 1 && cards.includes(wa.id) && !fired.length && W.getWatch(wa.id)!.checks === 1);
check("next check scheduled by every", W.getWatch(wa.id)!.nextAt >= Date.now() + 60_000);
writeFileSync(done, "1");
n = await W.tickWatches(Date.now() + 200_000);
check("condition → fired once", fired.join() === String(wa.id) && W.getWatch(wa.id)!.status === "fired" && !!W.getWatch(wa.id)!.fired);
await W.tickWatches(Date.now() + 400_000);
check("fired watch not probed again", fired.length === 1);
check("watch of an absent bot is left alone", W.getWatch(wb.id)!.status === "active" && W.getWatch(wb.id)!.checks === 0);
const persisted = JSON.parse(readFileSync(process.env.WATCHES_PATH!, "utf8"));
check("persisted with status/nextAt", persisted.watches.find((w: any) => w.id === wa.id)?.status === "fired" && typeof persisted.watches[0].nextAt === "number");
check("cancel only own chat", !W.cancelWatch(wb.id, "oc_w") && W.cancelWatch(wb.id, "oc_other"));
for (let i = 0; i < W.MAX_ACTIVE_PER_CHAT; i++) mk({ cmd: "exit 1" }, "oc_cap");
check("per-chat cap", throws(() => mk({ cmd: "exit 1" }, "oc_cap"), /上限/));

// --- rendering ---
const card = W.renderWatchCard(W.getWatch(wa.id)!);
check("card shows fired reason", card.includes("🔔") && card.includes("产物已出现"), card);
const ctx = W.formatWatchContext("oc_cap");
check("context: protocol + active list", ctx.includes("[[watch]]") && ctx.includes("setsid") && ctx.includes("本群进行中的监控"));
const wake = W.buildWakePrompt({ ...W.getWatch(wa.id)!, spec: { ...W.getWatch(wa.id)!.spec, onWake: "跑 eval" } }, { fire: { kind: "file", reason: "产物已出现" }, summary: "", evidence: "日志末尾：ok", logOffset: 0 });
check("wake prompt has reason, evidence, on_wake", wake.includes("产物已出现") && wake.includes("日志末尾：ok") && wake.includes("跑 eval"));
check("active card tells how to stop in words", W.renderWatchCard({ ...W.getWatch(wa.id)!, status: "active" }).includes("停掉监控 #") && !W.renderWatchCard({ ...W.getWatch(wa.id)!, status: "active" }).includes("/watch"));

// --- natural-language stop ---
const intents: [string, { ids: number[]; all: boolean } | undefined][] = [
  ["停掉监控", { ids: [], all: false }],
  ["别盯了", { ids: [], all: false }],
  ["不用再盯了", { ids: [], all: false }],
  ["取消 #3 监控", { ids: [3], all: false }],
  ["停掉监控 #3 #5", { ids: [3, 5], all: false }],
  ["把 2 号监控关掉", { ids: [2], all: false }],
  ["监控都停了吧", { ids: [], all: true }],
  ["所有监控全部取消", { ids: [], all: true }],
  ["把训练那个监控撤了", { ids: [], all: false }],
  ["监控停了吗", undefined],
  ["为什么监控停了", undefined],
  ["别停监控", undefined],
  ["继续盯着", undefined],
  ["帮我盯着训练", undefined],
  ["别忘了监控显存", undefined],
  ["关于监控的实现原理讲一下", undefined],
  ["停掉监控然后把进程也 kill 掉", undefined],
  ["/watch stop 3", undefined],
  ["训练跑完之后请帮我把这几个监控统一停掉并且汇总一下所有实验的结果", undefined],
];
for (const [s, want] of intents) {
  const got = W.parseStopWatchIntent(s);
  check(`stop intent「${s}」`, JSON.stringify(got) === JSON.stringify(want), { got, want });
}
const fakeW = (id: number, title: string, sessionKey = "oc_s") => ({ id, chatId: "oc_s", bot: "b", sessionKey, cwd: dir, spec: { title }, status: "active" } as any);
const one = [fakeW(1, "训练 a.yaml")];
const two = [fakeW(1, "训练 a.yaml"), fakeW(2, "eval 批处理")];
const withLoop = [fakeW(1, "训练 a.yaml"), fakeW(7, "loop 实验", "orc-loop:12")];
const plan = (s: string, ws: any[]) => W.planStopWatches(s, W.parseStopWatchIntent(s)!, ws);
const ids = (ws: any[]) => ws.map((w) => w.id).join(",");
check("only one watch → stop it", ids(plan("停掉监控", one).stop) === "1");
check("two watches, no hint → ask", ids(plan("停掉监控", two).ambiguous) === "1,2" && !plan("停掉监控", two).stop.length);
check("title words pick one", ids(plan("把训练那个监控停了", two).stop) === "1");
check("latin title word picks one", ids(plan("eval 的监控关掉", two).stop) === "2");
check("all → every own watch", ids(plan("监控全停了", two).stop) === "1,2");
check("explicit id; unknown id reported", ids(plan("停掉监控 #2 #9", two).stop) === "2" && plan("停掉监控 #2 #9", two).missing.join() === "9");
check("loop-owned watch is not stopped", ids(plan("停掉监控 #7", withLoop).loopOwned) === "7" && !plan("停掉监控 #7", withLoop).stop.length);
check("all skips loop-owned", ids(plan("所有监控都停了", withLoop).stop) === "1");
check("only loop-owned left → explain", ids(plan("停掉监控", [withLoop[1]]).loopOwned) === "7");
check("loopTaskOf", W.loopTaskOf(withLoop[1]) === 12 && W.loopTaskOf(withLoop[0]) === undefined);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
