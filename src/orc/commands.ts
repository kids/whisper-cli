// =============================================================================
// orc chat commands + lead-agent turn (kept out of agent-runner.ts)
// =============================================================================
// Users normally just talk: src/orc/route.ts decides per message whether the
// single agent or the lead agent handles it. These commands are the fallback:
//   /mode [auto | single | orc [preset]]  how this chat routes messages
//   /orc                              current orchestration + presets
//   /orc preset <name> | reset        change / clear this chat's orchestration
//   /orc confirm | cancel             apply / drop the lead agent's pending proposal
//   /task <goal>                      submit to orc (any mode)
//   /task <id> | stop|retry|attach <id> …
//   /tasks                            this chat's tasks
// A lead turn only picks an action; the code below executes it (002 §2.3).
// =============================================================================
import { larkOf } from "../platform/feishu";
import { PLATFORM_LABEL, type ChatEvent, type ImClient } from "../platform/types";
import type { AgentConfig } from "../types";
import { appendAnnouncementText, fetchAnnouncement } from "../announcement";
import { applyMemoryOps } from "../memory";
import { formatRecent, recordTurn } from "../recent";
import { loadPresets, loadRoles, presetSummary } from "./config";
import {
  availableClis, buildLeadPrompt, describePresetChange, getOrc, getProfile, listPresetSummaries, parseLeadAction,
  renderCard, resolveChatPreset, setProfile, submitFromChat, bindChat, taskForCard, type ChatProfile, type LeadAction,
} from "./chat";
import { MODE_LABEL, type ChatMode, type TaskOp } from "./route";
import type { ExecutorBins } from "./runner";
import type { CliName } from "./types";
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

const MODE_DESC: Record<ChatMode, string> = {
  auto: "自动：普通对话交给单 agent，需要团队的事（或说到进行中的任务）交给主 agent",
  single: "单 agent：只用单 agent；任务卡片回复串和待你回答的问题仍会交给主 agent",
  orc: "编排：每条消息都先经过主 agent，要动手的事都交给团队",
};

/** Switch the chat's mode; returns the message to post */
function switchMode(h: OrcChatHost, chatId: string, p: ChatProfile, want: ChatMode, preset?: string): string {
  const next: ChatProfile = { ...p, mode: want, ...(preset ? { preset, patch: {} } : {}) };
  if (want !== "single" || preset) {
    try { resolveChatPreset(next, undefined, availableClis().length ? availableClis() : undefined); }
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
  const r = await submit(h, chatId, op.goal, op.preset, { criteria: op.criteria, constraints: op.constraints, sourceText });
  return r.startsWith("❌") ? `⚠️ 没有转交团队：${r.replace(/^❌\s*/, "")}` : `🧭 ${r}`;
}

async function submit(
  h: OrcChatHost, chatId: string, goal: string, presetName?: string,
  extra: { criteria?: string[]; constraints?: string[]; sourceText?: string } = {},
): Promise<string> {
  const o = orcOf(h);
  const repo = repoRoot(h.workspaceFor(chatId));
  if (!repo) return `❌ 当前工作区 \`${h.workspaceFor(chatId)}\` 不是 git 仓库，团队任务要用 git worktree 隔离各人的改动。先用 \`/工作区 <路径或项目名>\` 切到一个 git 仓库（也可以说「把工作目录切到 …」）。`;
  const profile = getProfile(chatId);
  let preset;
  try {
    preset = resolveChatPreset(presetName ? { ...profile, preset: presetName, patch: {} } : profile, undefined, availableClis());
  } catch (e) {
    return `❌ 编排无效：${(e as Error).message}`;
  }
  const t = await submitFromChat(o, h.im, chatId, goal, repo, preset, extra);
  const crit = preset.kind === "loop" && extra.criteria?.length ? `\n验收标准：${extra.criteria.map((c, i) => `C${i + 1} ${c}`).join("；")}` : "";
  return `已提交 #${t.id} → \`${presetSummary(preset)}\`\n仓库 \`${repo}\`${crit}`;
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
      let cur = "";
      try { cur = presetSummary(resolveChatPreset(p)); } catch (e) { cur = `⚠️ ${(e as Error).message}`; }
      await say([`**当前编排**（v${p.version}）：\`${cur}\``, p.pending ? `\n有待确认的变更：回复「确认」生效，「算了」放弃` : "", "", "**可选组合：**", ...listPresetSummaries(), "", "想换组合或调整角色，直接说即可（例如「以后评审用 claude」）"].join("\n"));
      return true;
    }
    if (sub === "preset" && m[2]) {
      const next = { ...p, preset: m[2], patch: {}, version: p.version + 1, pending: undefined };
      try { const r = resolveChatPreset(next); setProfile(chatId, next); await say(`已切换编排：\`${presetSummary(r)}\`（只影响之后的新任务）`); }
      catch (e) { await say(`❌ ${(e as Error).message}`); }
      return true;
    }
    if (sub === "reset") { setProfile(chatId, { ...p, patch: {}, version: p.version + 1, pending: undefined }); await say("已清除本群对编排的调整。"); return true; }
    if (sub === "cancel") { setProfile(chatId, { ...p, pending: undefined }); await say("已放弃待确认的变更。"); return true; }
    if (sub === "confirm") { await confirmPending(h, chatId); return true; }
    return false;
  }

  if (/^\/tasks\s*$/i.test(text)) {
    const ts = orcOf(h).store.listTasks({ chatId, limit: 15 });
    await say(ts.length ? ts.map((t) => `- #${t.id} [${t.status}] ${t.title} —— ${t.progress}`).join("\n") : "本群还没有团队任务。想交给团队做，直接说「这个交给团队做」即可。");
    return true;
  }

  m = text.match(/^\/task(?:\s+([\s\S]+))?$/i);
  if (m) {
    const arg = (m[1] || "").trim();
    const o = orcOf(h);
    bindChat(chatId, h.im);
    if (!arg) { await say("用法：`/task <目标>` 提交；`/task <id>` 查看；`/task stop|retry|attach <id> …`"); return true; }
    const sm = arg.match(/^(stop|retry|attach)\s+#?(\d+)\s*([\s\S]*)$/i);
    if (sm) {
      const id = Number(sm[2]);
      const verb = sm[1].toLowerCase();
      const ok = verb === "stop" ? o.stop(id) : verb === "retry" ? o.retry(id, sm[3] || undefined) : o.attach(id, sm[3], false);
      await say(ok ? `#${id} ${verb === "stop" ? "已终止" : verb === "retry" ? "已重新排队" : "补充已排队，下一轮交给 agent"}` : `#${id} 当前状态不支持 ${verb}`);
      return true;
    }
    if (/^#?\d+$/.test(arg)) {
      const t = o.store.getTask(Number(arg.replace("#", "")));
      await say(t ? renderCard(t, o.store) + (t.feedback ? `\n\n**待处理反馈**\n${t.feedback}` : "") : `没有任务 ${arg}`);
      return true;
    }
    await say(await submit(h, chatId, arg));
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
    try { const r = resolveChatPreset(next, undefined, availableClis()); setProfile(chatId, next); await say(`✅ 编排已更新（v${next.version}，只影响新任务）：\`${presetSummary(r)}\``); }
    catch (e) { await say(`❌ 校验未通过，未生效：${(e as Error).message}`); }
    return;
  }
  try {
    const lark = larkOf(h.im);
    if (!lark) throw new Error("群公告只有飞书支持");
    const rev = await appendAnnouncementText(lark, chatId, p.pending.paragraphs, p.pending.revision);
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
  try { presetLine = presetSummary(resolveChatPreset(p)); } catch (e) { presetLine = `（无效：${(e as Error).message}）`; }
  const threadTask = ev.rootId ? taskForCard(ev.rootId) : undefined;
  const pending = !p.pending ? undefined
    : p.pending.kind === "config" ? `调整编排 ${JSON.stringify(p.pending.patch)}`
    : `追加群公告：${p.pending.paragraphs.join(" / ")}`;
  const prompt = buildLeadPrompt({
    userText: ev.text,
    presetLine,
    tasks: o.store.listTasks({ chatId, limit: 8 }),
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
    recordTurn(chatId, "lead", raw);
    await say(`🧭 ${raw.trim().slice(0, 1500) || act.error}`);
    return;
  }
  recordTurn(chatId, "lead", describeAction(act));
  await executeLeadAction(h, chatId, act, ev.text);
}

/** One line for the shared transcript */
export function describeAction(a: LeadAction): string {
  switch (a.action) {
    case "reply": return a.text;
    case "submit": return `（提交任务）${a.goal}`;
    case "attach": return `（补充给 #${a.task}${a.urgent ? "，打断" : ""}）${a.text}`;
    case "answer": return `（回答 #${a.task} 的问题）${a.option ?? ""}${a.text ? " " + a.text : ""}`;
    case "status": return `（查询状态${a.task ? " #" + a.task : ""}）`;
    case "stop": return `（终止 #${a.task}）`;
    case "retry": return `（重试 #${a.task}）${a.note ?? ""}`;
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
  if (!t || t.chatId !== chatId) return `本群没有任务 #${act.task}`;
  if (t.kind !== "loop") return `#${t.id} 是流水线任务，运行中不能换角色；可以让我先停掉它，再用新的安排重新提交`;
  const out: string[] = [];
  const roles = act.patch.roles ?? {};
  const ignored = Object.keys(act.patch).filter((k) => k !== "roles");
  if (Object.keys(roles).length) {
    const edits: Record<string, { cli?: CliName; model?: string | null } | null> = {};
    for (const [name, v] of Object.entries(roles)) {
      edits[name] = v ? { cli: (v as any).cli, model: (v as any).model === undefined ? undefined : (v as any).model } : null;
    }
    try { out.push(`🔀 #${t.id} ${o.loop.setRoles(t.id, edits, availableClis())}`); }
    catch (e) { return `🧭 没有采纳：${(e as Error).message}`; }
  }
  if (act.verbosity) {
    o.loop.setVerbosity(t.id, act.verbosity);
    out.push(`📣 #${t.id} 播报改为 ${{ quiet: "安静（只发汇报、提问和结果）", normal: "正常（每轮一条摘要）", verbose: "详细（含指令原文和监督者分析）" }[act.verbosity]}`);
  }
  if (ignored.length) out.push(`（${ignored.join("、")} 只对新任务有效，这里没有采纳）`);
  return out.join("\n") || "没有变化";
}

export async function executeLeadAction(h: OrcChatHost, chatId: string, act: LeadAction, userText?: string): Promise<void> {
  const o = orcOf(h);
  const say = (md: string) => h.im.sendMarkdown(chatId, md);
  const p = getProfile(chatId);
  const own = (id: number) => o.store.getTask(id)?.chatId === chatId;
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
    case "submit": await say(`🧭 ${await submit(h, chatId, act.goal, act.preset, { criteria: act.criteria, constraints: act.constraints, sourceText: userText })}`); return;
    case "status": {
      const ts = act.task ? [o.store.getTask(act.task)].filter((t): t is NonNullable<typeof t> => !!t && t.chatId === chatId) : o.store.listTasks({ chatId, limit: 5 });
      await say(ts.length ? ts.map((t) => renderCard(t, o.store)).join("\n\n---\n\n") : "本群没有相关任务。");
      return;
    }
    case "stop": await say(own(act.task) && o.stop(act.task) ? `🛑 #${act.task} 已终止` : `#${act.task} 无法终止`); return;
    case "retry": await say(own(act.task) && o.retry(act.task, act.note) ? `🔁 #${act.task} 已重新排队` : `#${act.task} 当前状态不能重试`); return;
    case "attach": {
      const ok = own(act.task) && o.attach(act.task, act.text, act.urgent, userText);
      await say(ok ? (act.urgent ? `⚡ 已打断 #${act.task}，带着你的补充续接原会话重跑` : `📎 已把补充交给 #${act.task}，下一轮生效`) : `#${act.task} 不在进行中`);
      return;
    }
    case "answer": {
      if (!own(act.task)) { await say(`本群没有任务 #${act.task}`); return; }
      await say(o.loop.answer(act.task, act.option, act.text, userText));
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
        const before = resolveChatPreset(p);
        const after = resolveChatPreset(p, act.patch, availableClis());
        setProfile(chatId, { ...p, pending: { kind: "config", patch: act.patch } });
        await say(`🧭 拟调整编排${act.reason ? `（${act.reason}）` : ""}：\n${describePresetChange(before, after)}\n\n回复「确认」生效（只影响新任务），「算了」放弃。`);
      } catch (e) {
        await say(`🧭 这个调整不合法，没有采纳：${(e as Error).message}`);
      }
      return;
    }
    case "announce": {
      const lark = larkOf(h.im);
      if (!lark) {
        await say(`🧭 ${PLATFORM_LABEL[h.im.platform]}没有群公告。想让本群一直遵守，可以说「记住：${act.paragraphs[0] ?? "…"}」，存进本群记忆。`);
        return;
      }
      try {
        const snap = await fetchAnnouncement(lark, chatId);
        setProfile(chatId, { ...p, pending: { kind: "announce", paragraphs: act.paragraphs, revision: snap.revisionId } });
        await say(`🧭 拟在群公告（=本群长期指令）末尾追加${act.reason ? `（${act.reason}）` : ""}：\n${act.paragraphs.map((x) => `> ${x}`).join("\n")}\n\n回复「确认」写入，「算了」放弃。`);
      } catch (e) {
        await say(`🧭 读不到本群公告，无法修改：${(e as Error).message}`);
      }
      return;
    }
  }
}
