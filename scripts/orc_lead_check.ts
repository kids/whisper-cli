// Live check: lead-agent intent → action accuracy on labeled chat messages.
// Uses the bot's codebuddy config; no Feishu, no task execution.
//   npx tsx scripts/orc_lead_check.ts [model]
import { resolve } from "node:path";
import { loadAllAgents } from "../src/config";
import { runCodebuddy } from "../src/ai/codebuddy";
import { buildLeadPrompt, parseLeadAction } from "../src/orc/chat";
import { loadPresets, loadRoles } from "../src/orc/config";
import type { Task } from "../src/orc/types";

const model = process.argv[2];
const cfg = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!.codebuddy!;
const fakeTask = (id: number, title: string, status: Task["status"], progress: string) =>
  ({ id, title, status, progress } as Task);
const tasks = [
  fakeTask(12, "登录接口加限流", "running", "review · critic#1 运行中"),
  fakeTask(9, "修复导出 CSV 乱码", "blocked", "review 已退回 3 次仍未通过"),
];
const cases: [string, string][] = [
  ["给订单服务加一个按用户维度的幂等键校验，重复请求返回第一次的结果", "submit"],
  ["限流那个改用 redis 的令牌桶，不要用内存计数", "attach"],
  ["停一下！限流方向错了，先别做了马上改成网关层做", "attach"],
  ["#12 现在到哪了", "status"],
  ["csv 那个别管了，放弃吧", "stop"],
  ["#9 再试一次，补充：评审意见里的编码问题用 utf-8-sig 解决", "retry"],
  ["以后 critic 用 claude，测试只要一个就够了", "config"],
  ["以后所有回复都先给一句话结论，再展开细节", "announce"],
  ["令牌桶和漏桶有什么区别", "reply"],
  ["帮我看看", "reply"],
];

async function main() {
  let ok = 0;
  const t0 = Date.now();
  await Promise.all(cases.map(async ([msg, want], i) => {
    const prompt = buildLeadPrompt({
      userText: msg, presetLine: "dev: plan → impl×3 → review(codex)×2 → test",
      tasks, presets: [...loadPresets().keys()], roles: [...loadRoles().keys()],
    });
    const res = await runCodebuddy({ prompt, chatId: `lead-check-${i}`, config: cfg, workdir: "/tmp", model, resumeSession: false, disallowedTools: ["Write", "Edit", "MultiEdit", "Bash"] });
    const act: any = parseLeadAction(res.text);
    const got = "error" in act ? `ERR(${act.error})` : act.action;
    const hit = got === want;
    if (hit) ok++;
    console.log(`${hit ? "✓" : "✗"} want=${want.padEnd(8)} got=${String(got).padEnd(8)} ${msg.slice(0, 30)}  ${"error" in act ? res.text.slice(0, 120) : JSON.stringify(act).slice(0, 160)}`);
  }));
  console.log(`\n${ok}/${cases.length} correct, ${Math.round((Date.now() - t0) / 1000)}s wall (parallel), model=${model || "default"}`);
}
main();
