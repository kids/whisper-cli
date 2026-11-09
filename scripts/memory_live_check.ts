// Live check: does a real agent use the per-chat memory protocol?
// Uses the bot's codebuddy config; no Feishu. Writes memory to a temp dir.
//   npx tsx scripts/memory_live_check.ts [model]
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

process.env.CHAT_MEMORY_DIR = mkdtempSync(join(tmpdir(), "chatmem-live-"));
const { loadAllAgents } = await import("../src/config");
const { runCodebuddy } = await import("../src/ai/codebuddy");
const mem = await import("../src/memory");
const { buildLeadPrompt, parseLeadAction } = await import("../src/orc/chat");

const model = process.argv[2];
const cfg = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!.codebuddy!;
const CHAT = "oc_memory_live_check";
const RO = ["Write", "Edit", "MultiEdit", "Bash"];
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const run = (prompt: string, key: string, append?: string, extra: Record<string, any> = {}) =>
  runCodebuddy({ prompt, chatId: key, config: cfg, workdir: "/tmp", model, resumeSession: false, disallowedTools: RO, appendSystemPrompt: append, ...extra } as any);

async function single() {
  // 1. user asks to remember → agent emits [[remember]]
  const r1 = await run("记住：本群的训练日志统一放在 /data/logs/exp，以后别再问我放哪。", "mem-live-1", mem.formatMemory(CHAT, { writable: true }));
  const ops1 = mem.extractMemoryOps(r1.text);
  check("single: '记住…' → [[remember]]", ops1.remember.length >= 1 && ops1.remember.join(" ").includes("/data/logs/exp"), JSON.stringify(ops1.remember));
  mem.applyMemoryOps(CHAT, ops1, "agent");
  // 2. ordinary question → no memory write
  const r2 = await run("Python 里 list 和 tuple 的主要区别？一句话。", "mem-live-2", mem.formatMemory(CHAT, { writable: true }));
  check("single: ordinary question writes nothing", mem.extractMemoryOps(r2.text).remember.length === 0, r2.text.slice(0, 80).replace(/\n/g, " "));
  // 3. fresh session recalls from injected memory
  const r3 = await run("训练日志放在哪？只回答路径。", "mem-live-3", mem.formatMemory(CHAT, { writable: true }));
  check("single: fresh session recalls memory", r3.text.includes("/data/logs/exp"), r3.text.slice(0, 80).replace(/\n/g, " "));
  // 4. forget by natural language
  const id = mem.listMemory(CHAT)[0]?.id;
  const r4 = await run(`第 ${id} 条记忆过时了，忘掉它。`, "mem-live-4", mem.formatMemory(CHAT, { writable: true }));
  const ops4 = mem.extractMemoryOps(r4.text);
  check("single: '忘掉第 N 条' → [[forget]] N", ops4.forget.includes(id), JSON.stringify(ops4.forget));
}

async function lead() {
  const cases: [string, string][] = [
    ["记住：这个群的实验都跑在 8 卡 A100 机器上", "remember"],
    ["第 1 条记忆删掉吧，不对了", "forget"],
    ["以后所有回复都先给一句话结论，再展开细节", "announce"],
    ["给订单服务加一个幂等键校验", "submit"],
  ];
  const memBlock = "【本群记忆】\n[1] 训练日志统一放在 /data/logs/exp";
  await Promise.all(cases.map(async ([msg, want], i) => {
    const prompt = buildLeadPrompt({ userText: msg, presetLine: "dev: plan → impl → review → test", tasks: [], presets: ["dev", "fix"], roles: ["planner", "implementer", "critic", "tester"] });
    const r = await run(prompt, `mem-lead-${i}`, memBlock);
    const a = parseLeadAction(r.text);
    const got = "action" in a ? a.action : `error:${a.error}`;
    check(`lead: ${msg.slice(0, 18)}… → ${want}`, got === want, `got=${got}`);
  }));
}

async function autoMemory() {
  // Does CodeBuddy Auto Memory write under -p, and does the env switch stop it?
  const slug = (p: string) => p.replace(/^\//, "").replace(/[\/_.]/g, "-");
  const memDir = (cwd: string) => join(process.env.HOME || "/root", ".codebuddy/projects", slug(cwd), "memory");
  const on = "/tmp/automem-on", off = "/tmp/automem-off";
  for (const d of [on, off]) mkdirSync(d, { recursive: true });
  const msg = "请长期记住：我偏好用 uv 管理 Python 依赖，所有项目都用 Python 3.12。好的就回复 OK。";
  await Promise.all([
    runCodebuddy({ prompt: msg, chatId: "automem-on", config: cfg, workdir: on, model, resumeSession: false } as any),
    runCodebuddy({ prompt: msg, chatId: "automem-off", config: cfg, workdir: off, model, resumeSession: false, disableAutoMemory: true } as any),
  ]);
  const count = (d: string) => (existsSync(d) ? readdirSync(d).length : 0);
  console.log(`INFO auto memory files: enabled=${count(memDir(on))} (${memDir(on)})  disabled=${count(memDir(off))}`);
  check("auto memory disabled → nothing written", count(memDir(off)) === 0);
}

const t0 = Date.now();
await Promise.all([single(), lead(), autoMemory()]);
console.log(`\n${failed ? `${failed} FAILED` : "all passed"} in ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(failed ? 1 : 0);
