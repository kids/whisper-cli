// Offline check for per-agent thread cards (src/orc/agent-cards.ts) + platform hooks.
//   npx tsx scripts/agent_cards_check.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "agent-cards-"));
process.env.ORC_AGENT_CARD_THROTTLE_MS = "50";
const AC = await import("../src/orc/agent-cards");
const { FeishuClient } = await import("../src/platform/feishu");
const { TelegramClient } = await import("../src/platform/telegram");

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const T0 = Date.now();
const task: any = {
  id: 7, kind: "pipeline", chatId: "oc_x",
  preset: { roles: { researcher: { isolation: "worktree" }, critic: { isolation: "readonly" } }, stages: [] },
};
const att = (o: any): any => ({
  id: 1, taskId: 7, stageId: "research", role: "researcher", slot: 0, cli: "codebuddy", model: "deepseek-v4.1-flash-ioa",
  sessionKey: "k", sessionId: null, status: "running", output: "", parsed: null, error: "", progress: "", tokens: 0,
  startedAt: T0 - 8 * 60_000, endedAt: null, ...o,
});
const verdict = (pass: boolean, issues: any[], summary = "结论还站不住") => ({ kind: "verdict", pass, summary, notes: ["已确认修复：产物已提交；口径统一"], value: { verdict: pass ? "approve" : "revise", issues } });

// ---- rendering ----
const r1 = att({ id: 1 });
const c1 = AC.attemptCtx(task, [r1], r1, "/root/.orc", ["读 plan.md", "跑 feasibility.py"]);
const live = AC.renderAttemptCard(r1, { ...c1, now: T0 });
check("running card header", live.startsWith("**🔬 researcher · deepseek-v4.1-flash-ioa · 调研第 1 次 · 运行中**"), live);
check("running card shows elapsed + progress tail", live.includes("用时 8 分钟") && live.includes("> 跑 feasibility.py"), live);
check("running card has no output path yet", !live.includes("完整输出"));

const done1 = att({ id: 1, status: "done", endedAt: T0, tokens: 4_600_000, progress: "提交 e8eeeec", parsed: { kind: "report", pass: true, summary: "部分可行：增益 6.3%", notes: [], value: {} } });
const crit1 = att({ id: 2, stageId: "critique", role: "critic", model: "gpt-6.1-sol", status: "done", endedAt: T0, tokens: 2_100_000,
  parsed: verdict(false, [
    { severity: "major", file: "analysis/quantile/feasibility.py", line: 120, desc: "抽样权重没按论文加权。后面的数都受影响。" },
    { severity: "major", file: "reports/ml/19.md", line: 30, desc: "分位数与 CDF 不一致；需要重算" },
    { severity: "minor", desc: "图例不清楚" },
  ]) });
const re2 = att({ id: 3 });
const all = [done1, crit1, re2];
const dcard = AC.renderAttemptCard(done1, AC.attemptCtx(task, all, done1, "/root/.orc"));
check("writer done: ✓ 交付 + tokens + commit", dcard.includes("调研第 1 次 · ✓ 交付") && dcard.includes("4.6M tokens") && dcard.includes("提交 e8eeeec"), dcard);
check("writer done: summary + output path", dcard.includes("部分可行：增益 6.3%") && dcard.includes("~/.orc/tasks/7/1-research.output.md"), dcard);
const ccard = AC.renderAttemptCard(crit1, AC.attemptCtx(task, all, crit1, "/root/.orc"));
check("critic: ✗ 退回（2 条 major）+ 只读", ccard.includes("评审第 1 次 · ✗ 退回（2 条 major）") && ccard.includes("只读"), ccard);
check("critic: 结论 + 已确认修复", ccard.includes("**结论**：结论还站不住") && ccard.includes("**已确认修复**：产物已提交"), ccard);
check("critic: major listed by file:line, first sentence only", ccard.includes("1. `feasibility.py:120` 抽样权重没按论文加权。") && !ccard.includes("后面的数都受影响"), ccard);
check("critic: minor folded", ccard.includes("另有 1 条次要意见") && !ccard.includes("图例不清楚"), ccard);
const rcard = AC.renderAttemptCard(re2, AC.attemptCtx(task, all, re2, "/root/.orc"));
check("rework: 第 2 次 + 针对上次评审的 3 条意见", rcard.includes("调研第 2 次") && rcard.includes("根据上次评审的 3 条意见重做"), rcard);
const pass = att({ id: 4, stageId: "critique", role: "critic", model: "gpt-6.1-sol", status: "done", endedAt: T0, parsed: verdict(true, [], "可以了") });
check("critic pass", AC.renderAttemptCard(pass, AC.attemptCtx(task, [...all, pass], pass, "/root/.orc")).includes("评审第 2 次 · ✓ 通过"));
const bad = att({ id: 5, status: "done", endedAt: T0, parsed: null, output: "随便写了点东西".repeat(3) });
check("no conclusion: shows tail", AC.renderAttemptCard(bad, AC.attemptCtx(task, [bad], bad, "/root/.orc")).includes("没收尾，接着跑"));
const err = att({ id: 6, status: "failed", endedAt: T0, error: "timeout after 60m" });
check("failed: error shown", AC.renderAttemptCard(err, AC.attemptCtx(task, [err], err, "/root/.orc")).includes("❌ 出错") );
const test = att({ id: 8, stageId: "test", role: "tester", status: "done", endedAt: T0, parsed: { kind: "test", pass: false, summary: "2 个失败", notes: [], value: { pass: false, cases: [{ name: "a", result: "pass" }, { name: "b", result: "fail", detail: "期望 1 实际 2。其余略" }] } } });
const tcard = AC.renderAttemptCard(test, AC.attemptCtx(task, [test], test, "/root/.orc"));
check("test card: cases", tcard.includes("测试第 1 次 · ✗ 未通过") && tcard.includes("用例：1/2 通过") && tcard.includes("- ✗ b：期望 1 实际 2。"), tcard);
const long = att({ id: 9, status: "done", endedAt: T0, parsed: { kind: "report", pass: true, summary: "x".repeat(9000), notes: [], value: {} } });
check("card length capped", AC.renderAttemptCard(long, AC.attemptCtx(task, [long], long, "/root/.orc")).length <= 3500);

// ---- delivery ----
const calls: { op: string; id: string; text: string }[] = [];
let n = 0;
const im: any = {
  replyCardInThread: async (root: string, text: string) => { await sleep(20); calls.push({ op: "reply", id: root, text }); return `m${++n}`; },
  updateCardMessage: async (id: string, text: string) => { calls.push({ op: "update", id, text }); return true; },
};
const store = join(tmp, "agent-cards.json");
const cards = new AC.AgentCards(store);
const running = att({ id: 21, startedAt: Date.now(), progress: "读 plan.md" });
await Promise.all([cards.syncAttempts(im, "root", task, [running], "/root/.orc"), cards.syncAttempts(im, "root", task, [running], "/root/.orc")]);
check("concurrent syncs create one card", calls.filter((c) => c.op === "reply").length === 1 && calls[0].id === "root", calls);
await cards.syncAttempts(im, "root", task, [{ ...running, progress: "跑脚本" }], "/root/.orc");
check("update within throttle skipped", calls.filter((c) => c.op === "update").length === 0);
await sleep(70);
await cards.syncAttempts(im, "root", task, [{ ...running, progress: "跑脚本" }], "/root/.orc");
check("update after throttle, with progress tail", calls.at(-1)?.op === "update" && calls.at(-1)!.text.includes("> 读 plan.md") && calls.at(-1)!.text.includes("> 跑脚本"), calls.at(-1));
const fin = { ...running, status: "done", endedAt: Date.now(), parsed: { kind: "report", pass: true, summary: "完成了", notes: [], value: {} } };
await cards.syncAttempts(im, "root", task, [fin], "/root/.orc");
check("final update bypasses throttle", calls.at(-1)?.op === "update" && calls.at(-1)!.text.includes("✓ 交付") && calls.at(-1)!.id === "m1");
const before = calls.length;
await cards.syncAttempts(im, "root", task, [fin], "/root/.orc");
check("finished card not touched again", calls.length === before);
check("persisted", JSON.parse(readFileSync(store, "utf8"))["a:21"]?.done === true);
const old = att({ id: 22, status: "done", startedAt: T0 - 3_600_000, endedAt: T0 - 3_000_000, parsed: { kind: "report", pass: true, summary: "旧", notes: [], value: {} } });
await cards.syncAttempts(im, "root", task, [old], "/root/.orc");
check("runs finished before boot get no card", calls.length === before);
const quick = { ...att({ id: 23 }), status: "done", startedAt: Date.now(), endedAt: Date.now(), parsed: { kind: "report", pass: true, summary: "秒完", notes: [], value: {} } };
await cards.syncAttempts(im, "root", task, [quick], "/root/.orc");
check("run that started+ended between syncs still gets its final card", calls.at(-1)?.op === "reply" && calls.at(-1)!.text.includes("秒完"));
const cards2 = new AC.AgentCards(store);
check("card ids survive restart", cards2.cardId("a:21") === "m1");
const noThreads: any = { updateCardMessage: async () => true };
await cards.syncAttempts(noThreads, "root", task, [att({ id: 24 })], "/root/.orc");
check("platform without threads: no card, no throw", !cards.cardId("a:24"));

// ---- loop rounds ----
calls.length = 0;
await cards.loopRun(im, "root", { taskId: 9, n: 3, phase: "start", label: "监督者", model: "claude-sonnet-5.5" });
await cards.loopRun(im, "root", { taskId: 9, n: 3, phase: "end", label: "监督者", model: "claude-sonnet-5.5", tokens: 120_000 });
await sleep(70);
await cards.loopRun(im, "root", { taskId: 9, n: 3, phase: "start", label: "worker", model: "deepseek-v4.1-flash-ioa" });
await sleep(70);
await cards.loopRun(im, "root", { taskId: 9, n: 3, phase: "progress", label: "worker", model: "deepseek-v4.1-flash-ioa", line: "改 loader.py" });
const lt = calls.at(-1)!.text;
check("loop round card: one card, both runs, live line", calls.filter((c) => c.op === "reply").length === 1 && lt.includes("✓ 监督者 · claude-sonnet-5.5") && lt.includes("▶ 执行 · deepseek") && lt.includes("> 改 loader.py"), lt);
const ok = await cards.loopTurn(im, "root", 9, 3, "**第 3 轮 · 下指令**\n主 → 子：改 loader\n子 → 主：改好了");
const ft = calls.at(-1)!.text;
check("loop turn finalises the round card", ok && ft.includes("**下指令**") && ft.includes("子 → 主：改好了") && ft.includes("✓ 执行") && !ft.includes("运行中"), ft);
check("loop turn without a card → false (caller posts)", !(await cards.loopTurn(im, "root", 9, 99, "x")));

// ---- platform hooks ----
check("feishu has replyCardInThread", typeof (FeishuClient.prototype as any).replyCardInThread === "function");
check("telegram has replyCardInThread", typeof (TelegramClient.prototype as any).replyCardInThread === "function");
const { WeComClient: WecomClient } = await import("../src/platform/wecom");
check("wecom has no thread cards", typeof (WecomClient.prototype as any).replyCardInThread !== "function");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
