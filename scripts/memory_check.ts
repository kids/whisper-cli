// Offline check for src/memory.ts + the lead-agent remember/forget actions.
//   npx tsx scripts/memory_check.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "chatmem-"));
process.env.CHAT_MEMORY_DIR = dir;

const mem = await import("../src/memory");
const { parseLeadAction, buildLeadPrompt } = await import("../src/orc/chat");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

const A = "oc_chat_a", B = "oc_chat_b";

// --- store ---
check("empty chat injects nothing (ro)", mem.formatMemory(A) === undefined);
check("empty chat still gets write hint (rw)", !!mem.formatMemory(A, { writable: true })?.includes("[[remember]]"));
const i1 = mem.addMemory(A, "  结论先给中文摘要  ", "user")!;
const i2 = mem.addMemory(A, "训练默认用 8 卡 A100", "agent")!;
check("ids increase", i1.id === 1 && i2.id === 2);
check("whitespace normalized", i1.text === "结论先给中文摘要");
check("duplicate not re-added", mem.addMemory(A, "结论先给中文摘要", "lead")!.id === 1 && mem.listMemory(A).length === 2);
check("chats isolated", mem.listMemory(B).length === 0 && mem.formatMemory(B) === undefined);
check("persisted to <chatId>.json", JSON.parse(readFileSync(join(dir, `${A}.json`), "utf8")).items.length === 2);
const ro = mem.formatMemory(A)!;
check("ro block lists ids", ro.includes("[1] 结论先给中文摘要") && ro.includes("[2] 训练默认用 8 卡 A100"));
check("ro block has no write hint", !ro.includes("[[remember]]"));
check("forget returns removed ids", JSON.stringify(mem.forgetMemory(A, [2, 99])) === "[2]");
check("ids not reused after forget", mem.addMemory(A, "第三条", "user")!.id === 3);

// --- budget ---
for (let i = 0; i < 80; i++) mem.addMemory(B, `条目${i} ` + "x".repeat(200), "user");
check("capped at MAX_ITEMS", mem.listMemory(B).length === mem.MAX_ITEMS);
const big = mem.formatMemory(B)!;
check("inject budget respected", big.length < mem.MAX_INJECT_CHARS + 400, `len=${big.length}`);
check("newest kept, older summarized", big.includes("条目79") && big.includes("较早的记忆未展示"));
check("clear", mem.clearMemory(B) === mem.MAX_ITEMS && mem.listMemory(B).length === 0);

// --- extraction from replies ---
const reply = "好的，已经调整。\n\n[[remember]] 本群代码评审用英文\n`[[forget]] 1, 3`\n";
const ops = mem.extractMemoryOps(reply);
check("extract remember", JSON.stringify(ops.remember) === '["本群代码评审用英文"]');
check("extract forget (backticked, comma list)", JSON.stringify(ops.forget) === "[1,3]");
check("protocol lines stripped", ops.text === "好的，已经调整。", JSON.stringify(ops.text));
check("inline mention not extracted", mem.extractMemoryOps("可以输出 [[remember]] 这样的行").remember.length === 0);
const footer = mem.applyMemoryOps(A, ops, "agent");
check("apply ops footer", footer.includes("本群代码评审用英文") && footer.includes("[1]") && footer.includes("[3]"));
check("apply ops state", mem.listMemory(A).map((i) => i.text).join("|") === "本群代码评审用英文");
check("no-op reply leaves text alone", mem.extractMemoryOps("普通回复\n\n\n多空行").text === "普通回复\n\n\n多空行");

// --- commands ---
check("/记住", mem.memoryCommand(A, "/记住 数据在 /data/exp")!.includes("已记入"));
check("/记忆 lists", mem.memoryCommand(A, "/记忆")!.includes("数据在 /data/exp"));
const id = mem.listMemory(A).find((i) => i.text === "数据在 /data/exp")!.id;
check("/记忆 forget", mem.memoryCommand(A, `/记忆 forget #${id}`)!.includes(`[${id}]`));
check("/memory add", mem.memoryCommand(A, "/memory add hello")!.includes("hello"));
check("/记忆 clear", mem.memoryCommand(A, "/记忆 clear")!.includes("已清空"));
check("non-command ignored", mem.memoryCommand(A, "记住这个") === undefined && mem.memoryCommand(A, "/model x") === undefined);
check("bad subcommand → usage", mem.memoryCommand(A, "/记忆 foo")!.includes("用法"));

// --- joinInstructions ---
check("join skips empty", mem.joinInstructions(undefined, "", "x") === "x" && mem.joinInstructions() === undefined);
check("join two blocks", mem.joinInstructions("a", "b") === "a\n\n---\n\nb");
check("chatOf", mem.chatOf("oc_x#lead") === "oc_x");

// --- lead actions ---
const r1 = parseLeadAction('{"action":"remember","items":["以后训练日志放 /data/logs"]}');
check("lead remember", "action" in r1 && r1.action === "remember" && r1.items[0] === "以后训练日志放 /data/logs");
const r2 = parseLeadAction('{"action":"remember","text":"单条写法"}');
check("lead remember (text fallback)", "action" in r2 && r2.action === "remember" && r2.items[0] === "单条写法");
const r3 = parseLeadAction('{"action":"forget","ids":[2,"3"]}');
check("lead forget", "action" in r3 && r3.action === "forget" && JSON.stringify(r3.ids) === "[2,3]");
check("lead forget invalid", "error" in parseLeadAction('{"action":"forget","ids":["x"]}'));
check("lead prompt mentions remember", buildLeadPrompt({ userText: "x", presetLine: "", tasks: [], presets: [], roles: [] }).includes('"action":"remember"'));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
