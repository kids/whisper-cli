// =============================================================================
// Agent Runner — orchestrates one (Platform + AI CLI) pair
// Merges feishu-cursor features: admin console, projects routing, /review, attachments
// =============================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, AiResult, CumulativeUsage, AgentState } from "./types";
import { emptyCumulativeUsage } from "./types";
import { FeishuClient, buildPromptWithAttachments, type FeishuMessageEvent } from "./platform/feishu";
import {
  runCodebuddy,
  stopCodebuddyRun,
  clearCodebuddySession,
  setCodebuddySession,
  getCodebuddySession,
  queryCodebuddyModels,
} from "./ai/codebuddy";
import {
  runCursor,
  stopCursorRun,
  clearCursorSession,
  setCursorSession,
  getCursorSession,
} from "./ai/cursor";
import {
  runCodex,
  stopCodexRun,
  clearCodexSession,
  setCodexSession,
  getCodexSession,
  getCodexDefaultModel,
} from "./ai/codex";
import {
  runClaude,
  stopClaudeRun,
  clearClaudeSession,
  setClaudeSession,
  getClaudeSession,
  CLAUDE_MODEL_ALIASES,
} from "./ai/claude";
import {
  runGemini,
  stopGeminiRun,
  clearGeminiSession,
  setGeminiSession,
  getGeminiSession,
  GEMINI_MODEL_ALIASES,
} from "./ai/gemini";
import {
  runPi,
  stopPiRun,
  clearPiSession,
  setPiSession,
  getPiSession,
} from "./ai/pi";
import { getProjects, loadProjects, routePrompt, watchProjects } from "./projects";
import { getChatInstructions } from "./announcement";
import { applyMemoryOps, chatOf, extractMemoryOps, formatMemory, joinInstructions, memoryCommand } from "./memory";
import { handleOrcCommand, runLeadTurn, submitTaskOp, type OrcChatHost } from "./orc/commands";
import { activeTaskSummary, getOrc, getProfile, hasOrcState, registerBot, routeContext, stopChatTasks, taskForCard } from "./orc/chat";
import { extractTaskOps, formatTaskHint, routeMessage } from "./orc/route";
import { flushRecent, recordTurn } from "./recent";
import { extractSendOps, formatSendHint, resolveOutgoing, sendRoots } from "./outgoing";
import {
  addWatch, buildWakePrompt, cancelWatch, describeSpec, extractWatchOps, formatWatchContext, getWatch, listWatches,
  parseWatchSpec, registerWatchHost, renderWatchCard, startWatches, tickWatches, updateWatch, watchCommandKind,
  type CheckResult, type Watch,
} from "./watch";
import { loadAllAgents } from "./config";

/** Tools denied to read-only runs (orc lead agent); Bash too, since it can write */
const READ_ONLY_DENY = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"];
import {
  buildReviewPrompt,
  parseReviewCommand,
  wrapWithProjectPrompt,
  wrapWithWorkspaceHint,
} from "./prompt";
import { collectSysStatus } from "./sys-status";
import {
  addTask,
  archiveTask,
  findTask,
  formatRelativeTime,
  getStore,
  getTaskByChatId,
  isAdminChat,
  listTasks,
  setAdminChat,
  setAdminOpenId,
  titleFromPrompt,
  updateTaskSession,
} from "./tasks";

// ---------------------------------------------------------------------------
// Serial queue — per chat (replaces busy lock; messages queue up)
// ---------------------------------------------------------------------------

const CHAT_QUEUES = new Map<string, Promise<void>>();
function enqueue(chatId: string, task: () => Promise<void>): void {
  const prev = CHAT_QUEUES.get(chatId) ?? Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(task)
    .catch((e) => console.error("[queue] task error:", e))
    .finally(() => {
      if (CHAT_QUEUES.get(chatId) === next) CHAT_QUEUES.delete(chatId);
    });
  CHAT_QUEUES.set(chatId, next);
}

// ---------------------------------------------------------------------------
// Session store — per agent (chat_id -> thread/session_id)
// ---------------------------------------------------------------------------

const sessions = new Map<string, string>();
const models = new Map<string, string>();
const cumUsage = new Map<string, CumulativeUsage>();
/** Per-chat workspace override from projects.json routing / task registration */
const chatWorkspace = new Map<string, { workspace: string; label: string }>();

// ---------------------------------------------------------------------------
// Agent state persistence
// ---------------------------------------------------------------------------

/** Push chat→session into the AI module Map that runXxx actually reads. */
function pushSessionToAi(aiCli: AgentConfig["aiCli"], chatId: string, sid: string): void {
  if (aiCli === "codebuddy") setCodebuddySession(chatId, sid);
  else if (aiCli === "cursor") setCursorSession(chatId, sid);
  else if (aiCli === "codex") setCodexSession(chatId, sid);
  else if (aiCli === "claude") setClaudeSession(chatId, sid);
  else if (aiCli === "gemini") setGeminiSession(chatId, sid);
  else if (aiCli === "pi") setPiSession(chatId, sid);
}

/**
 * Record sessionId in agent-runner's sessions Map (what writeStateNow persists)
 * and mirror it into the AI module Map (what the next run resumes from).
 */
function rememberSession(
  aiCli: AgentConfig["aiCli"],
  chatId: string,
  sid: string,
  opts?: { persist?: boolean },
): void {
  sessions.set(chatId, sid);
  pushSessionToAi(aiCli, chatId, sid);
  if (opts?.persist !== false) scheduleSave();
}

function loadAgentState(statePath: string): Record<string, string> {
  if (!existsSync(statePath)) return {};
  try {
    const data: AgentState = JSON.parse(readFileSync(statePath, "utf8"));
    const loadedSessions = data?.sessions ?? {};
    if (data?.sessions) {
      for (const [k, v] of Object.entries(data.sessions)) sessions.set(k, v);
    }
    if (data?.models) {
      for (const [k, v] of Object.entries(data.models)) models.set(k, v);
    }
    if (data?.tokens) {
      for (const [k, v] of Object.entries(data.tokens)) cumUsage.set(k, v);
    }
    console.log(`[state] loaded ${Object.keys(loadedSessions).length} sessions, ${models.size} models, ${cumUsage.size} usage records`);
    return loadedSessions;
  } catch (e) {
    console.error(`[state] failed to load ${statePath}:`, e);
    return {};
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let currentStatePath = "";
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStateNow();
  }, 300);
}

function writeStateNow(): void {
  if (!currentStatePath) return;
  const payload: AgentState = {
    sessions: Object.fromEntries(sessions),
    models: Object.fromEntries(models),
    tokens: Object.fromEntries(cumUsage),
    savedAt: new Date().toISOString(),
  };
  const tmp = currentStatePath + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf8");
    renameSync(tmp, currentStatePath);
  } catch (e) {
    console.error(`[state] failed to write ${currentStatePath}:`, e);
  }
}

function flushState(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  writeStateNow();
}

// ---------------------------------------------------------------------------
// Usage footer — per-turn + cumulative
// ---------------------------------------------------------------------------

function formatUsageFooter(
  chatId: string,
  model: string | null,
  usage: NonNullable<AiResult["usage"]>,
): string {
  const turnTotal = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0);
  if (turnTotal === 0) return "";

  const cum = cumUsage.get(chatId) ?? emptyCumulativeUsage();
  cum.inputTokens += usage.inputTokens;
  cum.outputTokens += usage.outputTokens;
  cum.cacheReadTokens += usage.cacheReadTokens || 0;
  cum.cacheWriteTokens += usage.cacheWriteTokens || 0;
  cum.turns += 1;
  cumUsage.set(chatId, cum);
  scheduleSave();

  const fmt = (n: number) => n.toLocaleString("en-US");
  const cumTotal = cum.inputTokens + cum.outputTokens + cum.cacheReadTokens + cum.cacheWriteTokens;

  const parts: string[] = [`\`${model || "default"}\``];
  let turnStr = `🎫 本轮 ${fmt(turnTotal)} tokens`;
  const detail: string[] = [];
  if (usage.inputTokens) detail.push(`↑${fmt(usage.inputTokens)}`);
  if (usage.outputTokens) detail.push(`↓${fmt(usage.outputTokens)}`);
  if (usage.cacheReadTokens) detail.push(`⚡命中${fmt(usage.cacheReadTokens)}`);
  if (detail.length) turnStr += `（${detail.join(" ")}）`;
  parts.push(turnStr);
  parts.push(`📊 累计 ${fmt(cumTotal)} tokens / ${cum.turns} 条`);

  return `\n\n---\n${parts.join("  ·  ")}`;
}

function isStopCommand(text: string): boolean {
  return /^\/(stop|cancel|停止|终止|中止|abort)\s*$/i.test(text.trim());
}

// ---------------------------------------------------------------------------
// Agent runner class
// ---------------------------------------------------------------------------

export interface AgentBins {
  codebuddyBin?: string;
  cursorAgentBin?: string;
  codexBin?: string;
  claudeBin?: string;
  geminiBin?: string;
  piBin?: string;
}

export class AgentRunner {
  private config: AgentConfig;
  private feishu?: FeishuClient;
  private workdir: string;
  private bins: AgentBins;
  private statePath: string;

  constructor(
    config: AgentConfig,
    workdir: string,
    bins: AgentBins = {},
    stateDir?: string,
  ) {
    this.config = config;
    this.workdir = workdir;
    this.bins = bins;
    this.statePath = resolve(
      stateDir || workdir,
      `state_${config.index}.json`,
    );

    currentStatePath = this.statePath;
    // Load into agent-runner Maps, then hydrate AI module Maps (codex threads / cursor sessions / …)
    const loadedSessions = loadAgentState(this.statePath);
    for (const [chatId, sid] of Object.entries(loadedSessions)) {
      pushSessionToAi(config.aiCli, chatId, sid);
    }
    currentStatePath = "";

    if (config.adminChatId) setAdminChat(config.adminChatId);

    // Hydrate chatWorkspace from registered tasks; also backfill session if state file lacked it
    for (const t of listTasks(true)) {
      chatWorkspace.set(t.chatId, { workspace: t.workspace, label: t.projectLabel });
      if (t.cursorSessionId) {
        rememberSession(config.aiCli, t.chatId, t.cursorSessionId, { persist: false });
      }
    }
  }

  async start(): Promise<void> {
    const { platform } = this.config;

    loadProjects();
    watchProjects(() => console.log(`[${this.label}] projects.json reloaded`));

    if (platform === "feishu") {
      if (!this.config.feishu) throw new Error("Missing Feishu config");
      this.feishu = new FeishuClient(this.config.feishu);
      this.feishu.onMessage(this.handleMessage.bind(this));
      this.feishu.start();
      console.log(`[${this.label}] Feishu started (appId=${this.config.feishu.appId.slice(0, 10)}..., adminMode=${!!this.config.adminMode})`);
      // orc: let cards/notifications reach chats after a restart, and resume left-over tasks
      // without waiting for someone to touch orc first
      registerBot(this.config.name, this.feishu);
      // long-running work: probe on a timer, update cards, wake the agent when something happens
      registerWatchHost(this.config.name, {
        card: async (w) => { if (w.cardId) await this.feishu?.updateCardMessage(w.cardId, renderWatchCard(w)); },
        fire: (w, r) => this.onWatchFire(w, r),
      });
      startWatches();
      if (hasOrcState()) {
        const h = this.orcHost();
        try { getOrc(h.agents, h.bins); } catch (e) { console.warn(`[orc] resume failed: ${(e as Error).message}`); }
      }

      if (this.config.adminMode) {
        const adminChat = this.config.adminChatId || getStore().adminChatId;
        if (adminChat) {
          setTimeout(() => {
            this.feishu?.sendMarkdown(adminChat, [
              `**${this.config.name} 已上线**`,
              "私聊发 `/帮助` 或 `/新任务 测试`",
              "工作群内直接对话；`/review` 审视上一轮；`/stop` 终止",
            ].join("\n")).catch((e) => console.warn("[startup notify]", e));
          }, 3000);
        }
      }
    }

    if (platform === "wecom") {
      console.log(`[${this.label}] WeCom not implemented`);
    }

    currentStatePath = this.statePath;
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        if (this.statePath === currentStatePath) {
          flushState();
          flushRecent();
        }
      });
    }
  }

  // -----------------------------------------------------------------------
  // Message handler — enters serial queue
  // -----------------------------------------------------------------------

  private handleMessage(ev: FeishuMessageEvent): void {
    if (isStopCommand(ev.text)) {
      this.handleStop(ev);
      return;
    }
    enqueue(ev.chatId, () => this.processMessage(ev));
  }

  private async processMessage(ev: FeishuMessageEvent): Promise<void> {
    const supported = new Set(["text", "post", "file", "image"]);
    if (!supported.has(ev.messageType)) {
      console.warn(`[跳过] 不支持的消息类型 type=${ev.messageType} chat=${ev.chatId.slice(0, 8)}`);
      await this.feishu?.sendToChat(
        ev.chatId,
        `暂不支持该消息类型（${ev.messageType}）。请发文字 / 富文本 / 图片 / 文件。`,
      );
      return;
    }
    const text = ev.text.trim();
    if (!text && ev.attachments.length === 0) {
      console.warn(
        `[跳过] 空内容 type=${ev.messageType} chat=${ev.chatId.slice(0, 8)} raw=${ev.content?.slice(0, 200) || ""}`,
      );
      await this.feishu?.sendToChat(
        ev.chatId,
        "收到消息但未能解析出文字内容。请改发纯文本，或把链接/正文直接粘贴发送。",
      );
      return;
    }

    if (this.config.allowlist.size > 0 && !this.config.allowlist.has(ev.senderOpenId)) {
      await this.feishu?.sendToChat(ev.chatId, "⛔ Not authorized.");
      return;
    }

    // Admin console mode: p2p = management only
    if (this.config.adminMode) {
      const isP2p = ev.chatType === "p2p" || isAdminChat(ev.chatId, this.config.adminChatId);
      if (isP2p) {
        await this.handleAdminMessage(ev);
        return;
      }
      // Group must be a registered task
      const task = getTaskByChatId(ev.chatId);
      if (!task) {
        await this.feishu?.sendToChat(
          ev.chatId,
          "此群未注册或已归档。请在 Bot 私聊发 `/新任务` 创建。",
        );
        return;
      }
    }

    const handled = await this.handleCommand(ev);
    if (handled) return;

    // single agent or the orc lead agent? code-only routing per message (src/orc/route.ts);
    // a wrong guess is recoverable: the lead can hand back (`chat`), the single agent can escalate (`[[task]]`)
    const profile = getProfile(ev.chatId);
    const route = routeMessage(ev.text || "", {
      mode: profile.mode,
      inThread: !!(ev.rootId && taskForCard(ev.rootId)),
      hasAttachments: ev.attachments.length > 0,
      ...routeContext(ev.chatId),
    });
    if (route.to === "lead") {
      console.log(`[${this.label}] route ${ev.chatId.slice(0, 10)} → lead (${route.why})`);
      await runLeadTurn(this.orcHost(), ev, route.why);
      return;
    }

    await this.runAiAndReply(ev);
  }

  // -----------------------------------------------------------------------
  // Admin console (feishu-cursor style)
  // -----------------------------------------------------------------------

  private async handleAdminMessage(ev: FeishuMessageEvent): Promise<void> {
    const feishu = this.feishu!;
    const trimmed = ev.text.trim();
    setAdminChat(ev.chatId);
    if (ev.senderOpenId) setAdminOpenId(ev.senderOpenId);

    if (!trimmed) return;

    if (/^\/(help|帮助)\s*$/i.test(trimmed)) {
      const projects = Object.keys(getProjects().projects);
      await feishu.sendMarkdown(ev.chatId, [
        `**${this.config.name} 管理台**（私聊专用）`,
        "",
        "- `/新任务 标题` — 建群并开始新 session",
        "- `/新任务 finch:首条指令` — 建群并立即执行",
        "- `/列表` — 活跃任务群",
        "- `/归档 编号` — 归档任务（群保留，不再响应）",
        "- `/状态` — 服务状态",
        "- `/help` — 本帮助",
        "",
        "**工作群内**直接发消息即可与 AI 对话（支持 `项目名:指令`）",
        "工作群内 `/stop` 终止；`/review` 审视上一轮回复",
        "",
        projects.length ? `项目: ${projects.join("、")}` : "（未配置 projects.json）",
      ].join("\n"));
      return;
    }

    const newTask = trimmed.match(/^\/(新任务|new|task)\s+(.+)/is);
    if (newTask) {
      const rest = newTask[2].trim();
      const projectRoute = rest.match(/^(\S+?)[:\uff1a]\s*(.+)/s);
      if (projectRoute && getProjects().projects[projectRoute[1].toLowerCase()]) {
        await this.createNewTask(ev, titleFromPrompt(projectRoute[2]), rest);
      } else {
        await this.createNewTask(ev, titleFromPrompt(rest));
      }
      return;
    }

    if (/^\/(新任务|new|task)\s*$/i.test(trimmed)) {
      await feishu.sendToChat(ev.chatId, "请提供任务标题，例如：`/新任务 重构 auth`");
      return;
    }

    if (/^\/(列表|list|任务)\s*$/i.test(trimmed)) {
      const tasks = listTasks(true);
      if (tasks.length === 0) {
        await feishu.sendToChat(ev.chatId, "暂无活跃任务。发送 `/新任务 标题` 创建。");
        return;
      }
      const lines = tasks.map((t, i) => {
        const sess = t.cursorSessionId ? `\`${t.cursorSessionId.slice(0, 8)}\`` : "（未开始）";
        return `**${i + 1}. ${t.title}** [${t.projectLabel}]\n   ${formatRelativeTime(t.lastActiveAt)} · session ${sess}\n   \`${t.chatId}\``;
      });
      await feishu.sendMarkdown(ev.chatId, `**活跃任务 (${tasks.length})**\n\n${lines.join("\n\n")}\n\n归档: \`/归档 编号\``);
      return;
    }

    const archiveCmd = trimmed.match(/^\/(归档|archive)\s+(.+)/i);
    if (archiveCmd) {
      const arg = archiveCmd[2].trim();
      const tasks = listTasks(true);
      let task = findTask(arg);
      const num = Number.parseInt(arg, 10);
      if (!task && !Number.isNaN(num) && num >= 1 && num <= tasks.length) {
        task = tasks[num - 1];
      }
      if (!task) {
        await feishu.sendToChat(ev.chatId, `未找到任务「${arg}」。发送 \`/列表\` 查看。`);
        return;
      }
      archiveTask(task.chatId);
      await feishu.sendToChat(task.chatId, "📦 此任务已由管理台归档，群内消息不再触发 AI。");
      await feishu.sendMarkdown(ev.chatId, `已归档: **${task.title}**\n群 \`${task.chatId}\` 仍保留。`);
      return;
    }

    if (/^\/(status|状态)\s*$/i.test(trimmed)) {
      const tasks = listTasks(true);
      const projects = getProjects();
      await feishu.sendMarkdown(ev.chatId, [
        `**${this.config.name}**`,
        `AI CLI: \`${this.config.aiCli}\``,
        `默认项目: ${projects.default_project || "(无)"}`,
        `活跃任务: ${tasks.length} 个`,
        `管理私聊: \`${getStore().adminChatId || ev.chatId}\``,
      ].join("\n"));
      return;
    }

    if (trimmed.startsWith("/")) {
      await feishu.sendToChat(ev.chatId, "未知管理指令。发送 `/帮助` 查看。\n普通指令请在工作群内发送。");
      return;
    }

    await feishu.sendMarkdown(ev.chatId, [
      "这是 **管理私聊**，不直接执行 AI。",
      "",
      "- `/新任务 重构 auth` — 建群开新 session",
      "- `/列表` — 查看任务群",
      "",
      "已有任务群？进群直接对话即可。",
    ].join("\n"));
  }

  private async createNewTask(
    ev: FeishuMessageEvent,
    title: string,
    firstPrompt?: string,
  ): Promise<void> {
    const feishu = this.feishu!;
    const routed = firstPrompt
      ? routePrompt(firstPrompt)
      : routePrompt("", { workspace: this.workdir, label: getProjects().default_project || "default" });
    const groupName = `🤖 ${this.config.aiCli} · ${title}`.slice(0, 50);

    try {
      await feishu.sendToChat(ev.chatId, `正在创建群「${groupName}」…`);
      const openId = ev.senderOpenId || getStore().adminOpenId;
      if (!openId) {
        await feishu.sendToChat(ev.chatId, "未知用户 open_id，请先在私聊发一条消息。");
        return;
      }

      const { chatId, message } = await feishu.createSessionChat(groupName, openId);
      if (!chatId) {
        await feishu.sendToChat(ev.chatId, `❌ 创建失败\n${message}`);
        return;
      }

      addTask({
        chatId,
        title,
        workspace: routed.workspace,
        projectLabel: routed.label,
      });
      chatWorkspace.set(chatId, { workspace: routed.workspace, label: routed.label });

      await feishu.sendMarkdown(chatId, [
        `**${groupName}** 已就绪`,
        `- 工作区: \`${routed.label}\` → ${routed.workspace}`,
        `- 在此群对话即与 ${this.config.aiCli} 交互`,
        `- \`/stop\` 终止；\`/review\` 审视上一轮；每轮末尾附 token 用量`,
        `- 管理请回 Bot 私聊发 \`/列表\` \`/归档\``,
      ].join("\n"));

      await feishu.sendMarkdown(ev.chatId, [
        `✅ 已创建任务群`,
        `- 标题: **${title}**`,
        `- chat_id: \`${chatId}\``,
        firstPrompt ? `- 正在群内执行首条指令…` : `- 请进群发送第一条指令`,
      ].join("\n"));

      if (firstPrompt) {
        await this.runAiAndReply({
          ...ev,
          chatId,
          chatType: "group",
          text: routed.prompt,
          attachments: [],
          messageType: "text",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await feishu.sendToChat(ev.chatId, `❌ 创建任务群失败\n\n${msg.slice(0, 1500)}`);
    }
  }

  // -----------------------------------------------------------------------
  // /stop handler — bypasses queue
  // -----------------------------------------------------------------------

  private handleStop(ev: FeishuMessageEvent): void {
    const stopped = this.stopRunByKey(ev.chatId);

    const orcStopped = getProfile(ev.chatId).mode === "orc" ? stopChatTasks(ev.chatId) : [];
    if (orcStopped.length) {
      this.feishu?.sendToChat(ev.chatId, `⏹️ 已终止 orc 任务 ${orcStopped.map((i) => "#" + i).join(" ")}`);
      if (!stopped) return;
    }

    if (stopped) {
      this.feishu?.sendToChat(ev.chatId, "⏹️ 正在停止…");
    } else {
      this.feishu?.sendToChat(ev.chatId, "当前没有运行中的任务。");
    }
  }

  /** Kill a running task for an arbitrary session key */
  private stopRunByKey(key: string): boolean {
    const { aiCli } = this.config;
    if (aiCli === "codebuddy") return stopCodebuddyRun(key);
    if (aiCli === "cursor") return stopCursorRun(key);
    if (aiCli === "codex") return stopCodexRun(key);
    if (aiCli === "claude") return stopClaudeRun(key);
    if (aiCli === "gemini") return stopGeminiRun(key);
    if (aiCli === "pi") return stopPiRun(key);
    return false;
  }

  // -----------------------------------------------------------------------
  // Commands (work groups + non-admin mode)
  // -----------------------------------------------------------------------

  private async handleCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const text = ev.text.trim();
    const feishu = this.feishu!;
    const chatId = ev.chatId;

    // /记住 /记忆 — per-chat memory (src/memory.ts)
    const memReply = memoryCommand(chatId, text);
    if (memReply) {
      await feishu.sendMarkdown(chatId, memReply);
      return true;
    }

    // /watch — long-running job monitors (src/watch.ts)
    const wc = watchCommandKind(text);
    if (wc) {
      await feishu.sendMarkdown(chatId, await this.handleWatchCommand(chatId, wc));
      return true;
    }

    // /mode /orc /task /tasks — orc scheduling layer
    if (await handleOrcCommand(this.orcHost(), ev)) return true;

    // /review — critique previous reply (feishu-cursor)
    const reviewCmd = parseReviewCommand(text);
    if (reviewCmd) {
      const sid = this.getSessionId(chatId);
      if (!sid) {
        await feishu.sendToChat(chatId, "还没有可审视的上一条回复。请先发送一条指令并等待回复后再 `/review`。");
        return true;
      }
      const prompt = buildReviewPrompt(reviewCmd.focus || undefined);
      await this.runAiAndReply({ ...ev, text: prompt, attachments: [] }, { kind: "review", rawPrompt: true });
      return true;
    }

    if (text === "/reset" || text === "/重置") {
      this.clearSession(chatId);
      await feishu.sendToChat(chatId, "🔄 会话已重置。Token 累计清零。");
      return true;
    }

    if (text === "/help" || text === "/帮助") {
      const extra = this.config.adminMode
        ? [
            "",
            "**管理台（私聊）:** `/新任务` `/列表` `/归档`",
            "**工作群:** 直接对话；`项目名:指令` 路由；`/review` 审视",
          ]
        : [];
      await feishu.sendMarkdown(chatId, [
        `**${this.config.name}** | \`${this.config.aiCli}\` → \`${this.config.platform}\``,
        "",
        "**直接说话就行**，例如：",
        "• 「画一下 loss 曲线发群里」「把报告整理成 html 发我」",
        "• 「后台跑这个训练，跑完或出错叫我」",
        "• 「记住：GPU 机器只有 2 张卡」",
        "• 「这个交给团队做，测试全过为止」「让两个模型交叉评审一下」",
        "• 「#12 到哪了」「先别推」「执行者换成 claude」「别每轮都刷屏」",
        "普通对话由单 agent 处理；要团队做的事、说到进行中的任务时自动交给主 agent。",
        "",
        "**兜底命令：**",
        "• `/stop`（`/cancel` `/停止`）— 立即终止当前运行（含本群团队任务）",
        "• `/reset` — 重置会话 + 清零累计 token",
        "• `/model [id]` — 查看/切换模型（`/model default` 恢复默认）",
        "• `/new [name]` — 创建新飞书群 = 全新独立会话",
        "• `/review [焦点]` — 审视上一轮回复",
        "• `/status` — 当前状态 + 机器资源",
        "• `/mode [auto|single|orc]` — 消息怎么分派（默认 auto，一般不用改）",
        "• `/tasks` `/watch` `/记忆` — 查看团队任务 / 监控 / 本群记忆",
        ...extra,
      ].join("\n"));
      return true;
    }

    if (text === "/status" || text === "/状态" || text === "/sys") {
      const model = this.getEffectiveModel(chatId);
      const ws = chatWorkspace.get(chatId);
      await feishu.sendMarkdown(chatId, [
        `**${this.config.name}**`,
        `平台: \`${this.config.platform}\``,
        `AI CLI: \`${this.config.aiCli}\``,
        `当前模型: \`${model}\``,
        ws ? `工作区: \`${ws.label}\` → ${ws.workspace}` : `工作区: ${this.workdir}`,
        "",
        "---",
        "",
        collectSysStatus(),
      ].join("\n"));
      return true;
    }

    if (text === "/model" || text.startsWith("/model ")) {
      return this.handleModelCommand(ev);
    }

    // In admin mode, /new is only for p2p (handled above); keep /new for non-admin
    if (!this.config.adminMode && (text === "/new" || text.startsWith("/new "))) {
      return this.handleNewCommand(ev);
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Watches (src/watch.ts)
  // -----------------------------------------------------------------------

  private async handleWatchCommand(chatId: string, c: NonNullable<ReturnType<typeof watchCommandKind>>): Promise<string> {
    const mine = (id: number) => { const w = getWatch(id); return w && w.chatId === chatId ? w : undefined; };
    if (c.kind === "usage") return "用法：`/watch` 列出；`/watch stop <编号…>` 停止；`/watch check <编号>` 立即检查一次";
    if (c.kind === "stop") {
      return c.ids.map((id) => {
        if (!cancelWatch(id, chatId)) return `监控 #${id} 不存在或已结束`;
        const w = getWatch(id)!;
        if (w.cardId) void this.feishu?.updateCardMessage(w.cardId, renderWatchCard(w)).catch(() => {});
        return `🛑 已停止监控 #${id}（被监控的进程不受影响）`;
      }).join("\n");
    }
    if (c.kind === "check") {
      const out: string[] = [];
      for (const id of c.ids) {
        const w = mine(id);
        if (!w) { out.push(`没有监控 #${id}`); continue; }
        if (w.status === "active") await tickWatches(Date.now(), id);
        out.push(renderWatchCard(getWatch(id)!));
      }
      return out.join("\n\n---\n\n");
    }
    const active = listWatches({ chatId, status: ["active"] });
    const done = listWatches({ chatId }).filter((w) => w.status !== "active").slice(-5);
    if (!active.length && !done.length) return "本群没有监控。让 agent「后台跑起来，跑完或出错叫我」，它会自己登记。";
    return [...active, ...done].map((w) => renderWatchCard(w)).join("\n\n---\n\n");
  }

  /** A watch hit its condition: tell the chat, then (if the agent left instructions) wake it */
  private async onWatchFire(w: Watch, r: CheckResult): Promise<void> {
    const feishu = this.feishu;
    if (!feishu) return;
    const loopTask = w.sessionKey.match(/^orc-loop:(\d+)$/)?.[1];
    const tail = r.evidence ? `\n\n\`\`\`\n${r.evidence.split("\n").slice(-15).join("\n").slice(-2500)}\n\`\`\`` : "";
    const next = loopTask ? `\n\n交回 orc 任务 #${loopTask} 的监督者接着处理…` : w.spec.onWake ? "\n\n正在唤醒 agent 接着处理…" : "";
    await feishu.sendMarkdown(w.chatId, `**${w.status === "expired" ? "⌛" : "🔔"} 监控 #${w.id} ${w.spec.title}**\n${w.fired?.reason ?? ""}${tail}${next}`);
    // a supervisor-loop task parked on this watch: hand the result to its ledger, not to a chat agent
    if (loopTask) {
      const h = this.orcHost();
      try { getOrc(h.agents, h.bins).loop.onWatchFired(Number(loopTask), w, r); }
      catch (e) { console.warn(`[orc] watch #${w.id} → task #${loopTask} failed: ${(e as Error).message}`); }
      return;
    }
    if (!w.spec.onWake) return;
    const ev: FeishuMessageEvent = {
      messageId: `watch-${w.id}`, chatId: w.chatId, chatType: "group", messageType: "text",
      text: buildWakePrompt(w, r), senderOpenId: "", content: "", attachments: [],
    };
    // through the chat's serial queue: never overlaps a turn the user started
    enqueue(w.chatId, () => this.runAiAndReply(ev, { kind: "wake" }));
  }

  private async handleModelCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const arg = ev.text.trim().slice("/model".length).trim();
    const feishu = this.feishu!;
    const chatId = ev.chatId;
    const { aiCli } = this.config;

    if (!arg) {
      const effective = this.getEffectiveModel(chatId);
      const listed = this.listKnownModels();
      if (listed.length) {
        await feishu.sendMarkdown(chatId, [
          `当前模型: \`${effective}\``,
          `用法: /model <id>  （/model default 恢复默认）`,
          "",
          `**可用模型:**`,
          ...listed.map((s) => `• \`${s}\``),
        ].join("\n"));
      } else {
        await feishu.sendMarkdown(chatId, [
          `当前模型: \`${effective}\``,
          `用法: /model <id>  （/model default 恢复默认）`,
          "",
          `可用模型请参考 CLI 文档。`,
        ].join("\n"));
      }
      return true;
    }

    if (arg === "default" || arg === "reset") {
      models.delete(chatId);
      this.clearSession(chatId);
      scheduleSave();
      await feishu.sendToChat(chatId, "✅ 已恢复默认模型，会话已重置。");
      return true;
    }

    // No whitelist gate: the curated list is just a convenience, and a stale or
    // incomplete one must not block a valid id. The CLI reports an unknown model
    // itself on the next run, so pass anything through and only hint if the id
    // is not in the list.
    const unlisted = aiCli === "codebuddy" && !this.listKnownModels().includes(arg);

    models.set(chatId, arg);
    this.clearSession(chatId);
    scheduleSave();
    await feishu.sendToChat(
      chatId,
      unlisted
        ? `✅ 模型已切换至: \`${arg}\`，会话已重置。\n\n（该 id 不在 /model 列表中；若模型不存在，CLI 会在下次执行时报错）`
        : `✅ 模型已切换至: \`${arg}\`，会话已重置。`,
    );
    return true;
  }

  private async handleNewCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const custom = ev.text.trim().slice("/new".length).trim();
    const stamp = new Date().toISOString().slice(5, 16).replace("T", " ");
    const name = custom || `${this.config.aiCli} ${stamp}`;
    const feishu = this.feishu!;
    await feishu.sendToChat(ev.chatId, `🆕 创建新群组「${name}」…`);
    const { chatId, message } = await feishu.createSessionChat(name, ev.senderOpenId);
    await feishu.sendToChat(ev.chatId, message);
    if (chatId) {
      await feishu.sendMarkdown(
        chatId,
        `🤖 这是独立的 ${this.config.aiCli} 会话「${name}」。\n` +
          `本群消息独立运行，不与其他群共享上下文。`,
      );
    }
    return true;
  }

  // -----------------------------------------------------------------------
  // Run AI with streaming card
  // -----------------------------------------------------------------------

  private async runAiAndReply(
    ev: FeishuMessageEvent,
    opts?: { kind?: "normal" | "review" | "wake"; rawPrompt?: boolean },
  ): Promise<void> {
    const feishu = this.feishu!;
    const chatId = ev.chatId;
    const isReview = opts?.kind === "review";

    // Resolve workspace via projects.json routing
    const fallback = chatWorkspace.get(chatId) || {
      workspace: this.workdir,
      label: getProjects().default_project || "default",
    };
    let promptText = ev.text;
    let workspace = fallback.workspace;
    let label = fallback.label;

    if (!opts?.rawPrompt) {
      // Download attachments first
      let localPaths: string[] = [];
      if (ev.attachments.length > 0) {
        try {
          localPaths = await feishu.downloadAttachments(ev.messageId, fallback.workspace, ev.attachments);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await feishu.sendToChat(chatId, `❌ 附件下载失败\n\n${msg.slice(0, 1500)}`);
          return;
        }
      }

      const routed = routePrompt(ev.text || "", fallback);
      workspace = routed.workspace;
      label = routed.label;
      promptText = buildPromptWithAttachments(routed.prompt, localPaths);
      if (!promptText) return;

      // Persist workspace for this chat
      chatWorkspace.set(chatId, { workspace, label });
      const task = getTaskByChatId(chatId);
      if (task && (task.workspace !== workspace || task.projectLabel !== label)) {
        task.workspace = workspace;
        task.projectLabel = label;
      }

      // Wrap with project system prompt (unless review)
      if (!isReview) {
        const bg = activeTaskSummary(chatId);
        if (bg) promptText = `${bg}\n\n---\n\n${promptText}`;
        const project = getProjects().projects[label];
        promptText = wrapWithProjectPrompt(workspace, project?.systemPromptFile, promptText);
        promptText = wrapWithWorkspaceHint(workspace, promptText);
      }
    }

    // Streaming card
    let cardId: string | undefined;
    try {
      const init = isReview ? `🔍 审视中 [${label}]…` : `⚙️ 正在生成 [${label}]…`;
      cardId = await feishu.sendCardAndGetId(chatId, init);
    } catch { /* fallback */ }

    let pendingText = "";
    let updateTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleUpdate = () => {
      if (!cardId) return;
      if (updateTimer) return;
      updateTimer = setTimeout(() => {
        updateTimer = null;
        feishu.updateCardMessage(cardId!, pendingText);
      }, 500);
    };

    const onStreamUpdate = (text: string) => {
      pendingText = text;
      scheduleUpdate();
    };

    let result: AiResult;
    try {
      result = await this.dispatchAi(promptText, chatId, workspace, label, onStreamUpdate, isReview ? "ro" : "rw");
    } catch (err) {
      result = { text: `⚠️ Error: ${(err as Error).message}` };
    }

    // `[[remember]]` / `[[forget]]` lines → per-chat memory (stripped from the reply)
    let memoryFooter = "";
    if (!isReview) {
      const ops = extractMemoryOps(result.text || "");
      if (ops.remember.length || ops.forget.length) {
        result = { ...result, text: ops.text };
        memoryFooter = applyMemoryOps(chatId, ops, "agent");
      }
    }

    // `[[watch]]` / `[[unwatch]]` lines → durable monitors (src/watch.ts)
    const watchNotes: string[] = [];
    const newWatches: Watch[] = [];
    if (!isReview) {
      const wops = extractWatchOps(result.text || "");
      if (wops.add.length || wops.remove.length) {
        result = { ...result, text: wops.text };
        for (const a of wops.add) {
          try {
            if (a.error) throw new Error(a.error);
            const w = addWatch({ chatId, bot: this.config.name, sessionKey: chatId, cwd: workspace, spec: parseWatchSpec(a.raw, workspace) });
            newWatches.push(w);
            watchNotes.push(`👀 已登记监控 #${w.id}「${w.spec.title}」：${describeSpec(w.spec)}`);
          } catch (e) {
            watchNotes.push(`⚠️ 监控没有登记成功：${(e as Error).message}`);
          }
        }
        for (const id of wops.remove) watchNotes.push(cancelWatch(id, chatId) ? `🛑 已停止监控 #${id}` : `监控 #${id} 不存在或已结束`);
      }
      // shared short transcript: the orc lead reads it when the chat switches modes
      recordTurn(chatId, "user", opts?.kind === "wake" ? `（监控唤醒）${ev.text.split("\n")[0]}` : ev.text);
      recordTurn(chatId, "agent", result.text || "");
    }

    // `[[task]] {...}` lines → hand the work to an orc team (src/orc/route.ts)
    const taskNotes: string[] = [];
    if (!isReview) {
      const tops = extractTaskOps(result.text || "");
      if (tops.ops.length) {
        result = { ...result, text: tops.text };
        for (const op of tops.ops) taskNotes.push(await submitTaskOp(this.orcHost(), chatId, op, ev.text));
      }
    }

    // `[[image]]` / `[[file]]` lines (+ bare image paths) → attachments sent by code (src/outgoing.ts)
    const sendOps = extractSendOps(result.text || "");
    if (sendOps.ops.length) result = { ...result, text: sendOps.text };
    const project = getProjects().projects[label];
    const outgoing = resolveOutgoing(sendOps.ops, {
      cwd: workspace,
      roots: sendRoots([workspace, this.workdir, project?.path, ...(project?.addDirs ?? []), ...Object.values(getProjects().projects).map((p) => p.path)]),
      fallbackText: result.text,
    });

    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }

    // Persist session: agent-runner Map (state file) + AI module Map + task store
    if (result.sessionId) {
      rememberSession(this.config.aiCli, chatId, result.sessionId);
      updateTaskSession(chatId, result.sessionId, titleFromPrompt(ev.text || promptText));
    }

    const usage = result.usage && result.usage.totalTokens > 0 ? result.usage : undefined;
    const header = isReview ? `**🔍 审视 [${label}]**\n\n` : "";
    let body = header + (result.text || (sendOps.ops.length ? `📎 附件 ×${sendOps.ops.length}` : "(empty)"));
    if (usage) {
      const displayModel = result.model || this.getDefaultModelName() || null;
      body += formatUsageFooter(chatId, displayModel, usage);
    }
    if (memoryFooter) body += `\n\n${memoryFooter}`;
    if (watchNotes.length) body += `\n\n${watchNotes.join("\n")}`;
    if (taskNotes.length) body += `\n\n${taskNotes.join("\n")}`;
    if (outgoing.notes.length) body += `\n\n${outgoing.notes.join("\n")}`;

    // Cards reject some markdown (e.g. too many tables → ErrCode 11310) and truncate
    // poorly when oversized. Never put the full reply on both card and post.
    const tableHeavy = (body.match(/^\|/gm) || []).length >= 4 || body.includes("|---");
    const preferPost = !cardId || body.length > 3000 || tableHeavy;
    if (!preferPost) {
      const ok = await feishu.updateCardMessage(cardId!, body).catch(() => false);
      if (!ok) await feishu.sendPostMarkdown(chatId, body);
    } else {
      if (cardId) {
        const tip = isReview ? "🔍 审视完成，见下方。" : "✅ 生成完成，见下方。";
        await feishu.updateCardMessage(cardId, tip).catch(() => false);
      }
      await feishu.sendPostMarkdown(chatId, body);
    }

    // one in-place progress card per new watch
    for (const w of newWatches) {
      const id = await feishu.sendCardAndGetId(chatId, renderWatchCard(w)).catch(() => undefined);
      if (id) updateWatch(w.id, { cardId: id });
    }

    if (result.images && result.images.length > 0) {
      await feishu.sendAgentImages(chatId, result.images);
    }
    if (result.files && result.files.length > 0) {
      await feishu.sendAgentFiles(chatId, result.files);
    }
  }

  // -----------------------------------------------------------------------
  // orc host (chat side of the scheduler; see src/orc/commands.ts)
  // -----------------------------------------------------------------------

  private _orcHost?: OrcChatHost;
  private orcHost(): OrcChatHost {
    if (this._orcHost) return this._orcHost;
    let agents: AgentConfig[] = [this.config];
    try { agents = [this.config, ...loadAllAgents().filter((a) => a.name !== this.config.name)]; } catch { /* keep own config */ }
    this._orcHost = {
      feishu: this.feishu!,
      agents,
      bins: { codebuddyBin: this.bins.codebuddyBin, codexBin: this.bins.codexBin, claudeBin: this.bins.claudeBin, cursorAgentBin: this.bins.cursorAgentBin },
      workspaceFor: (chatId) => chatWorkspace.get(chatId)?.workspace || this.workdir,
      // Lead agent (002 §2.3): stateless (fresh session; recent turns come in the prompt),
      // read-only, short timeouts, optional cheaper model via ORC_LEAD_MODEL.
      runLead: async (prompt, sessionKey) => {
        const ws = chatWorkspace.get(chatOf(sessionKey));
        this.clearAiKey(sessionKey);
        const res = await this.dispatchAi(prompt, sessionKey, ws?.workspace || this.workdir, ws?.label || "default", undefined, "ro", {
          readOnly: true,
          hardTimeoutMs: Number(process.env.ORC_LEAD_HARD_MS || 4 * 60_000),
          staleTimeoutMs: Number(process.env.ORC_LEAD_STALE_MS || 2 * 60_000),
          model: process.env.ORC_LEAD_MODEL || undefined,
        });
        this.clearAiKey(sessionKey);
        return res.text;
      },
      runSingle: (ev) => this.runAiAndReply(ev),
    };
    return this._orcHost;
  }

  // -----------------------------------------------------------------------
  // Dispatch to AI CLI
  // -----------------------------------------------------------------------

  private async dispatchAi(
    prompt: string,
    chatId: string,
    workspace: string,
    label: string,
    onStreamUpdate?: (text: string) => void,
    /** "rw": the agent may emit [[remember]] lines (single-agent replies only) */
    memoryMode: "rw" | "ro" = "ro",
    /** Per-call overrides (orc lead agent): no writes, short timeouts, own model */
    run: { readOnly?: boolean; hardTimeoutMs?: number; staleTimeoutMs?: number; model?: string } = {},
  ): Promise<AiResult> {
    const { aiCli, codebuddy: cbConfig, cursor: curConfig, codex: codexConfig, claude: claudeConfig, gemini: geminiConfig, pi: piConfig } = this.config;
    const model = run.model || models.get(chatId);
    const { hardTimeoutMs, staleTimeoutMs } = run;
    const roTools = run.readOnly ? READ_ONLY_DENY : undefined;
    const addDirs = this.resolveAddDirs(workspace, label);

    // Group announcement (= this chat's rules, revision-cached) + per-chat memory, every turn.
    // Session keys look like "<chatId>" or "<chatId>#role:x" - the chat is the prefix.
    const chat = chatOf(chatId);
    const announcement = this.feishu
      ? await getChatInstructions(this.feishu.getClient(), chat)
      : undefined;
    const instructions = joinInstructions(
      announcement,
      chat.startsWith("oc_") ? formatMemory(chat, { writable: memoryMode === "rw" }) : undefined,
      memoryMode === "rw" && process.env.WHISPER_WATCH_HINT !== "0" ? formatWatchContext(chat) : undefined,
      memoryMode === "rw" ? formatSendHint() : undefined,
      memoryMode === "rw" && chat.startsWith("oc_") && process.env.WHISPER_TASK_HINT !== "0" ? formatTaskHint() : undefined,
    );
    // CLIs without an append-system-prompt flag get it as a prompt prefix
    const prefixed = instructions ? `${instructions}\n\n---\n\n${prompt}` : prompt;

    if (aiCli === "codebuddy" && cbConfig) {
      const result = await runCodebuddy({
        prompt,
        chatId,
        config: cbConfig,
        workdir: workspace,
        codebuddyBin: this.bins.codebuddyBin,
        model,
        onStreamUpdate,
        appendSystemPrompt: instructions,
        // per-chat memory replaces the cwd-keyed Auto Memory; WHISPER_CB_AUTO_MEMORY=1 keeps it on
        disableAutoMemory: process.env.WHISPER_CB_AUTO_MEMORY !== "1",
        disallowedTools: roTools,
        hardTimeoutMs,
        staleTimeoutMs,
      });
      return result;
    }

    if (aiCli === "cursor" && curConfig) {
      const result = await runCursor({
        prompt: prefixed,
        chatId,
        config: curConfig,
        workspace,
        addDirs,
        agentBin: this.bins.cursorAgentBin,
        model,
        onStreamUpdate,
        readOnly: run.readOnly,
        hardTimeoutMs,
        staleTimeoutMs,
      });
      return result;
    }

    if (aiCli === "codex" && codexConfig && this.bins.codexBin) {
      const result = await runCodex({
        prompt,
        chatId,
        config: codexConfig,
        workdir: workspace,
        addDirs,
        codexBin: this.bins.codexBin,
        model,
        onStreamUpdate,
        appendSystemPrompt: instructions,
        readOnly: run.readOnly,
        hardTimeoutMs,
        staleTimeoutMs,
      });
      return result;
    }

    if (aiCli === "claude" && claudeConfig) {
      const result = await runClaude({
        prompt,
        chatId,
        config: claudeConfig,
        workspace,
        addDirs,
        claudeBin: this.bins.claudeBin,
        model,
        onStreamUpdate,
        appendSystemPrompt: instructions,
        disallowedTools: roTools,
      });
      return result;
    }

    if (aiCli === "gemini" && geminiConfig) {
      const result = await runGemini({
        prompt: prefixed,
        chatId,
        config: geminiConfig,
        workspace,
        addDirs,
        geminiBin: this.bins.geminiBin,
        model,
        onStreamUpdate,
      });
      return result;
    }

    if (aiCli === "pi" && piConfig && this.bins.piBin) {
      const result = await runPi({
        prompt: prefixed,
        chatId,
        config: piConfig,
        workdir: workspace,
        piBin: this.bins.piBin,
        model,
        onStreamUpdate,
      });
      return result;
    }

    throw new Error(`Cannot dispatch: no config for "${aiCli}"`);
  }

  private resolveAddDirs(workspace: string, label: string): string[] {
    const project = getProjects().projects[label];
    let addDirs = project?.addDirs ? [...project.addDirs] : [];
    const trialsMarker = "/trials/";
    const trialsIdx = workspace.indexOf(trialsMarker);
    if (trialsIdx > 0) {
      const finchRoot = workspace.slice(0, trialsIdx);
      if (!addDirs.includes(finchRoot)) addDirs.push(finchRoot);
    }
    return addDirs.filter((d) => d && d !== workspace && existsSync(d));
  }

  // -----------------------------------------------------------------------
  // Model helpers
  // -----------------------------------------------------------------------

  private getEffectiveModel(chatId: string): string {
    const override = models.get(chatId);
    if (override) return override;
    return this.getDefaultModelName() || "default";
  }

  private getDefaultModelName(): string | undefined {
    if (this.config.aiCli === "codex") return getCodexDefaultModel();
    if (this.config.aiCli === "cursor") return "auto";
    if (this.config.aiCli === "gemini") return "auto";
    return undefined;
  }

  private listKnownModels(): string[] {
    const { aiCli } = this.config;
    if (aiCli === "codebuddy") {
      // Under API-key auth the CLI reports only its fallback catalog (no
      // enterpriseId → enterprise models API skipped), so a configured list
      // overrides it with a short, curated "latest per family" set.
      const configured = this.config.codebuddy?.models ?? [];
      if (configured.length) return ["default-model", ...configured];
      return queryCodebuddyModels(this.bins.codebuddyBin || "codebuddy");
    }
    if (aiCli === "claude") return CLAUDE_MODEL_ALIASES;
    if (aiCli === "gemini") return GEMINI_MODEL_ALIASES;
    return [];
  }

  // -----------------------------------------------------------------------
  // Session helpers
  // -----------------------------------------------------------------------

  private clearSession(chatId: string): void {
    this.clearAiKey(chatId);
    cumUsage.delete(chatId);
    scheduleSave();
  }

  /** Drop a session in both the AI adapter and the persisted state Map */
  private clearAiKey(key: string): void {
    const { aiCli } = this.config;
    if (aiCli === "codebuddy") clearCodebuddySession(key);
    if (aiCli === "cursor") clearCursorSession(key);
    if (aiCli === "codex") clearCodexSession(key);
    if (aiCli === "claude") clearClaudeSession(key);
    if (aiCli === "gemini") clearGeminiSession(key);
    if (aiCli === "pi") clearPiSession(key);
    sessions.delete(key);
  }

  /** Prefer AI module Map (source of truth at runtime), fall back to persisted Map */
  private getSessionId(chatId: string): string | undefined {
    if (this.config.aiCli === "cursor") return getCursorSession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "codebuddy") return getCodebuddySession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "codex") return getCodexSession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "claude") return getClaudeSession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "gemini") return getGeminiSession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "pi") return getPiSession(chatId) || sessions.get(chatId);
    return sessions.get(chatId);
  }

  private get label(): string {
    return `${this.config.name} (${this.config.platform}→${this.config.aiCli})`;
  }
}
