// =============================================================================
// orc chat commands + lead-agent turn (kept out of agent-runner.ts)
// =============================================================================
// Users normally just talk: src/orc/route.ts decides per message whether the
// single agent or the lead agent handles it. These commands are the fallback:
//   /mode [auto | single | orc [preset]]  how this chat routes messages
//   /orc                              current orchestration + presets
//   /orc preset <name> | reset        change / clear this chat's orchestration
//   /orc confirm | cancel             apply / drop the lead agent's pending proposal
//   /orc 播报 安静|正常|详细          per-agent thread cards for this chat's tasks
//   /task <goal>                      submit to orc (any mode)
//   /task <id> | stop|retry|accept|attach <id> …
//   /tasks                            this chat's tasks
// A lead turn only picks an action; the code below executes it (002 §2.3).
// =============================================================================
import { PLATFORM_LABEL, type ChatEvent, type ImClient } from "../platform/types";
import type { AgentConfig } from "../types";
import { applyMemoryOps } from "../memory";
import { formatRecent, recordTurn } from "../recent";
import { fallbackNote, loadPresets, loadRoles, presetSummary } from "./config";
import { acceptable, stageName } from "./core";
import { clip } from "./ledger";
import {
  availableClis, buildLeadPrompt, describePresetChange, getOrc, getProfile, listPresetSummaries, parseLeadAction,
  renderCard, resolveChatPreset, setProfile, submitFromChat, bindChat, taskForCard, taskLabel, type ChatProfile, type LeadAction,
} from "./chat";
import { MODE_LABEL, type ChatMode, type TaskOp } from "./route";
import type { ExecutorBins } from "./runner";
import type { CliName, Task, Verbosity } from "./types";
import { repoRoot } from "./worktree";

export interface OrcChatHost {
  im: ImClient;
  agents: AgentConfig[];
  bins: ExecutorBins;
  workspaceFor(chatId: string): string;
  /** One LLM turn for the lead agent (goes through the bot's own CLI + group announcement) */
  runLead(prompt: string, sessionKey: string): Promise<string>;
  /** Hand the message to the chat's single agent (lead `chat` action) */
  runSingle(ev: ChatEvent): Promise<void>;
}

const orcOf = (h: OrcChatHost) => getOrc(h.agents, h.bins);

/** This bot's own CLI: the orc engine is shared, so rebinding must be told which bot is talking */
const ownCli = (h: OrcChatHost): CliName | undefined => h.agents[0]?.aiCli as CliName | undefined;

const VERBOSITY_WORDS: Record<string, Verbosity> = { quiet: "quiet", 安静: "quiet", normal: "normal", 正常: "normal", verbose: "verbose", 详细: "verbose" };
const VERBOSITY_ZH: Record<Verbosity, string> = {
  quiet: "安静（回复串里不发每个 agent 的卡片，只发结果、提问和失败）",
  normal: "正常（回复串里每个 agent / 每轮一张卡片）",
  verbose: "详细（同正常，监督循环再附指令原文和监督者分析）",
};

/** Configured CLIs, this bot's own CLI first: the order roles fall back in (config.ts resolvePreset) */
function clisFor(h: OrcChatHost): string[] | undefined {
  const all = availableClis();
  if (!all.length) return undefined;
  const own = h.agents[0]?.aiCli;
  return own && all.includes(own) ? [own, ...all.filter((c) => c !== own)] : all;
}

const MODE_DESC: Record<ChatMode, string> = {
  auto: "自动：普通对话交给单 agent，需要团队的事（或说到进行中的任务）交给主 agent",
  single: "单 agent：只用单 agent；任务卡片回复串和待你回答的问题仍会交给主 agent",
  orc: "编排：每条消息都先经过主 agent，要动手的事都交给团队",
};

/** Switch the chat's mode; returns the message to post */
function switchMode(h: OrcChatHost, chatId: string, p: ChatProfile, want: ChatMode, preset?: string): string {
  const next: ChatProfile = { ...p, mode: want, ...(preset ? { preset, patch: {} } : {}) };
  if (want !== "single" || preset) {
    try { resolveChatPreset(next, undefined, clisFor(h)); }
    catch (e) { return `❌ ${(e as Error).message}`; }
    orcOf(h); bindChat(chatId, h.im);
  }
  setProfile(chatId, next);
  const tail = want === "single" ? "后台的团队任务会继续跑，结果照常通知。" : want === "orc" ? `默认编排 \`${next.preset}\`。说「回到自动模式」即可切回。` : "";
  return `🧭 已切到${MODE_LABEL[want]}模式 —— ${MODE_DESC[want]}。${tail}`;
}

/** Submit a team task from a single-agent `[[task]]` line; returns a note for the reply */
export async function submitTaskOp(h: OrcChatHost, chatId: string, op: TaskOp, sourceText: string): Promise<string> {
  if (op.error || !op.goal) return `⚠️ 没有转交团队：${op.error ?? "缺少目标"}`;
  orcOf(h);
  const r = await submit(h, chatId, op.goal, op.preset, { criteria: op.criteria, constraints: op.constraints, sourceText, bar: op.bar, title: op.title, origin: "agent" }, "caller", op.supersedes);
  return r.startsWith("❌") ? `⚠️ 没有转交团队：${r.replace(/^❌\s*/, "")}` : `🧭 ${r}`;
}

/** A top-level task untouched this long while waiting on a human is "hanging" (nudged on the next submit) */
const STALE_TASK_MS = Number(process.env.ORC_STALE_TASK_DAYS || 3) * 86_400_000;
const ENDED_STATUSES: Task["status"][] = ["ready", "failed", "dropped"];

/**
 * After a submit: close the tasks the new one replaces (`supersedes`), then name the
 * chat's other long-idle tasks so they do not hang in the background unnoticed.
 */
export function tidyAfterSubmit(o: ReturnType<typeof orcOf>, chatId: string, newId: number, supersedes?: number[], now = Date.now()): string {
  const out: string[] = [];
  const closed: string[] = [];
  for (const id of supersedes ?? []) {
    const t = o.store.getTask(id);
    if (!t || t.id === newId || t.chatId !== chatId || t.parentId || ENDED_STATUSES.includes(t.status)) continue;
    if (o.stop(id)) closed.push(`「${clip(t.title, 24)}」`);
  }
  if (closed.length) out.push(`🧹 新任务接替了 ${closed.join("、")}，旧任务已关掉（分支和改动都还在）。`);
  const stale = o.store.listTasks({ chatId, status: ["blocked", "waiting_children"], limit: 50 })
    .filter((t) => !t.parentId && t.id !== newId && now - t.updatedAt > STALE_TASK_MS);
  if (stale.length) {
    const days = (t: Task) => Math.floor((now - t.updatedAt) / 86_400_000);
    out.push(`📌 本群还挂着 ${stale.length} 个很久没动的团队任务：${stale.slice(0, 3).map((t) => `「${clip(t.title, 24)}」（${days(t)} 天没动）`).join("、")}${stale.length > 3 ? " 等" : ""}。不需要了就说「停掉 <任务名>」。`);
  }
  return out.join("\n");
}

// Note: submit() posts the card itself; the receipt text goes into the card's thread
// (deliver="thread", returns "" so the caller posts nothing more) unless the caller needs
// the text back to fold into its own reply (deliver="caller", e.g. the single agent's 🧭 line).
async function submit(
  h: OrcChatHost, chatId: string, goal: string, presetName?: string,
  extra: { criteria?: string[]; constraints?: string[]; sourceText?: string; bar?: string; title?: string; origin?: "human" | "agent" } = {},
  deliver: "thread" | "caller" = "thread",
  supersedes?: number[],
): Promise<string> {
  const o = orcOf(h);
  const repo = repoRoot(h.workspaceFor(chatId));
  if (!repo) return `❌ 当前工作区 \`${h.workspaceFor(chatId)}\` 不是 git 仓库，团队任务要用 git worktree 隔离各人的改动。先用 \`/工作区 <路径或项目名>\` 切到一个 git 仓库（也可以说「把工作目录切到 …」）。`;
  const profile = getProfile(chatId);
  let preset;
  try {
    preset = resolveChatPreset(presetName ? { ...profile, preset: presetName, patch: {} } : profile, undefined, clisFor(h));
  } catch (e) {
    return `❌ 编排无效：${(e as Error).message}`;
  }
  const crit = preset.kind === "loop" && extra.criteria?.length ? `\n验收标准：${extra.criteria.map((c, i) => `C${i + 1} ${c}`).join("；")}` : "";
  const fb = fallbackNote(preset);
  const receipt = (t: Task) => `已交给团队：**${taskLabel(t)}** → \`${presetSummary(preset)}\`\n仓库 \`${repo}\`，分支 \`${t.branch ?? "建好工作区后生成"}\`${crit}${fb ? `\nℹ️ ${fb}` : ""}`;
  const { task: t, receiptInThread } = await submitFromChat(
    o, h.im, chatId, goal, repo, preset, extra, deliver === "thread" ? { receipt } : {},
  );
  const tidy = tidyAfterSubmit(o, chatId, t.id, supersedes);
  return [receiptInThread ? "" : receipt(t), tidy].filter(Boolean).join("\n");
}

export async function handleOrcCommand(h: OrcChatHost, ev: ChatEvent): Promise<boolean> {
  const text = ev.text.trim();
  const chatId = ev.chatId;
  const say = (md: string) => h.im.sendMarkdown(chatId, md);

  let m = text.match(/^\/(mode|模式)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
  if (m) {
    const p = getProfile(chatId);
    const want = (m[2] || "").toLowerCase();
    if (!want) {
      await say(`当前：${MODE_LABEL[p.mode] ?? p.mode}模式 —— ${MODE_DESC[p.mode] ?? ""}\n平时不用管它，直接说话即可；要切换也可以直接说「切到编排模式」「回到自动模式」。\n命令：\`/mode auto\` · \`/mode single\` · \`/mode orc [组合]\``);
      return true;
    }
    if (want !== "auto" && want !== "single" && want !== "orc") { await say("用法：`/mode auto`、`/mode single` 或 `/mode orc [组合]`"); return true; }
    await say(switchMode(h, chatId, p, want, m[3]));
    return true;
  }

  m = text.match(/^\/orc(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
  if (m) {
    const p = getProfile(chatId);
    const sub = (m[1] || "").toLowerCase();
    if (!sub) {
      let cur = "", fb = "";
      try { const r = resolveChatPreset(p, undefined, clisFor(h)); fb = fallbackNote(r); cur = presetSummary(r); } catch (e) { cur = `⚠️ ${(e as Error).message}`; }
      await say([`**当前编排**（v${p.version}）：\`${cur}\``, fb ? `ℹ️ ${fb}` : "", p.pending ? `\n有待确认的变更：回复「确认」生效，「算了」放弃` : "", "", "**可选组合：**", ...listPresetSummaries(clisFor(h)), "", "想换组合或调整角色，直接说即可（例如「以后评审用 claude」）"].join("\n"));
      return true;
    }
    if (sub === "preset" && m[2]) {
      const next = { ...p, preset: m[2], patch: {}, version: p.version + 1, pending: undefined };
      try { const r = resolveChatPreset(next, undefined, clisFor(h)); setProfile(chatId, next); const fb = fallbackNote(r); await say(`已切换编排：\`${presetSummary(r)}\`（只影响之后的新任务）${fb ? `\nℹ️ ${fb}` : ""}`); }
      catch (e) { await say(`❌ ${(e as Error).message}`); }
      return true;
    }
    if (sub === "reset") { setProfile(chatId, { ...p, patch: {}, version: p.version + 1, pending: undefined }); await say("已清除本群对编排的调整。"); return true; }
    if (sub === "cancel") { setProfile(chatId, { ...p, pending: undefined }); await say("已放弃待确认的变更。"); return true; }
    if (sub === "confirm") { await confirmPending(h, chatId); return true; }
    if (sub === "播报" || sub === "verbosity") {
      const v = VERBOSITY_WORDS[(m[2] || "").toLowerCase()];
      if (!v) { await say(`本群团队任务的播报：**${VERBOSITY_ZH[p.verbosity ?? "normal"]}**\n用法：\`/orc 播报 安静|正常|详细\``); return true; }
      setProfile(chatId, { ...p, verbosity: v });
      await say(`📣 本群团队任务的播报改为 **${VERBOSITY_ZH[v]}**（流水线任务立即生效；监督循环任务对新任务生效，进行中的可以直接说「把播报改成…」）`);
      return true;
    }
    return false;
  }

  if (/^\/tasks\s*$/i.test(text)) {
    const ts = orcOf(h).store.listTasks({ chatId, limit: 15 });
    await say(ts.length ? ts.map((t) => `- ${t.title} [${t.status}] —— ${t.progress}`).join("\n") : "本群还没有团队任务。想交给团队做，直接说「这个交给团队做」即可。");
    return true;
  }

  m = text.match(/^\/task(?:\s+([\s\S]+))?$/i);
  if (m) {
    const arg = (m[1] || "").trim();
    const o = orcOf(h);
    bindChat(chatId, h.im);
    if (!arg) { await say("用法：`/task <目标>` 提交；`/task <id>` 查看；`/task stop|retry|accept|attach <id> …`"); return true; }
    const sm = arg.match(/^(stop|retry|accept|attach)\s+#?(\d+)\s*([\s\S]*)$/i);
    if (sm) {
      const id = Number(sm[2]);
      const verb = sm[1].toLowerCase();
      const name = o.store.getTask(id)?.title ?? "这个任务";
      const ok = verb === "stop" ? o.stop(id) : verb === "retry" ? o.retry(id, sm[3] || undefined, ownCli(h)) : verb === "accept" ? o.accept(id, sm[3] || undefined) : o.attach(id, sm[3], false, undefined, ownCli(h));
      await say(ok ? `「${name}」${verb === "stop" ? "已终止" : verb === "retry" ? "已重新排队" : verb === "accept" ? "已接受现在这版，继续后面的环节" : "补充已排队，下一轮交给 agent"}` : `「${name}」当前状态不支持 ${verb}`);
      return true;
    }
    if (/^#?\d+$/.test(arg)) {
      const t = o.store.getTask(Number(arg.replace("#", "")));
      await say(t ? renderCard(t, o.store) + (t.feedback ? `\n\n**待处理反馈**\n${t.feedback}` : "") : `没有任务 ${arg}`);
      return true;
    }
    const r = await submit(h, chatId, arg);
    if (r) await say(r);
    return true;
  }
  return false;
}

async function confirmPending(h: OrcChatHost, chatId: string): Promise<void> {
  const p = getProfile(chatId);
  const say = (md: string) => h.im.sendMarkdown(chatId, md);
  if (!p.pending) { await say("没有待确认的变更。"); return; }
  if (p.pending.kind === "config") {
    const patch = p.pending.patch;
    const nextPreset = patch.preset ?? p.preset;
    const merged = patch.preset && patch.preset !== p.preset ? { ...patch, preset: undefined } : { ...p.patch, ...patch, roles: { ...(p.patch.roles ?? {}), ...(patch.roles ?? {}) } };
    const next = { ...p, preset: nextPreset, patch: merged, version: p.version + 1, pending: undefined };
    try { const r = resolveChatPreset(next, undefined, clisFor(h)); setProfile(chatId, next); const fb = fallbackNote(r); await say(`✅ 编排已更新（v${next.version}，只影响新任务）：\`${presetSummary(r)}\`${fb ? `\nℹ️ ${fb}` : ""}`); }
    catch (e) { await say(`❌ 校验未通过，未生效：${(e as Error).message}`); }
    return;
  }
  try {
    if (!h.im.appendInstructions) throw new Error(`${PLATFORM_LABEL[h.im.platform]}没有群公告`);
    const rev = await h.im.appendInstructions(chatId, p.pending.paragraphs, p.pending.revision);
    setProfile(chatId, { ...p, pending: undefined });
    await say(`✅ 已写入群公告（rev ${rev}），从下一轮起对本群所有 agent 生效。`);
  } catch (e) {
    setProfile(chatId, { ...p, pending: undefined });
    await say(`❌ 写入群公告失败：${(e as Error).message}\n请重新描述一次要改的规则。`);
  }
}

/** One lead-agent turn → structured action → executed by code (`why`: the router's reason) */
export async function runLeadTurn(h: OrcChatHost, ev: ChatEvent, why?: string): Promise<void> {
  const chatId = ev.chatId;
  const say = (md: string) => h.im.sendMarkdown(chatId, md);
  const o = orcOf(h);
  bindChat(chatId, h.im);
  const p = getProfile(chatId);
  let presetLine = "";
  try { const r = resolveChatPreset(p, undefined, clisFor(h)); const fb = fallbackNote(r); presetLine = presetSummary(r) + (fb ? `（${fb}）` : ""); } catch (e) { presetLine = `（无效：${(e as Error).message}）`; }
  const threadTask = ev.rootId ? taskForCard(ev.rootId) : undefined;
  const pending = !p.pending ? undefined
    : p.pending.kind === "config" ? `调整编排 ${JSON.stringify(p.pending.patch)}`
    : `追加群公告：${p.pending.paragraphs.join(" / ")}`;
  const prompt = buildLeadPrompt({
    userText: ev.text,
    presetLine,
    workspace: h.workspaceFor(chatId),
    // open tasks of any age + ones that ended recently (or the card this reply is under); old finished
    // tasks only made the lead offer to 验收 / 停掉 things that need nothing
    tasks: o.store.listTasks({ chatId, limit: 40 })
      .filter((t) => t.id === threadTask || !["ready", "failed", "dropped"].includes(t.status) || Date.now() - t.updatedAt < 3 * 86_400_000)
      .slice(0, 8),
    presets: [...loadPresets().keys()],
    roles: [...loadRoles().keys()],
    history: formatRecent(chatId), // the lead is stateless; this is its only conversational context
    store: o.store,
    pending,
    threadTask,
    mode: p.mode,
    routeWhy: why,
  });
  const raw = await h.runLead(prompt, `${chatId}#lead`);
  const act = parseLeadAction(raw);
  // not team business after all → the single agent takes the message (it records its own turns)
  if (!("error" in act) && act.action === "chat") { await h.runSingle(ev); return; }
  recordTurn(chatId, "user", ev.text);
  if ("error" in act) {
    // 没给出可执行动作：当作普通消息交给单 agent（它看得到工作区和上下文），不把原文甩进群
    await h.runSingle(ev);
    return;
  }
  recordTurn(chatId, "lead", describeAction(act));
  if (act.action === "stop") {
    const ask = stopTargetUnclear(o, chatId, act.task, ev.text, threadTask);
    if (ask) { recordTurn(chatId, "lead", ask); await say(ask); return; }
  }
  await executeLeadAction(h, chatId, act, ev.text);
}

/**
 * Stopping kills a run and can't be undone from chat cheaply, so the target must be unambiguous:
 * the message quotes that task's card / notice, names it (#id or title), or it is the chat's only
 * open task. Otherwise ask which one (a bare 「停掉」 once stopped the running task instead of the
 * reminded one). Returns the question, or undefined when the stop may proceed.
 */
export function stopTargetUnclear(o: ReturnType<typeof orcOf>, chatId: string, taskId: number, text: string, threadTask?: number): string | undefined {
  if (threadTask === taskId) return undefined;
  const t = o.store.getTask(taskId);
  if (!t) return undefined;
  const s = (text || "").replace(/\s+/g, "");
  const norm = (x: string) => x.replace(/[\s「」『』"“”'`，,。.：:、]/g, "");
  const title = norm(t.title);
  // any 5-char run of the title counts as naming it (「停掉因果库召回那个」 → 「因果库召回与开放域覆盖对比」)
  const win = Math.min(5, title.length);
  const said = norm(s);
  const named = new RegExp(`#\\s?${taskId}\\b|任务\\s?#?${taskId}\\b`).test(text || "")
    || (title.length >= 4 && Array.from({ length: title.length - win + 1 }, (_, i) => title.slice(i, i + win)).some((w) => said.includes(w)));
  if (named) return undefined;
  const open = o.store.listTasks({ chatId, status: ["queued", "running", "waiting", "waiting_children", "blocked"], limit: 50 }).filter((x) => !x.parentId);
  if (threadTask === undefined && open.length <= 1) return undefined;
  const word = (x: Task) => (x.status === "blocked" || x.status === "waiting_children" ? "等你决定" : "进行中");
  return [
    threadTask !== undefined
      ? `你引用的是「${o.store.getTask(threadTask)?.title ?? "另一个任务"}」，但我理解成了要停「${t.title}」，先不动，确认一下要停哪个：`
      : `群里有 ${open.length} 个没结束的团队任务，没说停哪个，我先不动：`,
    ...open.slice(0, 6).map((x) => `- 「${x.title}」（${word(x)}）`),
    "",
    "引用那个任务的卡片或提醒回「停掉」，或者直接说「停掉 <任务名>」。",
  ].join("\n");
}

/** One line for the shared transcript */
export function describeAction(a: LeadAction): string {
  switch (a.action) {
    case "reply": return a.text;
    case "submit": return `（提交任务）${a.goal}${a.bar ? `\n评审口径：${a.bar}` : ""}`;
    case "attach": return `（补充给 #${a.task}${a.urgent ? "，打断" : ""}）${a.text}`;
    case "answer": return `（回答 #${a.task} 的问题）${a.option ?? ""}${a.text ? " " + a.text : ""}`;
    case "stop": return `（终止 #${a.task}）`;
    case "retry": return `（重试 #${a.task}）${a.note ?? ""}`;
    case "accept": return `（接受 #${a.task} 现在这版）${a.note ?? ""}`;
    case "config": return a.task ? `（调整 #${a.task}）${JSON.stringify({ ...a.patch, verbosity: a.verbosity })}` : `（拟调整编排）${JSON.stringify(a.patch)}`;
    case "confirm": return "（确认待定提议）";
    case "cancel": return "（放弃待定提议）";
    case "announce": return `（拟改群公告）${a.paragraphs.join(" / ")}`;
    case "remember": return `（记入记忆）${a.items.join(" / ")}`;
    case "forget": return `（删除记忆）${a.ids.join(",")}`;
    case "mode": return `（切到${MODE_LABEL[a.mode]}模式）`;
    case "chat": return "（交给单 agent）";
  }
}

/** Live change of a running loop task: role CLI / model and/or verbosity */
function configTask(h: OrcChatHost, chatId: string, act: Extract<LeadAction, { action: "config" }>): string {
  const o = orcOf(h);
  const t = o.store.getTask(act.task!);
  if (!t || t.chatId !== chatId) return "本群没有这个任务";
  if (t.kind !== "loop") return `「${t.title}」是流水线任务，运行中不能换角色；可以让我先停掉它，再用新的安排重新提交`;
  const out: string[] = [];
  const roles = act.patch.roles ?? {};
  const ignored = Object.keys(act.patch).filter((k) => k !== "roles");
  if (Object.keys(roles).length) {
    const edits: Record<string, { cli?: CliName; model?: string | null } | null> = {};
    for (const [name, v] of Object.entries(roles)) {
      edits[name] = v ? { cli: (v as any).cli, model: (v as any).model === undefined ? undefined : (v as any).model } : null;
    }
    try { out.push(`🔀 「${t.title}」${o.loop.setRoles(t.id, edits, availableClis())}`); }
    catch (e) { return `🧭 没有采纳：${(e as Error).message}`; }
  }
  if (act.verbosity) {
    o.loop.setVerbosity(t.id, act.verbosity);
    out.push(`📣 「${t.title}」播报改为 ${{ quiet: "安静（只发汇报、提问和结果）", normal: "正常（每轮一条摘要）", verbose: "详细（含指令原文和监督者分析）" }[act.verbosity]}`);
  }
  if (ignored.length) out.push(`（${ignored.join("、")} 只对新任务有效，这里没有采纳）`);
  return out.join("\n") || "没有变化";
}

export async function executeLeadAction(h: OrcChatHost, chatId: string, act: LeadAction, userText?: string): Promise<void> {
  const o = orcOf(h);
  const say = (md: string) => h.im.sendMarkdown(chatId, md);
  const p = getProfile(chatId);
  const own = (id: number) => o.store.getTask(id)?.chatId === chatId;
  const name = (id: number) => o.store.getTask(id)?.title ?? "这个任务";
  switch (act.action) {
    case "reply": await say(act.text || "（空）"); return;
    case "chat": return; // handled in runLeadTurn
    case "mode": await say(switchMode(h, chatId, p, act.mode)); return;
    case "remember":
    case "forget": {
      const ops = act.action === "remember" ? { text: "", remember: act.items, forget: [] } : { text: "", remember: [], forget: act.ids };
      await say(applyMemoryOps(chatId, ops, "lead") || (act.action === "forget" ? "没有找到这些编号的记忆。" : "没有新内容需要记录。"));
      return;
    }
    case "submit": {
      const r = await submit(h, chatId, act.goal, act.preset, { criteria: act.criteria, constraints: act.constraints, sourceText: userText, bar: act.bar, title: act.title }, "thread", act.supersedes);
      if (r) await say(`🧭 ${r}`);
      return;
    }
    case "stop": await say(own(act.task) && o.stop(act.task) ? `🛑 「${name(act.task)}」已终止` : `「${name(act.task)}」无法终止`); return;
    case "retry": {
      const went = own(act.task) ? o.continueTask(act.task, act.note, ownCli(h)) : [];
      await say(went.length ? `🔁 ${went.map((x) => `「${x}」`).join("、")}接着跑了` : `「${name(act.task)}」当前状态不能重试`);
      return;
    }
    case "accept": {
      const t = own(act.task) ? o.store.getTask(act.task) : undefined;
      const st = t && acceptable(t);
      if (!t || !st || !o.accept(act.task, act.note)) { await say(`「${name(act.task)}」现在没有卡在评审 / 测试上，没法「接受」`); return; }
      const next = t.preset.stages[t.stageIdx + 1];
      await say(next ? `✅ 「${t.title}」接受现在这版，跳过这次${stageName(st.id)}，继续${stageName(next.id)}` : `✅ 「${t.title}」接受现在这版，任务完成`);
      return;
    }
    case "attach": {
      const ok = own(act.task) && o.attach(act.task, act.text, act.urgent, userText, ownCli(h));
      await say(ok ? (act.urgent ? `⚡ 已打断「${name(act.task)}」，带着你的补充续接原会话重跑` : `📎 已把补充交给「${name(act.task)}」，下一轮生效`) : `「${name(act.task)}」不在进行中`);
      return;
    }
    case "answer": {
      if (!own(act.task)) { await say("本群没有这个任务"); return; }
      const t = o.store.getTask(act.task)!;
      // a pipeline (or a parent waiting on children) has no question to answer: 「继续」 means re-run what is stuck
      if (t.kind !== "loop" || !o.loop.ledger(t.id)?.pendingAsk) {
        const went = o.continueTask(act.task, [act.option, act.text].filter(Boolean).join(" ") || userText, ownCli(h));
        await say(went.length ? `🔁 ${went.map((x) => `「${x}」`).join("、")}接着跑了` : `「${t.title}」现在没有卡住等人的地方`);
        return;
      }
      await say(o.loop.answer(act.task, act.option, act.text, userText, ownCli(h)));
      return;
    }
    case "confirm": await confirmPending(h, chatId); return;
    case "cancel": {
      setProfile(chatId, { ...p, pending: undefined });
      await say(p.pending ? "已放弃待确认的变更。" : "没有待确认的变更。");
      return;
    }
    case "config": {
      if (act.task) { await say(configTask(h, chatId, act)); return; }
      try {
        const before = resolveChatPreset(p, undefined, clisFor(h));
        const after = resolveChatPreset(p, act.patch, clisFor(h));
        setProfile(chatId, { ...p, pending: { kind: "config", patch: act.patch } });
        await say(`🧭 拟调整编排${act.reason ? `（${act.reason}）` : ""}：\n${describePresetChange(before, after)}\n\n回复「确认」生效（只影响新任务），「算了」放弃。`);
      } catch (e) {
        await say(`🧭 这个调整不合法，没有采纳：${(e as Error).message}`);
      }
      return;
    }
    case "announce": {
      if (!h.im.appendInstructions || !h.im.instructionsRevision) {
        await say(`🧭 ${PLATFORM_LABEL[h.im.platform]}没有群公告。想让本群一直遵守，可以说「记住：${act.paragraphs[0] ?? "…"}」，存进本群记忆。`);
        return;
      }
      try {
        const revision = await h.im.instructionsRevision(chatId);
        setProfile(chatId, { ...p, pending: { kind: "announce", paragraphs: act.paragraphs, revision } });
        await say(`🧭 拟在群公告（=本群长期指令）末尾追加${act.reason ? `（${act.reason}）` : ""}：\n${act.paragraphs.map((x) => `> ${x}`).join("\n")}\n\n回复「确认」写入，「算了」放弃。`);
      } catch (e) {
        await say(`🧭 读不到本群公告，无法修改：${(e as Error).message}`);
      }
      return;
    }
  }
}
