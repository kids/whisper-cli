// Live check: lead-agent intent → action accuracy on labeled chat messages.
// Uses the bot's codebuddy config; no Feishu, no task execution.
//   npx tsx scripts/orc_lead_check.ts [model]
import { resolve } from "node:path";
import { loadAllAgents } from "../src/config";
import { runCodebuddy } from "../src/ai/codebuddy";
import { buildLeadPrompt, parseLeadAction } from "../src/orc/chat";
import { loadPresets, loadRoles, resolvePreset } from "../src/orc/config";
import { createLedger } from "../src/orc/ledger";
import type { Task } from "../src/orc/types";

const model = process.argv[2];
const cfg = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!.codebuddy!;
const fakeTask = (id: number, title: string, status: Task["status"], progress: string, over: Partial<Task> = {}) =>
  ({ id, title, status, progress, ...over } as Task);

// a supervisor-loop task waiting on an irreversible question
const loopPreset = resolvePreset(loadPresets().get("loop")!, loadRoles());
const ledger = createLedger({ goal: "调优训练超参", criteria: ["val loss < 0.3"], head: "x", limits: loopPreset.loop!.budget, verbosity: "normal" });
ledger.pendingAsk = {
  step: 6, question: "实验结论已验证，要把改动推送到远端 main 吗？", why: "irreversible", askedAt: 0,
  options: [{ id: "a", label: "先不推，等我看完" }, { id: "b", label: "推送到远端", go: true }],
};
const store = { getLedger: (id: number) => (id === 15 ? ledger : undefined) } as any;

const tasks = [
  fakeTask(12, "登录接口加限流", "running", "review · critic#1 运行中"),
  fakeTask(9, "修复导出 CSV 乱码", "blocked", "review 已退回 3 次仍未通过"),
  fakeTask(15, "调优训练超参", "blocked", "等你决定：要推送吗", { kind: "loop", preset: loopPreset }),
];
// want: action, optionally "#<task>" (and ":<option>" for answer)
const cases: { msg: string; want: string; pending?: string; mode?: "auto" | "orc"; why?: string }[] = [
  { msg: "给订单服务加一个按用户维度的幂等键校验，重复请求返回第一次的结果", want: "submit" },
  { msg: "限流那个改用 redis 的令牌桶，不要用内存计数", want: "attach#12" },
  { msg: "停一下！限流方向错了，先别做了马上改成网关层做", want: "attach#12" },
  { msg: "#12 现在到哪了", want: "reply" },
  { msg: "csv 那个别管了，放弃吧", want: "stop#9" },
  { msg: "#9 再试一次，补充：评审意见里的编码问题用 utf-8-sig 解决", want: "retry#9" },
  { msg: "以后 critic 用 claude，测试只要一个就够了", want: "config" },
  { msg: "以后所有回复都先给一句话结论，再展开细节", want: "announce" },
  { msg: "令牌桶和漏桶有什么区别", want: "reply|chat" },
  { msg: "帮我看看", want: "reply" },
  // supervisor-loop steering, all in plain words
  { msg: "超参那个可以推了", want: "answer#15:b" },
  { msg: "训练那个先别推，我还要再看看曲线", want: "answer#15:a" },
  { msg: "调参任务的执行者换成 claude 跑吧", want: "config#15" },
  { msg: "15 别每轮都刷屏了，有结果再告诉我", want: "config#15" },
  { msg: "记一下：我们的 GPU 机器只有 2 张卡", want: "remember" },
  { msg: "好，就这么改", want: "confirm", pending: "调整编排 {\"roles\":{\"critic\":{\"cli\":\"claude\"}}}" },
  // auto mode: the router sent it here; misrouted chat goes back (chat), mode switches, real team work stays
  { msg: "帮我把 utils 里的 sleep 换成 promise 版本", want: "chat", mode: "auto", why: "调整进行中的任务" },
  { msg: "这个任务调度器的 bug 是什么原因，帮我看下 scheduler.ts", want: "chat", mode: "auto", why: "调整进行中的任务" },
  { msg: "进展如何？顺便问下 Python 的 GIL 是什么", want: "reply|chat", mode: "auto", why: "调整进行中的任务" },
  { msg: "回到单聊模式吧，团队先不用了", want: "mode", mode: "auto", why: "切换模式" },
  { msg: "以后都走团队编排模式", want: "mode", mode: "auto", why: "切换模式" },
  { msg: "这个交给团队做：给订单服务加幂等校验，测试全过为止", want: "submit", mode: "auto", why: "交给团队" },
];

function hit(want: string, act: any): boolean {
  return want.split("|").some((w) => {
    const m = /^(\w+)(?:#(\d+))?(?::(\w+))?$/.exec(w)!;
    return act.action === m[1] && (!m[2] || act.task === Number(m[2])) && (!m[3] || act.option === m[3]);
  });
}

async function main() {
  let ok = 0;
  const t0 = Date.now();
  await Promise.all(cases.map(async ({ msg, want, pending, mode, why }, i) => {
    const prompt = buildLeadPrompt({
      userText: msg, presetLine: "dev: plan → impl×3 → review(codex)×2 → test",
      tasks, presets: [...loadPresets().keys()], roles: [...loadRoles().keys()], store, pending, mode, routeWhy: why,
    });
    const res = await runCodebuddy({ prompt, chatId: `lead-check-${i}`, config: cfg, workdir: "/tmp", model, resumeSession: false, disallowedTools: ["Write", "Edit", "MultiEdit", "Bash"] });
    const act: any = parseLeadAction(res.text);
    const good = !("error" in act) && hit(want, act);
    if (good) ok++;
    const got = "error" in act ? `ERR(${act.error})` : act.action;
    console.log(`${good ? "✓" : "✗"} want=${want.padEnd(12)} got=${String(got).padEnd(8)} ${msg.slice(0, 30)}  ${"error" in act ? res.text.slice(0, 120) : JSON.stringify(act).slice(0, 180)}`);
  }));
  console.log(`\n${ok}/${cases.length} correct, ${Math.round((Date.now() - t0) / 1000)}s wall (parallel), model=${model || "default"}`);
}
main();
