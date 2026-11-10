// Offline check for per-chat workspaces (src/workspace.ts) + runner wiring:
// /工作区, 「把工作目录切到 …」, `项目名:指令`, persistence, memory cleanup, prompt hint.
//   npx tsx scripts/workspace_check.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "ws-check-"));
Object.assign(process.env, {
  CHAT_WORKSPACE_FILE: join(tmp, "chat-workspace.json"), CHAT_MEMORY_DIR: join(tmp, "mem"),
  WATCHES_PATH: join(tmp, "watches.json"), RECENT_TURNS_PATH: join(tmp, "recent.json"),
  ORC_HOME: join(tmp, "orc"), ORC_CHATS_PATH: join(tmp, "orc-chats.json"),
});

const repo = join(tmp, "repo-a");
const plain = join(tmp, "plain-b");
mkdirSync(repo); mkdirSync(plain); mkdirSync(join(tmp, "default"));
execFileSync("git", ["init", "-q", repo]);
const projectsFile = join(tmp, "projects.json");
writeFileSync(projectsFile, JSON.stringify({
  projects: { "repo-a": { path: repo, description: "" }, "plain-b": { path: plain, description: "" }, gone: { path: join(tmp, "nope"), description: "" } },
  default_project: "",
}));

const P = await import("../src/projects");
P.loadProjects(projectsFile);
const WS = await import("../src/workspace");
const mem = await import("../src/memory");

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 240) : ""}`);
  if (!ok) failed++;
};

// --- intent parsing ---
const I = (t: string) => WS.parseSwitchWorkspaceIntent(t);
check("把群的工作目录切到 <path>", I("把群的工作目录切到 /data/dev/sci-review-bench")?.target === "/data/dev/sci-review-bench");
check("工作区换成 <project>", I("工作区换成 worldout")?.target === "worldout");
check("no space + trailing instruction", JSON.stringify(I("把工作目录切到repo-a然后跑一下测试")) === JSON.stringify({ target: "repo-a", rest: "跑一下测试", explicit: true }), I("把工作目录切到repo-a然后跑一下测试"));
check("comma + instruction", I("工作目录改成 /tmp/x，再看看 README")?.rest === "看看 README");
check("切到 X 项目 (non-explicit)", JSON.stringify(I("切到 repo-a 项目")) === JSON.stringify({ target: "repo-a", rest: "", explicit: false }), I("切到 repo-a 项目"));
check("cd <path>", I("cd /tmp")?.target === "/tmp" && I("cd /tmp")!.explicit);
check("question is not a switch", I("刚才不是已经把 工作目录 切到 /data/dev/x 了吗") === undefined);
check("「工作目录改了吗」 is not a switch", I("工作目录改了吗") === undefined);
check("「切到 main 分支」 is not a switch", I("切到 main 分支") === undefined);
check("slash command not parsed as words", I("/工作区 repo-a") === undefined);
check("long text ignored", I("把工作目录切到 /tmp " + "x".repeat(300)) === undefined);

check("/工作区 arg", WS.workspaceCommandArg("/工作区 repo-a") === "repo-a" && WS.workspaceCommandArg("/ws") === "" && WS.workspaceCommandArg("/工作区默认") === undefined);

// --- target resolution ---
const R = (a: string) => WS.resolveWorkspaceTarget(a);
const r1 = R("repo-a");
check("project key → path + label", r1.ok && r1.ws.workspace === repo && r1.ws.label === "repo-a", r1);
const r2 = R("REPO-A 项目");
check("case-insensitive + 「项目」 suffix", r2.ok && r2.ws.label === "repo-a", r2);
const r3 = R(plain + "/");
check("abs path gets project label", r3.ok && r3.ws.workspace === plain && r3.ws.label === "plain-b", r3);
const r4 = R(join(tmp, "default"));
check("abs path outside projects → basename label", r4.ok && r4.ws.label === "default", r4);
const r5 = R("/no/such/dir");
check("missing dir rejected", !r5.ok && r5.reason.includes("不存在"), r5);
const r6 = R("nosuch");
check("unknown project lists choices", !r6.ok && r6.reason.includes("`repo-a`"), r6);
const r7 = R("gone");
check("project with missing dir rejected", !r7.ok && r7.reason.includes("不存在"), r7);
const pre = P.matchProjectPrefix("repo-a：跑测试");
check("project prefix (full-width colon)", pre?.key === "repo-a" && pre.prompt === "跑测试", pre);
check("unknown prefix ignored", P.matchProjectPrefix("注意: 别推") === undefined);

// --- memory guard ---
check("workspace memory detected", mem.isWorkspaceMemory("本群工作目录固定为 /data/dev/sci-review-bench，后续都以它为根路径。"));
check("normal memory not flagged", !mem.isWorkspaceMemory("训练日志放 out/ 目录") && !mem.isWorkspaceMemory("工作区要保持整洁"));
const foot = mem.applyMemoryOps("oc_m", { text: "", remember: ["本群工作目录是 /data/dev/worldout", "结论先给中文摘要"], forget: [] }, "agent");
check("agent cannot remember a workdir", mem.listMemory("oc_m").map((i) => i.text).join("|") === "结论先给中文摘要" && foot.includes("/工作区"), foot);
const foot2 = mem.applyMemoryOps("oc_m2", { text: "", remember: ["工作目录是 /x"], forget: [] }, "lead");
check("refused-only footer has no memory hint tail", mem.listMemory("oc_m2").length === 0 && !foot2.includes("/记忆"), foot2);

// --- persistence ---
WS.saveWorkspace("oc_p", { workspace: repo, label: "repo-a" });
check("persisted to file", JSON.parse(readFileSync(process.env.CHAT_WORKSPACE_FILE!, "utf8")).oc_p.workspace === repo);
WS.saveWorkspace("oc_p", undefined);
check("reset removes entry", !("oc_p" in JSON.parse(readFileSync(process.env.CHAT_WORKSPACE_FILE!, "utf8"))));

// --- runner wiring ---
const { loadAllAgents } = await import("../src/config");
const { AgentRunner } = await import("../src/agent-runner");
const sent: { kind: string; chat: string; text: string }[] = [];
const im = {
  sendMarkdown: async (chat: string, text: string) => { sent.push({ kind: "md", chat, text }); },
  sendToChat: async (chat: string, text: string) => { sent.push({ kind: "text", chat, text }); },
  sendPostMarkdown: async (chat: string, text: string) => { sent.push({ kind: "post", chat, text }); },
  sendCardAndGetId: async (chat: string, text: string) => { sent.push({ kind: "card", chat, text }); return "card"; },
  updateCardMessage: async () => true, finalizeCard: async () => true, replyInThread: async () => false,
  downloadAttachments: async () => [], sendAgentImages: async () => {}, sendAgentFiles: async () => {},
  platform: "feishu",
};
const base = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!;
const cfg = { ...base, allowlist: new Set<string>(), adminMode: false };
const DEFAULT = join(tmp, "default");
const runner: any = new AgentRunner(cfg, DEFAULT, {}, tmp);
runner.im = im;
const calls: { prompt: string; workspace: string }[] = [];
runner.dispatchAi = async (prompt: string, _c: string, workspace: string) => { calls.push({ prompt, workspace }); return { text: "ok", sessionId: "s1" }; };
const CHAT = "oc_ws";
const ev = (text: string) => ({ messageId: "m" + Math.random(), chatId: CHAT, chatType: "group", messageType: "text", text, senderOpenId: "u", content: "", attachments: [] });
const last = () => sent[sent.length - 1]?.text || "";

mem.addMemory(CHAT, "本群工作目录固定为 /data/dev/sci-review-bench，后续都以它为根路径。", "agent");
mem.addMemory(CHAT, "结论先给中文摘要", "user");

await runner.processMessage(ev("/工作区"));
check("/工作区 shows default", last().includes(DEFAULT) && last().includes("（默认）") && last().includes("不是 git 仓库"), last());

await runner.processMessage(ev("把群的工作目录切到 " + repo));
check("words switch → reply", last().includes("已切到 `repo-a`") && last().includes("是 git 仓库"), last());
check("words switch: no model turn", calls.length === 0);
check("stale workdir memory removed, others kept", mem.listMemory(CHAT).map((i) => i.text).join("|") === "结论先给中文摘要" && last().includes("[1]"), last());
check("orc sees the new workspace", runner.orcHost().workspaceFor(CHAT) === repo);

await runner.processMessage(ev("看看 README"));
check("next turn runs in the new workspace", calls.at(-1)?.workspace === repo, calls.at(-1));

await runner.processMessage(ev("/工作区 /no/such"));
check("bad path → error, unchanged", last().includes("不存在") && runner.orcHost().workspaceFor(CHAT) === repo, last());

await runner.processMessage(ev("工作区切到 nosuch"));
check("explicit words, bad target → error, no model turn", last().includes("没有叫「nosuch」") && last().includes("工作区没有变") && calls.length === 1, last());

await runner.processMessage(ev("切到 nosuch 项目"));
check("non-explicit words, bad target → goes to the model", calls.length === 2);

const nCalls = calls.length;
await runner.processMessage(ev("plain-b：列一下文件"));
check("project prefix switches + runs the rest", calls.length === nCalls + 1 && calls.at(-1)!.workspace === plain && calls.at(-1)!.prompt.includes("列一下文件") && !calls.at(-1)!.prompt.startsWith("plain-b"), calls.at(-1));
check("project prefix announces switch", sent.some((s) => s.text.includes("已切到 `plain-b`")));

await runner.processMessage(ev("把工作目录切到 repo-a 然后跑一下测试"));
check("switch + trailing instruction runs in new ws", calls.at(-1)!.workspace === repo && calls.at(-1)!.prompt.includes("跑一下测试"), calls.at(-1));

check("persisted for restart", JSON.parse(readFileSync(process.env.CHAT_WORKSPACE_FILE!, "utf8"))[CHAT]?.workspace === repo);
const runner2: any = new AgentRunner(cfg, DEFAULT, {}, tmp);
check("restart restores workspace", runner2.workspaceOf(CHAT).workspace === repo && runner2.workspaceOf(CHAT).label === "repo-a");

await runner.processMessage(ev("/工作区 默认"));
check("/工作区 默认 resets", last().includes(DEFAULT) && runner.orcHost().workspaceFor(CHAT) === DEFAULT, last());

// prompt hint (real dispatchAi path builds instructions; check the formatter directly)
const hint = WS.formatWorkspaceHint({ workspace: repo, label: "repo-a" });
check("hint names the real workspace and the switch command", hint.includes(repo) && hint.includes("/工作区") && hint.includes("切不了"));
const src = readFileSync(resolve(import.meta.dirname, "../src/agent-runner.ts"), "utf8");
check("dispatchAi injects the hint", /formatWorkspaceHint\(\{ workspace, label \}\)/.test(src));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
