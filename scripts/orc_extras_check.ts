// Offline checks for: orc Cursor executor (fake cursor-agent binary), model
// defaults when a role switches CLI, cancel classification, recent turns, lead
// history, persisted card ids / chat→bot binding.
//   npx tsx scripts/orc_extras_check.ts
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "orc-extras-"));
process.env.ORC_HOME = join(tmp, "orc");
process.env.ORC_CHATS_PATH = join(tmp, "orc-chats.json");
process.env.RECENT_TURNS_PATH = join(tmp, "recent.json");
delete process.env.CURSOR_API_KEY;

const { applyPatch, loadPresets, loadRoles, resolvePreset } = await import("../src/orc/config");
const { CliExecutor, classifyResult, eventToProgress } = await import("../src/orc/runner");
const recent = await import("../src/recent");
const { buildLeadPrompt, registerBot, bindChat, getProfile, hasOrcState } = await import("../src/orc/chat");
const { describeAction } = await import("../src/orc/commands");

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// --- model defaults when switching CLI ---
const roles = loadRoles();
const presets = loadPresets();
const review = presets.get("review")!;
const base = resolvePreset(review, roles);
check("critic_alt keeps its codebuddy model by default", base.roles.critic_alt?.model === "claude-opus-5.5", String(base.roles.critic_alt?.model));
const want: Record<string, string> = {
  critic: "gpt-6.1-sol", critic_alt: "claude-opus-5.5",
  implementer: "deepseek-v4.1-flash-ioa", reproducer: "deepseek-v4.1-flash-ioa", tester: "deepseek-v4.1-flash-ioa",
  researcher: "deepseek-v4.1-flash-ioa", synthesizer: "deepseek-v4.1-flash-ioa",
  supervisor: "claude-sonnet-5.5", planner: "claude-sonnet-5.5",
};
check("role default models", Object.entries(want).every(([r, m]) => roles.get(r)?.cli === "codebuddy" && roles.get(r)?.model === m),
  [...roles.values()].map((r) => `${r.name}/${r.cli}:${r.model}`));
const toCursor = resolvePreset(applyPatch(review, { roles: { critic_alt: { cli: "cursor" } } }, presets), roles);
check("critic_alt → cursor drops the codebuddy model → auto", toCursor.roles.critic_alt.cli === "cursor" && toCursor.roles.critic_alt.model === "auto");
const devCursor = resolvePreset(applyPatch(presets.get("dev")!, { roles: Object.fromEntries(["planner", "implementer", "critic", "tester"].map((r) => [r, { cli: "cursor" }])) as any }, presets), roles);
check("every role on cursor → auto", Object.values(devCursor.roles).every((r) => r.cli === "cursor" && r.model === "auto"));
const toCursorModel = resolvePreset(applyPatch(review, { roles: { critic_alt: { cli: "cursor", model: "gpt-5" } } }, presets), roles);
check("explicit model kept on CLI switch", toCursorModel.roles.critic_alt.model === "gpt-5");
const dev = presets.get("dev")!;
const slotModel = { ...dev, roles: { ...dev.roles, critic: { ...dev.roles.critic, model: "gpt-5.3-codex" } } };
const patched = applyPatch(slotModel, { roles: { critic: { cli: "cursor" } } }, presets);
check("patch cli change drops preset slot model", patched.roles.critic.cli === "cursor" && patched.roles.critic.model === undefined && resolvePreset(patched, roles).roles.critic.model === "auto");
const sameCli = applyPatch(slotModel, { roles: { critic: { count: 2 } } }, presets);
check("patch without cli change keeps slot model", sameCli.roles.critic.model === "gpt-5.3-codex");
check("cursor not available without a key → validation error", (() => {
  try { resolvePreset(applyPatch(review, { roles: { critic_alt: { cli: "cursor" } } }, presets), roles, { availableClis: ["codebuddy", "codex"] }); return false; }
  catch (e) { return /cursor.*not configured/.test((e as Error).message); }
})());

// --- classification / progress ---
check("⏹️ classified as cancelled (claude/gemini/cursor)", classifyResult("⏹️ Stopped by user.").cancelled === true);
check("🛑 still cancelled (codebuddy)", classifyResult("🛑 任务已被用户终止。").cancelled === true);
check("cursor timeout classified", classifyResult("⏱️ Cursor Agent timed out: no output for 2min.").timedOut === true);
check("cursor shell progress", eventToProgress({ type: "tool_call", subtype: "started", tool_call: { shellToolCall: { args: { command: "pytest -q" } } } }) === "shell: pytest -q");
check("cursor read progress", eventToProgress({ type: "tool_call", subtype: "started", tool_call: { readToolCall: { args: { path: "/x/a.py" } } } }) === "read: /x/a.py");
check("cursor completed event ignored", eventToProgress({ type: "tool_call", subtype: "completed", tool_call: { shellToolCall: {} } }) === undefined);

// --- Cursor executor against a fake binary ---
const argsLog = join(tmp, "args.log");
const fake = join(tmp, "fake-agent.sh");
writeFileSync(fake, `#!/bin/bash
printf '%s\\n' "$@" > ${argsLog}
echo "KEY=$CURSOR_API_KEY" >> ${argsLog}
if [[ "$*" == *SLOW* ]]; then sleep 30; fi
echo '{"type":"system","subtype":"init","session_id":"sess-123","model":"auto"}'
echo '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls"}}}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"{\\"verdict\\":\\"approve\\",\\"issues\\":[]}"}]}}'
echo '{"type":"result","subtype":"success","result":"done","usage":{"inputTokens":10,"outputTokens":5}}'
`);
chmodSync(fake, 0o755);
const noKey = new CliExecutor([], { cursorAgentBin: fake });
check("cursor unavailable without key", !noKey.available().includes("cursor"));
process.env.CURSOR_API_KEY = "k-test";
const ex = new CliExecutor([], { cursorAgentBin: fake });
check("cursor available with CURSOR_API_KEY", ex.available().includes("cursor"));
const progress: string[] = [];
const res = await ex.run({
  cli: "cursor", prompt: "REVIEW THIS", sessionKey: "orc:1#critic:0", cwd: tmp, appendSystemPrompt: "【本群指令】X",
  readOnly: true, hardTimeoutMs: 60_000, staleTimeoutMs: 30_000, onProgress: (l) => progress.push(l),
});
const args = readFileSync(argsLog, "utf8").split("\n");
const after = (flag: string) => args[args.indexOf(flag) + 1];
check("cursor: model defaults to auto", after("--model") === "auto");
check("cursor: readonly → --mode ask", after("--mode") === "ask");
check("cursor: workspace = task cwd", after("--workspace") === tmp);
check("cursor: fresh (no --resume)", !args.includes("--resume"));
check("cursor: instructions prefixed to prompt", args.some((a) => a.startsWith("【本群指令】X")) && args.includes("REVIEW THIS"));
check("cursor: api key passed", args.includes("KEY=k-test"));
check("cursor: session id returned", res.sessionId === "sess-123");
check("cursor: output text", res.text.includes('"verdict":"approve"') && !res.error && !res.timedOut);
check("cursor: progress from tool_call", progress.includes("shell: ls"), JSON.stringify(progress));
check("cursor: tokens", res.tokens === 15);
await ex.run({ cli: "cursor", prompt: "again", sessionKey: "orc:1#impl:0", cwd: tmp, resumeSessionId: "sess-123", model: "gpt-5", readOnly: false, hardTimeoutMs: 60_000, staleTimeoutMs: 30_000 });
const args2 = readFileSync(argsLog, "utf8").split("\n");
check("cursor: resume + explicit model, no --mode", args2[args2.indexOf("--resume") + 1] === "sess-123" && args2[args2.indexOf("--model") + 1] === "gpt-5" && !args2.includes("--mode"));
const t0 = Date.now();
const slow = await ex.run({ cli: "cursor", prompt: "SLOW", sessionKey: "orc:2#x:0", cwd: tmp, readOnly: true, hardTimeoutMs: 3_000, staleTimeoutMs: 60_000 });
check("cursor: per-call hard timeout honored", slow.timedOut && Date.now() - t0 < 15_000, `${Date.now() - t0}ms ${slow.text.slice(0, 60)}`);

// --- recent turns ---
for (let i = 0; i < 14; i++) recent.recordTurn("oc_r", i % 2 ? "agent" : "user", `turn ${i}`);
check("recent capped", recent.recentTurns("oc_r").length === recent.MAX_TURNS);
check("recent keeps newest", recent.recentTurns("oc_r").at(-1)!.text === "turn 13");
recent.recordTurn("oc_r", "agent", "y".repeat(5000));
check("recent clips long text", recent.recentTurns("oc_r").at(-1)!.text.length <= recent.MAX_TURN_CHARS + 1);
recent.recordTurn("oc_r", "user", "   ");
check("recent ignores blank", recent.recentTurns("oc_r").at(-1)!.who === "agent");
const block = recent.formatRecent("oc_r", 3)!;
check("formatRecent labels + order", block.split("\n").length === 3 && block.startsWith("[用户] turn 12\n[单 agent] turn 13\n[单 agent] yyy"), block.slice(0, 60));
check("formatRecent empty → undefined", recent.formatRecent("oc_none") === undefined);
recent.flushRecent();
check("recent persisted", JSON.parse(readFileSync(process.env.RECENT_TURNS_PATH!, "utf8")).oc_r.length === recent.MAX_TURNS);

// --- lead prompt / transcript ---
const lp = buildLeadPrompt({ userText: "把刚才这个交给团队做", presetLine: "dev", tasks: [], presets: ["dev"], roles: ["planner"], history: "[用户] 给导出加 xlsx\n[单 agent] 建议用 openpyxl" });
check("lead prompt carries history", lp.includes("最近对话") && lp.includes("openpyxl"));
check("lead prompt explains hand-off", lp.includes("把刚才这个交给团队"));
check("describeAction submit", describeAction({ action: "submit", goal: "G" }) === "（提交任务）G");
check("describeAction reply", describeAction({ action: "reply", text: "hi" }) === "hi");

// --- chat → bot binding (restart) ---
const fakeA = { name: "A" } as any, fakeB = { name: "B" } as any;
registerBot("bot-a", fakeA);
registerBot("bot-b", fakeB);
bindChat("oc_bind", fakeB);
check("bindChat records serving bot", getProfile("oc_bind").bot === "bot-b");
check("binding persisted", JSON.parse(readFileSync(process.env.ORC_CHATS_PATH!, "utf8")).oc_bind.bot === "bot-b");
check("hasOrcState false on fresh ORC_HOME", hasOrcState() === false && !existsSync(join(process.env.ORC_HOME!, "orc.db")));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
