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
import { getProjects, loadProjects, routePrompt, watchProjects } from "./projects";
import { buildReviewPrompt, parseReviewCommand, wrapWithProjectPrompt } from "./prompt";
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

export class AgentRunner {
  private config: AgentConfig;
  private feishu?: FeishuClient;
  private workdir: string;
  private codebuddyBin?: string;
  private cursorAgentBin?: string;
  private codexBin?: string;
  private statePath: string;

  constructor(
    config: AgentConfig,
    workdir: string,
    codebuddyBin?: string,
    cursorAgentBin?: string,
    codexBin?: string,
    stateDir?: string,
  ) {
    this.config = config;
    this.workdir = workdir;
    this.codebuddyBin = codebuddyBin;
    this.cursorAgentBin = cursorAgentBin;
    this.codexBin = codexBin;
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
        if (this.statePath === currentStatePath) flushState();
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
    if (!supported.has(ev.messageType)) return;
    const text = ev.text.trim();
    if (!text && ev.attachments.length === 0) return;

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
    const { aiCli } = this.config;
    let stopped = false;
    if (aiCli === "codebuddy") stopped = stopCodebuddyRun(ev.chatId);
    if (aiCli === "cursor") stopped = stopCursorRun(ev.chatId);
    if (aiCli === "codex") stopped = stopCodexRun(ev.chatId);
    if (stopped) {
      this.feishu?.sendToChat(ev.chatId, "⏹️ 正在停止…");
    } else {
      this.feishu?.sendToChat(ev.chatId, "当前没有运行中的任务。");
    }
  }

  // -----------------------------------------------------------------------
  // Commands (work groups + non-admin mode)
  // -----------------------------------------------------------------------

  private async handleCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const text = ev.text.trim();
    const feishu = this.feishu!;
    const chatId = ev.chatId;

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
        "**Commands:**",
        "• `/reset` — 重置会话 + 清零累计 token",
        "• `/model [id]` — 查看/切换模型（`/model default` 恢复默认）",
        "• `/new [name]` — 创建新飞书群 = 全新独立会话",
        "• `/review [焦点]` — 审视上一轮回复（别名 `/审视` `/critique`）",
        "• `/stop` (或 `/cancel` `/停止`) — 终止当前运行的任务",
        "• `/status` — 查看当前状态",
        "• `/help` — 显示此帮助",
        ...extra,
        "",
        "其余消息自动转发给 AI CLI 执行。",
      ].join("\n"));
      return true;
    }

    if (text === "/status" || text === "/状态") {
      const model = this.getEffectiveModel(chatId);
      const ws = chatWorkspace.get(chatId);
      await feishu.sendMarkdown(chatId, [
        `**${this.config.name}**`,
        `平台: \`${this.config.platform}\``,
        `AI CLI: \`${this.config.aiCli}\``,
        `当前模型: \`${model}\``,
        ws ? `工作区: \`${ws.label}\` → ${ws.workspace}` : `工作区: ${this.workdir}`,
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

  private async handleModelCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const arg = ev.text.trim().slice("/model".length).trim();
    const feishu = this.feishu!;
    const chatId = ev.chatId;
    const { aiCli } = this.config;

    if (!arg) {
      const effective = this.getEffectiveModel(chatId);
      if (aiCli === "codebuddy") {
        const bin = this.codebuddyBin || "codebuddy";
        const supported = queryCodebuddyModels(bin);
        await feishu.sendMarkdown(chatId, [
          `当前模型: \`${effective}\``,
          `用法: /model <id>  （/model default 恢复默认）`,
          "",
          `**可用模型:**`,
          ...supported.map((s) => `• \`${s}\``),
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

    if (aiCli === "codebuddy") {
      const bin = this.codebuddyBin || "codebuddy";
      const supported = queryCodebuddyModels(bin);
      if (!supported.includes(arg) && arg !== "default") {
        await feishu.sendMarkdown(chatId, [
          `⚠️ 未知模型: \`${arg}\``,
          "",
          "**可用:**",
          ...supported.map((s) => `• \`${s}\``),
        ].join("\n"));
        return true;
      }
    }

    models.set(chatId, arg);
    this.clearSession(chatId);
    scheduleSave();
    await feishu.sendToChat(chatId, `✅ 模型已切换至: \`${arg}\`，会话已重置。`);
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
    opts?: { kind?: "normal" | "review"; rawPrompt?: boolean },
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
        const project = getProjects().projects[label];
        promptText = wrapWithProjectPrompt(workspace, project?.systemPromptFile, promptText);
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
      result = await this.dispatchAi(promptText, chatId, workspace, onStreamUpdate);
    } catch (err) {
      result = { text: `⚠️ Error: ${(err as Error).message}` };
    }

    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }

    // Persist session: agent-runner Map (state file) + AI module Map + task store
    if (result.sessionId) {
      rememberSession(this.config.aiCli, chatId, result.sessionId);
      updateTaskSession(chatId, result.sessionId, titleFromPrompt(ev.text || promptText));
    }

    const usage = result.usage && result.usage.totalTokens > 0 ? result.usage : undefined;
    const header = isReview ? `**🔍 审视 [${label}]**\n\n` : "";
    let body = header + (result.text || "(empty)");
    if (usage) {
      const displayModel = result.model || this.getDefaultModelName() || null;
      body += formatUsageFooter(chatId, displayModel, usage);
    }

    if (cardId) {
      await feishu.updateCardMessage(cardId, body).catch(() => {});
      if (body.length > 3000) {
        await feishu.sendPostMarkdown(chatId, body);
      }
    } else {
      await feishu.sendPostMarkdown(chatId, body);
    }

    if (result.images && result.images.length > 0) {
      await feishu.sendAgentImages(chatId, result.images);
    }
    if (result.files && result.files.length > 0) {
      await feishu.sendAgentFiles(chatId, result.files);
    }
  }

  // -----------------------------------------------------------------------
  // Dispatch to AI CLI
  // -----------------------------------------------------------------------

  private async dispatchAi(
    prompt: string,
    chatId: string,
    workspace: string,
    onStreamUpdate?: (text: string) => void,
  ): Promise<AiResult> {
    const { aiCli, codebuddy: cbConfig, cursor: curConfig, codex: codexConfig } = this.config;
    const model = models.get(chatId);

    if (aiCli === "codebuddy" && cbConfig) {
      const result = await runCodebuddy({
        prompt,
        chatId,
        config: cbConfig,
        workdir: workspace,
        codebuddyBin: this.codebuddyBin,
        model,
        onStreamUpdate,
      });
      // sessionId persisted in runAiAndReply via rememberSession
      return result;
    }

    if (aiCli === "cursor" && curConfig) {
      const result = await runCursor({
        prompt,
        chatId,
        config: curConfig,
        workspace,
        agentBin: this.cursorAgentBin,
        model,
        onStreamUpdate,
      });
      return result;
    }

    if (aiCli === "codex" && codexConfig && this.codexBin) {
      const result = await runCodex({
        prompt,
        chatId,
        config: codexConfig,
        workdir: workspace,
        codexBin: this.codexBin,
        model,
        onStreamUpdate,
      });
      return result;
    }

    throw new Error(`Cannot dispatch: no config for "${aiCli}"`);
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
    return undefined;
  }

  // -----------------------------------------------------------------------
  // Session helpers
  // -----------------------------------------------------------------------

  private clearSession(chatId: string): void {
    if (this.config.aiCli === "codebuddy") clearCodebuddySession(chatId);
    if (this.config.aiCli === "cursor") clearCursorSession(chatId);
    if (this.config.aiCli === "codex") clearCodexSession(chatId);
    sessions.delete(chatId);
    cumUsage.delete(chatId);
    scheduleSave();
  }

  /** Prefer AI module Map (source of truth at runtime), fall back to persisted Map */
  private getSessionId(chatId: string): string | undefined {
    if (this.config.aiCli === "cursor") return getCursorSession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "codebuddy") return getCodebuddySession(chatId) || sessions.get(chatId);
    if (this.config.aiCli === "codex") return getCodexSession(chatId) || sessions.get(chatId);
    return sessions.get(chatId);
  }

  private get label(): string {
    return `${this.config.name} (${this.config.platform}→${this.config.aiCli})`;
  }
}
