// Smoke test of AgentRunner wiring with a fake Feishu client and a stubbed model call:
// reply → [[remember]]/[[watch]] extraction → watch card → fire → notify → wake turn → /watch.
//   npx tsx scripts/runner_wiring_check.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "runner-wiring-"));
Object.assign(process.env, {
  WATCHES_PATH: join(tmp, "watches.json"), CHAT_MEMORY_DIR: join(tmp, "mem"), RECENT_TURNS_PATH: join(tmp, "recent.json"),
  ORC_HOME: join(tmp, "orc"), ORC_CHATS_PATH: join(tmp, "orc-chats.json"),
});
const { loadAllAgents } = await import("../src/config");
const { AgentRunner } = await import("../src/agent-runner");
const W = await import("../src/watch");
const mem = await import("../src/memory");

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 200) : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sent: { kind: string; chat: string; text: string; id?: string }[] = [];
let n = 0;
const feishu = {
  sendMarkdown: async (chat: string, text: string) => { sent.push({ kind: "md", chat, text }); },
  sendToChat: async (chat: string, text: string) => { sent.push({ kind: "text", chat, text }); },
  sendPostMarkdown: async (chat: string, text: string) => { sent.push({ kind: "post", chat, text }); },
  sendCardAndGetId: async (chat: string, text: string) => { const id = `card-${++n}`; sent.push({ kind: "card", chat, text, id }); return id; },
  updateCardMessage: async (id: string, text: string) => { sent.push({ kind: "update", chat: "", text, id }); return true; },
  finalizeCard: async (id: string, text: string) => { sent.push({ kind: "update", chat: "", text, id }); return true; },
  replyInThread: async () => false,
  downloadAttachments: async () => [],
  sendAgentImages: async () => {}, sendAgentFiles: async () => {},
  platform: "feishu",
};

const cfg = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!;
const work = join(tmp, "ws");
const runner: any = new AgentRunner(cfg, work, {}, tmp);
runner.im = feishu;
const prompts: string[] = [];
let nextReply = "";
runner.dispatchAi = async (prompt: string) => { prompts.push(prompt); return { text: nextReply, sessionId: "sess-1" }; };
W.registerWatchHost(cfg.name, {
  card: async (w) => { if (w.cardId) await feishu.updateCardMessage(w.cardId, W.renderWatchCard(w)); },
  fire: (w, r) => runner.onWatchFire(w, r),
});

const CHAT = "oc_wiring";
const flag = join(tmp, "done.flag");
const ev = (text: string) => ({ messageId: "m" + Math.random(), chatId: CHAT, chatType: "group", messageType: "text", text, senderOpenId: "u", content: "", attachments: [] });

// 1. a normal turn whose reply carries memory + watch lines
nextReply = `已在后台启动。\n[[remember]] 训练日志放 out/\n[[watch]] {"title":"job","file":"${flag}","every":"30s","on_wake":"汇报结果"}`;
await runner.runAiAndReply(ev("后台跑训练，跑完叫我"));
const reply = sent.filter((s) => s.kind === "update" || s.kind === "post").map((s) => s.text).join("\n");
check("protocol lines hidden from the user", !reply.includes("[[watch]]") && !reply.includes("[[remember]]"), reply);
check("reply footer mentions memory + watch", reply.includes("已记入本群记忆") && reply.includes("已登记监控 #1"), reply);
check("memory written", mem.listMemory(CHAT).some((i) => i.text === "训练日志放 out/"));
const w = W.getWatch(1)!;
check("watch persisted with bot/chat/cwd", !!w && w.bot === cfg.name && w.chatId === CHAT && w.cwd === work);
check("watch card posted and id saved", sent.some((s) => s.kind === "card" && s.text.includes("监控 #1")) && w.cardId === sent.find((s) => s.kind === "card" && s.text.includes("监控 #1"))?.id);

// 2. /watch list + check
await runner.handleCommand(ev("/watch"));
check("/watch lists the watch", sent.at(-1)!.text.includes("监控 #1 job"), sent.at(-1)!.text);
await runner.handleCommand(ev("/watch check 1"));
check("/watch check probes now", W.getWatch(1)!.checks === 1 && sent.some((s) => s.kind === "update" && s.id === w.cardId));

// 3. condition met → notify + wake turn through the chat queue
writeFileSync(flag, "ok");
nextReply = "训练完成，loss 0.16。";
const before = prompts.length;
await W.tickWatches(Date.now() + 120_000);
for (let i = 0; i < 50 && prompts.length === before; i++) await sleep(50);
await sleep(100);
check("fire notice posted", sent.some((s) => s.kind === "md" && s.text.includes("🔔 监控 #1") && s.text.includes("唤醒")));
check("wake turn ran with the wake prompt", (prompts.at(-1) ?? "").includes("【监控 #1 唤醒】") && (prompts.at(-1) ?? "").includes("汇报结果"));
check("wake reply delivered", sent.some((s) => (s.kind === "update" || s.kind === "post") && s.text.includes("loss 0.16")));
const recent = JSON.parse(JSON.stringify((await import("../src/recent")).recentTurns(CHAT)));
check("transcript marks the wake turn", recent.some((t: any) => t.who === "user" && t.text.startsWith("（监控唤醒）")), recent.map((t: any) => t.text.slice(0, 30)));
await W.tickWatches(Date.now() + 999_000);
check("fires only once", sent.filter((s) => s.kind === "md" && s.text.includes("🔔 监控 #1")).length === 1);

// 4. /watch stop on another watch
nextReply = `[[watch]] {"pid":999999,"title":"p"}`;
await runner.runAiAndReply(ev("盯一下 999999"));
await runner.handleCommand(ev("/watch stop 2"));
check("/watch stop cancels", W.getWatch(2)!.status === "cancelled" && sent.at(-1)!.text.includes("已停止监控 #2"));

// 5. natural-language stop: one active watch → stopped by code, no model turn
nextReply = `[[watch]] {"pid":999998,"title":"训练 b"}`;
await runner.runAiAndReply(ev("盯一下 999998"));
const turns = prompts.length;
await runner.processMessage(ev("别盯了"));
check("「别盯了」stops the only watch", W.getWatch(3)!.status === "cancelled" && sent.at(-1)!.text.includes("已停止监控 #3"), sent.at(-1)!.text);
check("…without a model turn", prompts.length === turns);
await runner.processMessage(ev("停掉监控"));
check("nothing left → says so", sent.at(-1)!.text.includes("没有进行中的监控"), sent.at(-1)!.text);
nextReply = `[[watch]] {"pid":999997,"title":"训练 c"}\n[[watch]] {"pid":999996,"title":"eval d"}`;
await runner.runAiAndReply(ev("盯两个"));
await runner.processMessage(ev("停掉监控"));
check("two watches → asks which", sent.at(-1)!.text.includes("要停哪个") && W.getWatch(4)!.status === "active" && W.getWatch(5)!.status === "active", sent.at(-1)!.text);
await runner.processMessage(ev("eval 那个监控关掉"));
check("title word picks it", W.getWatch(5)!.status === "cancelled" && W.getWatch(4)!.status === "active");
const card4 = sent.find((s) => s.kind === "card" && s.text.includes("监控 #4"));
check("watch card says how to stop in words", !!card4 && card4.text.includes("停掉监控 #4"), card4?.text);
nextReply = "好的，我看一下";
await runner.processMessage(ev("监控停了吗"));
check("a question goes to the agent", prompts.length > turns && W.getWatch(4)!.status === "active");

// 6. startup block present (the piece that went missing in 90ed027)
const src = readFileSync(resolve(import.meta.dirname, "../src/agent-runner.ts"), "utf8");
const start = src.slice(src.indexOf("async start()"), src.indexOf("private handleMessage"));
check("start(): registerBot + watch host + orc resume", ["registerBot(", "registerWatchHost(", "startWatches()", "hasOrcState()"].every((k) => start.includes(k)));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
