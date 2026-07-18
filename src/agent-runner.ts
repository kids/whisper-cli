// =============================================================================
// Agent Runner — orchestrates one (Platform + AI CLI) pair
// =============================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, AiResult, CumulativeUsage, AgentState } from "./types";
import { emptyCumulativeUsage } from "./types";
import { FeishuClient, type FeishuMessageEvent } from "./platform/feishu";
import {
  runCodebuddy,
  stopCodebuddyRun,
  clearCodebuddySession,
  setCodebuddySession,
  queryCodebuddyModels,
} from "./ai/codebuddy";
import {
  runCursor,
  stopCursorRun,
  clearCursorSession,
  setCursorSession,
} from "./ai/cursor";
import {
  runCodex,
  stopCodexRun,
  clearCodexSession,
  setCodexSession,
} from "./ai/codex";

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
const models = new Map<string, string>();         // chat_id -> model override
const cumUsage = new Map<string, CumulativeUsage>(); // chat_id -> cumulative

// ---------------------------------------------------------------------------
// Agent state persistence
// ---------------------------------------------------------------------------

function loadAgentState(statePath: string): void {
  if (!existsSync(statePath)) return;
  try {
    const data: AgentState = JSON.parse(readFileSync(statePath, "utf8"));
    if (data?.sessions) {
      for (const [k, v] of Object.entries(data.sessions)) sessions.set(k, v);
    }
    if (data?.models) {
      for (const [k, v] of Object.entries(data.models)) models.set(k, v);
    }
    if (data?.tokens) {
      for (const [k, v] of Object.entries(data.tokens)) cumUsage.set(k, v);
    }
    console.log(`[state] loaded ${sessions.size} sessions, ${models.size} models, ${cumUsage.size} usage records`);
  } catch (e) {
    console.error(`[state] failed to load ${statePath}:`, e);
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

  const parts: string[] = [`�� \`${model || "default"}\``];
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

    // Load persisted state
    currentStatePath = this.statePath;
    loadAgentState(this.statePath);
    currentStatePath = "";
  }

  async start(): Promise<void> {
    const { platform } = this.config;

    if (platform === "feishu") {
      if (!this.config.feishu) throw new Error("Missing Feishu config");
      this.feishu = new FeishuClient(this.config.feishu);
      this.feishu.onMessage(this.handleMessage.bind(this));
      this.feishu.start();
      console.log(`[${this.label}] Feishu started (appId=${this.config.feishu.appId.slice(0, 10)}...)`);
    }

    if (platform === "wecom") {
      console.log(`[${this.label}] WeCom not implemented`);
    }

    // Set state path for persistence
    currentStatePath = this.statePath;
    // Flush on shutdown
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
    // Stop commands bypass queue
    if (ev.text.trim() === "/stop" || ev.text.trim() === "/cancel") {
      this.handleStop(ev);
      return;
    }
    enqueue(ev.chatId, () => this.processMessage(ev));
  }

  private async processMessage(ev: FeishuMessageEvent): Promise<void> {
    if (!["text", "post"].includes(ev.messageType)) return;
    const text = ev.text.trim();
    if (!text) return;

    // Allowlist
    if (this.config.allowlist.size > 0 && !this.config.allowlist.has(ev.senderOpenId)) {
      await this.feishu?.sendToChat(ev.chatId, "⛔ Not authorized.");
      return;
    }

    // Commands
    const handled = await this.handleCommand(ev);
    if (handled) return;

    // Run AI
    await this.runAiAndReply(ev);
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
  // Commands
  // -----------------------------------------------------------------------

  private async handleCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const text = ev.text.trim();
    const feishu = this.feishu!;
    const chatId = ev.chatId;

    if (text === "/reset") {
      this.clearSession(chatId);
      await feishu.sendToChat(chatId, "🔄 会话已重置。Token 累计清零。");
      return true;
    }

    if (text === "/help") {
      await feishu.sendMarkdown(chatId, [
        `**${this.config.name}** | \`${this.config.aiCli}\` → \`${this.config.platform}\``,
        "",
        "**Commands:**",
        "• `/reset` — 重置会话 + 清零累计 token",
        "• `/model [id]` — 查看/切换模型（`/model default` 恢复默认）",
        "• `/new [name]` — 创建新飞书群 = 全新独立会话",
        "• `/stop` (或 `/cancel`) — 终止当前运行的任务",
        "• `/status` — 查看当前状态",
        "• `/help` — 显示此帮助",
        "",
        "其余消息自动转发给 AI CLI 执行。",
      ].join("\n"));
      return true;
    }

    if (text === "/status") {
      const model = models.get(chatId) || "default";
      await feishu.sendMarkdown(chatId, [
        `**${this.config.name}**`,
        `平台: \`${this.config.platform}\``,
        `AI CLI: \`${this.config.aiCli}\``,
        `当前模型: \`${model}\``,
      ].join("\n"));
      return true;
    }

    if (text === "/model" || text.startsWith("/model ")) {
      return this.handleModelCommand(ev);
    }

    if (text === "/new" || text.startsWith("/new ")) {
      return this.handleNewCommand(ev);
    }

    return false;
  }

  private async handleModelCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const arg = ev.text.trim().slice("/model".length).trim();
    const feishu = this.feishu!;
    const chatId = ev.chatId;
    const { aiCli } = this.config;
    const current = models.get(chatId) || "default";

    if (!arg) {
      // Show current model
      if (aiCli === "codebuddy") {
        const bin = this.codebuddyBin || "codebuddy";
        const supported = queryCodebuddyModels(bin);
        await feishu.sendMarkdown(chatId, [
          `当前模型: \`${current}\``,
          `用法: /model <id>  （/model default 恢复默认）`,
          "",
          `**可用模型:**`,
          ...supported.map((s) => `• \`${s}\``),
        ].join("\n"));
      } else {
        await feishu.sendMarkdown(chatId, [
          `当前模型: \`${current}\``,
          `用法: /model <id>  （/model default 恢复默认）`,
          "",
          `可用模型请参考 CLI 文档（如 \`codex --help\`）。`,
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

    // Validate only for codebuddy
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

  private async runAiAndReply(ev: FeishuMessageEvent): Promise<void> {
    const feishu = this.feishu!;
    const chatId = ev.chatId;

    // 1. Create streaming card
    let cardId: string | undefined;
    try {
      cardId = await feishu.sendCardAndGetId(chatId, "⚙️ 正在生成…");
    } catch { /* fallback */ }

    const streamUpdate = async (text: string) => {
      if (cardId) {
        await feishu.updateCardMessage(cardId, text);
      }
    };
    // Throttle: only update every 500ms
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
      result = await this.dispatchAi(ev.text, chatId, onStreamUpdate);
    } catch (err) {
      result = { text: `⚠️ Error: ${(err as Error).message}` };
    }

    // Flush pending update
    if (updateTimer) { clearTimeout(updateTimer); updateTimer = null; }

    const usage = result.usage && result.usage.totalTokens > 0 ? result.usage : undefined;

    let body = result.text || "(empty)";
    if (usage) {
      body += formatUsageFooter(chatId, result.model || null, usage);
    }

    if (cardId) {
      // Best-effort: update the streaming card with final content
      await feishu.updateCardMessage(cardId, body).catch(() => {});
      // If result is very long, card patch may have been dropped — send chunked markdown as well
      if (body.length > 3000) {
        await feishu.sendMarkdown(chatId, body);
      }
    } else {
      await feishu.sendMarkdown(chatId, body);
    }
  }

  // -----------------------------------------------------------------------
  // Dispatch to AI CLI
  // -----------------------------------------------------------------------

  private async dispatchAi(
    prompt: string,
    chatId: string,
    onStreamUpdate?: (text: string) => void,
  ): Promise<AiResult> {
    const { aiCli, codebuddy: cbConfig, cursor: curConfig, codex: codexConfig } = this.config;
    const model = models.get(chatId);

    if (aiCli === "codebuddy" && cbConfig) {
      const result = await runCodebuddy({
        prompt,
        chatId,
        config: cbConfig,
        workdir: this.workdir,
        codebuddyBin: this.codebuddyBin,
        model,
        onStreamUpdate,
      });
      if (result.sessionId) setCodebuddySession(chatId, result.sessionId);
      return result;
    }

    if (aiCli === "cursor" && curConfig) {
      const result = await runCursor({
        prompt,
        chatId,
        config: curConfig,
        workspace: this.workdir,
        agentBin: this.cursorAgentBin,
        model,
        onStreamUpdate,
      });
      if (result.sessionId) setCursorSession(chatId, result.sessionId);
      return result;
    }

    if (aiCli === "codex" && codexConfig && this.codexBin) {
      const result = await runCodex({
        prompt,
        chatId,
        config: codexConfig,
        workdir: this.workdir,
        codexBin: this.codexBin,
        model,
        onStreamUpdate,
      });
      if (result.sessionId) setCodexSession(chatId, result.sessionId);
      return result;
    }

    throw new Error(`Cannot dispatch: no config for "${aiCli}"`);
  }

  // -----------------------------------------------------------------------
  // Session helpers
  // -----------------------------------------------------------------------

  private clearSession(chatId: string): void {
    if (this.config.aiCli === "codebuddy") clearCodebuddySession(chatId);
    if (this.config.aiCli === "cursor") clearCursorSession(chatId);
    if (this.config.aiCli === "codex") clearCodexSession(chatId);
    cumUsage.delete(chatId);
    scheduleSave();
  }

  private get label(): string {
    return `${this.config.name} (${this.config.platform}→${this.config.aiCli})`;
  }
}
