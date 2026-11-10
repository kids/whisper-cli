// Offline checks for src/orc/route.ts (message → single agent / lead) and [[task]] parsing.
//   npx tsx scripts/route_check.ts
import { extractTaskOps, formatTaskHint, routeMessage, type RouteCtx, type RouteTask } from "../src/orc/route";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) { failed++; console.log(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
};

const now = Date.now();
const t = (id: number, title: string, status: RouteTask["status"], extra: Partial<RouteTask> = {}): RouteTask => ({ id, title, status, updatedAt: now, ...extra });
const none: RouteCtx = { mode: "auto", tasks: [] };
const busy: RouteCtx = { mode: "auto", tasks: [t(12, "登录接口加限流", "running"), t(9, "修复导出 CSV 乱码", "failed")] };
const asking: RouteCtx = { mode: "auto", tasks: [t(15, "调优训练超参", "blocked", { asking: true })] };
const proposal: RouteCtx = { mode: "auto", tasks: [], pendingProposal: true };
const stale: RouteCtx = { mode: "auto", tasks: [t(3, "旧的迁移任务", "failed", { updatedAt: now - 3 * 86_400_000 }), t(4, "做完的事", "ready")] };

// [message, context, expected route]
const cases: [string, RouteCtx, "single" | "lead"][] = [
  // ordinary work with no tasks around → single agent
  ["令牌桶和漏桶有什么区别", none, "single"],
  ["帮我看下 src/app.ts 第 30 行为什么报错", none, "single"],
  ["给 README 加一段安装说明", none, "single"],
  ["画一下 loss 曲线发群里", none, "single"],
  ["后台跑一下 train.py，跑完或出错叫我", none, "single"],
  ["记住：GPU 机器只有 2 张卡", none, "single"],
  ["修一下这个 bug，跑一下测试", none, "single"],
  ["好的", none, "single"],
  ["继续", none, "single"],
  ["这个函数改成异步的", none, "single"],
  // new team work → lead
  ["这个交给团队做，测试全过为止", none, "lead"],
  ["让团队把订单服务的幂等校验做了", none, "lead"],
  ["启动团队，做一下分布预测的离线可行性检查", none, "lead"],
  ["用团队做一下分布预测的离线可行性检查", none, "lead"],
  ["开个团队查一下这个内存泄漏", none, "lead"],
  ["叫团队来把这个模块重构了", none, "lead"],
  ["团队，帮我把文档补齐", none, "lead"],
  ["整理一下明天开团队会的议程", none, "single"],
  ["我们团队的论文投哪个会合适", none, "single"],
  ["把团队成员名单导出成 csv", none, "single"],
  ["用多 agent 做一下这个重构", none, "lead"],
  ["开个任务：给导出加 utf-8 BOM", none, "lead"],
  ["让两个模型交叉评审一下这次改动", none, "lead"],
  ["换个模型再审一遍", none, "lead"],
  ["一直调参直到 val loss 低于 0.3", none, "lead"],
  ["反复修直到测试全部通过为止", none, "lead"],
  ["帮我盯着跑这个实验，结果不好就调整再跑", none, "lead"],
  // mode switches → lead
  ["切到编排模式", none, "lead"],
  ["回到单聊模式吧", none, "lead"],
  ["退出团队模式", none, "lead"],
  // steering tasks in progress → lead
  ["#12 到哪了", busy, "lead"],
  ["12 号那个怎么样了", busy, "lead"],
  ["限流那个改用 redis 令牌桶", busy, "lead"],
  ["登录接口限流先别做了", busy, "lead"],
  ["进展如何", busy, "lead"],
  ["再试一次，评审意见里的编码问题用 utf-8-sig 解决", busy, "lead"],
  ["放弃吧", busy, "lead"],
  ["执行者换成 claude", busy, "lead"],
  ["别每轮都刷屏了", busy, "lead"],
  // ...but ordinary chat while tasks run stays with the single agent
  ["这段正则怎么写：匹配邮箱", busy, "single"],
  ["帮我解释一下 src/route.ts 的作用", busy, "single"],
  ["把 utils 里的 sleep 函数换成 setTimeout 的 promise 版本，并补上单元测试和注释说明", busy, "single"],
  // open questions
  ["可以推了", asking, "lead"],
  ["先别推，我再看看曲线", asking, "lead"],
  ["b", asking, "lead"],
  ["这个任务先停一下，帮我先查一个线上问题：昨天下午三点开始订单服务 500 变多", asking, "lead"],
  ["帮我看一下这个线上问题：昨天下午三点开始订单服务的 500 错误突然变多，日志在 /var/log/order", asking, "single"],
  // pending proposal
  ["好，就这么改", proposal, "lead"],
  ["算了，不改了", proposal, "lead"],
  ["好的，另外帮我看下 app.ts 第 30 行的报错", proposal, "single"],
  ["好的", proposal, "lead"],
  ["算了", proposal, "lead"],
  ["确认", proposal, "lead"],
  // stale / finished tasks don't attract messages
  ["进展如何", stale, "single"],
  ["#4 到哪了", stale, "single"],
  // modes
  ["令牌桶和漏桶有什么区别", { ...none, mode: "orc" }, "lead"],
  ["这个交给团队做", { ...none, mode: "single" }, "single"],
  ["可以推了", { ...asking, mode: "single" }, "lead"],
  ["确认", { ...proposal, mode: "single" }, "lead"],
  ["随便聊聊", { ...none, inThread: true }, "lead"],
  ["这个交给团队做", { ...none, hasAttachments: true }, "single"],
  // monitors are the single agent's, even while orc tasks run
  ["训练跑完之后把监控停掉，然后把 eval 结果汇总一下发群里", busy, "single"],
  ["停掉监控", busy, "single"],
  ["别再盯了", busy, "single"],
  ["#12 的监控停一下", busy, "lead"],
];

let ok = 0;
for (const [msg, ctx, want] of cases) {
  const r = routeMessage(msg, ctx);
  if (r.to === want) ok++;
  else check(`route "${msg}"`, false, { want, got: r });
}
console.log(`route cases: ${ok}/${cases.length}`);


// ---- [[task]] parsing ----
{
  const r = extractTaskOps([
    "这件事需要反复迭代，我交给团队了。",
    '[[task]] {"goal":"修复 slugify 直到 test.js 全过","preset":"loop","criteria":["node test.js 退出码为 0"," "],"constraints":["不加依赖"]}',
    "```",
    '[[task]] {"goal":"in code block"}',
    "```",
    "[[任务]] 给导出加 BOM",
    "[[task]] {bad json",
    '[[task]] {"preset":"dev"}',
  ].join("\n"));
  check("task ops parsed", r.ops.length === 3 && r.ops[0].goal === "修复 slugify 直到 test.js 全过" && r.ops[0].preset === "loop" && r.ops[0].criteria?.length === 1 && r.ops[0].constraints?.[0] === "不加依赖", r.ops);
  check("plain-text goal alias", r.ops[1].goal === "给导出加 BOM" && !r.ops[1].preset, r.ops[1]);
  check("bad json → error", !!r.ops[2].error, r.ops[2]);
  check("max 3 ops (4th dropped)", r.ops.length === 3);
  check("lines stripped, fenced kept", r.text.startsWith("这件事需要") && r.text.includes("in code block") && !/修复 slugify/.test(r.text), r.text);
  const h = formatTaskHint();
  check("hint explains protocol", h.includes("[[task]]") && h.includes("loop") && h.includes("[[watch]]"));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
