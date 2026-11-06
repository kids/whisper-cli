// =============================================================================
// orc chat commands + lead-agent turn (kept out of agent-runner.ts)
// =============================================================================
//   /mode [single | orc [preset]]     switch this chat's agent mode
//   /orc                              current orchestration + presets
//   /orc preset <name> | reset        change / clear this chat's orchestration
//   /orc confirm | cancel             apply / drop the lead agent's pending proposal
//   /task <goal>                      submit to orc (any mode)
//   /task <id> | stop|retry|attach <id> …
//   /tasks                            this chat's tasks
// In mode=orc every other message goes to the lead agent, which only picks an
// action; the code below executes it (002 §2.3).
// =============================================================================
import type { FeishuClient, FeishuMessageEvent } from "../platform/feishu";
import type { AgentConfig } from "../types";
import { appendAnnouncementText, fetchAnnouncement } from "../announcement";
import { loadPresets, loadRoles, presetSummary } from "./config";
import {
  availableClis, buildLeadPrompt, describePresetChange, getOrc, getProfile, listPresetSummaries, parseLeadAction,
  renderCard, resolveChatPreset, setProfile, submitFromChat, bindChat, type LeadAction,
} from "./chat";
import type { ExecutorBins } from "./runner";
import { repoRoot } from "./worktree";

export interface OrcChatHost {
  feishu: FeishuClient;
  agents: AgentConfig[];
  bins: ExecutorBins;
  workspaceFor(chatId: string): string;
  /** One LLM turn for the lead agent (goes through the bot's own CLI + group announcement) */
  runLead(prompt: string, sessionKey: string): Promise<string>;
}

const orcOf = (h: OrcChatHost) => getOrc(h.agents, h.bins);

async function submit(h: OrcChatHost, chatId: string, goal: string, presetName?: string): Promise<string> {
  const o = orcOf(h);
  const repo = repoRoot(h.workspaceFor(chatId));
  if (!repo) return `❌ 当前工作区 \`${h.workspaceFor(chatId)}\` 不是 git 仓库，orc 需要 git worktree 做隔离。先用 \`项目名:指令\` 切到一个仓库。`;
  const profile = getProfile(chatId);
  let preset;
  try {
    preset = resolveChatPreset(presetName ? { ...profile, preset: presetName, patch: {} } : profile, undefined, availableClis());
  } catch (e) {
    return `❌ 编排无效：${(e as Error).message}`;
  }
  const t = await submitFromChat(o, h.feishu, chatId, goal, repo, preset);
  return `已提交 #${t.id} → \`${presetSummary(preset)}\`\n仓库 \`${repo}\``;
}

export async function handleOrcCommand(h: OrcChatHost, ev: FeishuMessageEvent): Promise<boolean> {
  const text = ev.text.trim();
  const chatId = ev.chatId;
  const say = (md: string) => h.feishu.sendMarkdown(chatId, md);

  let m = text.match(/^\/(mode|模式)(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
  if (m) {
    const p = getProfile(chatId);
    const want = (m[2] || "").toLowerCase();
    if (!want) {
      await say(`当前模式：\`${p.mode}\`${p.mode === "orc" ? `（${p.preset}）` : ""}\n用法：\`/mode single\` 单 agent；\`/mode orc [组合]\` 由主 agent 分派给多 agent 编排`);
      return true;
    }
    if (want !== "single" && want !== "orc") { await say("用法：`/mode single` 或 `/mode orc [组合]`"); return true; }
    const next = { ...p, mode: want as "single" | "orc", ...(m[3] ? { preset: m[3], patch: {} } : {}) };
    if (want === "orc") {
      try { resolveChatPreset(next, undefined, availableClis().length ? availableClis() : undefined); }
      catch (e) { await say(`❌ ${(e as Error).message}`); return true; }
      orcOf(h); bindChat(chatId, h.feishu);
    }
    setProfile(chatId, next);
    await say(want === "orc"
      ? `🧭 已切到 orc 模式（\`${next.preset}\`）。直接说要做什么，主 agent 会分派；进行中的任务有进展卡片。\`/mode single\` 切回。`
      : `💬 已切回单 agent 模式。后台 orc 任务会继续跑，结果照常通知。`);
    return true;
  }

  m = text.match(/^\/orc(?:\s+(\S+))?(?:\s+(\S+))?\s*$/i);
  if (m) {
    const p = getProfile(chatId);
    const sub = (m[1] || "").toLowerCase();
    if (!sub) {
      let cur = "";
      try { cur = presetSummary(resolveChatPreset(p)); } catch (e) { cur = `⚠️ ${(e as Error).message}`; }
      await say([`**当前编排**（v${p.version}）：\`${cur}\``, p.pending ? `\n有待确认的变更：\`/orc confirm\` 生效，\`/orc cancel\` 放弃` : "", "", "**可选组合：**", ...listPresetSummaries(), "", "`/orc preset <名>` 切换；`/orc reset` 清除本群调整"].join("\n"));
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
    await say(ts.length ? ts.map((t) => `- #${t.id} [${t.status}] ${t.title} —— ${t.progress}`).join("\n") : "本群还没有 orc 任务。`/task <目标>` 提交。");
    return true;
  }

  m = text.match(/^\/task(?:\s+([\s\S]+))?$/i);
  if (m) {
    const arg = (m[1] || "").trim();
    const o = orcOf(h);
    bindChat(chatId, h.feishu);
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
  const say = (md: string) => h.feishu.sendMarkdown(chatId, md);
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
    const rev = await appendAnnouncementText(h.feishu.getClient(), chatId, p.pending.paragraphs, p.pending.revision);
    setProfile(chatId, { ...p, pending: undefined });
    await say(`✅ 已写入群公告（rev ${rev}），从下一轮起对本群所有 agent 生效。`);
  } catch (e) {
    setProfile(chatId, { ...p, pending: undefined });
    await say(`❌ 写入群公告失败：${(e as Error).message}\n请重新描述一次要改的规则。`);
  }
}

/** mode=orc: one lead-agent turn → structured action → executed by code */
export async function runLeadTurn(h: OrcChatHost, ev: FeishuMessageEvent): Promise<void> {
  const chatId = ev.chatId;
  const say = (md: string) => h.feishu.sendMarkdown(chatId, md);
  const o = orcOf(h);
  bindChat(chatId, h.feishu);
  const p = getProfile(chatId);
  let presetLine = "";
  try { presetLine = presetSummary(resolveChatPreset(p)); } catch (e) { presetLine = `（无效：${(e as Error).message}）`; }
  const prompt = buildLeadPrompt({
    userText: ev.text,
    presetLine,
    tasks: o.store.listTasks({ chatId, limit: 8 }),
    presets: [...loadPresets().keys()],
    roles: [...loadRoles().keys()],
  });
  const raw = await h.runLead(prompt, `${chatId}#lead`);
  const act = parseLeadAction(raw);
  if ("error" in act) {
    await say(`🧭 ${raw.trim().slice(0, 1500) || act.error}`);
    return;
  }
  await executeLeadAction(h, chatId, act);
}

export async function executeLeadAction(h: OrcChatHost, chatId: string, act: LeadAction): Promise<void> {
  const o = orcOf(h);
  const say = (md: string) => h.feishu.sendMarkdown(chatId, md);
  const p = getProfile(chatId);
  switch (act.action) {
    case "reply": await say(act.text || "（空）"); return;
    case "submit": await say(`🧭 ${await submit(h, chatId, act.goal, act.preset)}`); return;
    case "status": {
      const ts = act.task ? [o.store.getTask(act.task)].filter((t): t is NonNullable<typeof t> => !!t && t.chatId === chatId) : o.store.listTasks({ chatId, limit: 5 });
      await say(ts.length ? ts.map((t) => renderCard(t, o.store)).join("\n\n---\n\n") : "本群没有相关任务。");
      return;
    }
    case "stop": await say(o.stop(act.task) ? `🛑 #${act.task} 已终止` : `#${act.task} 无法终止`); return;
    case "retry": await say(o.retry(act.task, act.note) ? `🔁 #${act.task} 已重新排队` : `#${act.task} 当前状态不能重试`); return;
    case "attach": {
      const ok = o.attach(act.task, act.text, act.urgent);
      await say(ok ? (act.urgent ? `⚡ 已打断 #${act.task}，带着你的补充续接原会话重跑` : `📎 已把补充交给 #${act.task}，下一轮生效`) : `#${act.task} 不在进行中`);
      return;
    }
    case "config": {
      try {
        const before = resolveChatPreset(p);
        const after = resolveChatPreset(p, act.patch, availableClis());
        setProfile(chatId, { ...p, pending: { kind: "config", patch: act.patch } });
        await say(`🧭 拟调整编排${act.reason ? `（${act.reason}）` : ""}：\n${describePresetChange(before, after)}\n\n回复 \`/orc confirm\` 生效（只影响新任务），\`/orc cancel\` 放弃。`);
      } catch (e) {
        await say(`🧭 这个调整不合法，没有采纳：${(e as Error).message}`);
      }
      return;
    }
    case "announce": {
      try {
        const snap = await fetchAnnouncement(h.feishu.getClient(), chatId);
        setProfile(chatId, { ...p, pending: { kind: "announce", paragraphs: act.paragraphs, revision: snap.revisionId } });
        await say(`🧭 拟在群公告（=本群长期指令）末尾追加${act.reason ? `（${act.reason}）` : ""}：\n${act.paragraphs.map((x) => `> ${x}`).join("\n")}\n\n回复 \`/orc confirm\` 写入，\`/orc cancel\` 放弃。`);
      } catch (e) {
        await say(`🧭 读不到本群公告，无法修改：${(e as Error).message}`);
      }
      return;
    }
  }
}
