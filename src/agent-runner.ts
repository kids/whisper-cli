// =============================================================================
// Agent Runner — orchestrates one (Platform + AI CLI) pair
// =============================================================================
import type { AgentConfig } from "./types";
import { FeishuClient, type FeishuMessageEvent } from "./platform/feishu";
import {
  runCodebuddy,
  clearCodebuddySession,
  type RunCodebuddyOptions,
} from "./ai/codebuddy";
import {
  runCursor,
  stopCursorRun,
  type RunCursorOptions,
} from "./ai/cursor";

// ---------------------------------------------------------------------------
// Busy lock — prevent concurrent runs in the same chat
// ---------------------------------------------------------------------------

const BUSY_CHATS = new Map<string, number>();
const BUSY_MAX_MS = 35 * 60 * 1000;

function isBusy(chatId: string): boolean {
  const start = BUSY_CHATS.get(chatId);
  if (start === undefined) return false;
  if (Date.now() - start >= BUSY_MAX_MS) {
    BUSY_CHATS.delete(chatId);
    return false;
  }
  return true;
}

function setBusy(chatId: string): void { BUSY_CHATS.set(chatId, Date.now()); }
function clearBusy(chatId: string): void { BUSY_CHATS.delete(chatId); }

// ---------------------------------------------------------------------------
// Usage footer
// ---------------------------------------------------------------------------

function formatUsageFooter(aiResult: { model?: string; usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens: number } }): string {
  const u = aiResult.usage;
  if (!u) return "";
  const parts: string[] = [];
  if (aiResult.model) parts.push(`模型 \`${aiResult.model}\``);
  parts.push(`输入 ${u.inputTokens.toLocaleString("en-US")}`);
  parts.push(`输出 ${u.outputTokens.toLocaleString("en-US")}`);
  if (u.cacheReadTokens) parts.push(`缓存读 ${u.cacheReadTokens.toLocaleString("en-US")}`);
  if (u.cacheWriteTokens) parts.push(`缓存写 ${u.cacheWriteTokens.toLocaleString("en-US")}`);
  parts.push(`合计 ${u.totalTokens.toLocaleString("en-US")}`);
  return `\n\n---\n${parts.join(" · ")}`;
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

  constructor(
    config: AgentConfig,
    workdir: string,
    codebuddyBin?: string,
    cursorAgentBin?: string,
  ) {
    this.config = config;
    this.workdir = workdir;
    this.codebuddyBin = codebuddyBin;
    this.cursorAgentBin = cursorAgentBin;
  }

  async start(): Promise<void> {
    const { platform } = this.config;

    if (platform === "feishu") {
      if (!this.config.feishu) throw new Error("Missing Feishu config");
      this.feishu = new FeishuClient(this.config.feishu);
      this.feishu.onMessage(this.handleFeishuMessage.bind(this));
      this.feishu.start();
      console.log(`[${this.label}] Feishu WebSocket started (appId=${this.config.feishu.appId.slice(0, 10)}...)`);
    }

    if (platform === "wecom") {
      console.log(`[${this.label}] WeCom platform not yet implemented — skipping`);
      // TODO: Implement WeCom webhook/WebSocket adapter
    }
  }

  // -----------------------------------------------------------------------
  // Message handler
  // -----------------------------------------------------------------------

  private async handleFeishuMessage(ev: FeishuMessageEvent): Promise<void> {
    // Don't respond to non-text / empty messages
    if (!["text", "post"].includes(ev.messageType)) return;

    const text = ev.text;
    if (!text) return;

    // Allowlist check
    if (this.config.allowlist.size > 0 && !this.config.allowlist.has(ev.senderOpenId)) {
      console.log(`[${this.label}] blocked sender: ${ev.senderOpenId}`);
      await this.feishu?.sendToChat(ev.chatId, "⛔ You are not authorized to use this bot.");
      return;
    }

    // Handle commands
    const handled = await this.handleCommand(ev);
    if (handled) return;

    // Run AI
    await this.runAiAndReply(ev);
  }

  // -----------------------------------------------------------------------
  // Commands
  // -----------------------------------------------------------------------

  private async handleCommand(ev: FeishuMessageEvent): Promise<boolean> {
    const text = ev.text.trim();
    const feishu = this.feishu!;

    if (text === "/reset") {
      if (this.config.aiCli === "codebuddy") clearCodebuddySession(ev.chatId);
      if (this.config.aiCli === "cursor") {
        const { clearCursorSession } = await import("./ai/cursor");
        clearCursorSession(ev.chatId);
      }
      clearBusy(ev.chatId);
      await feishu.sendToChat(ev.chatId, "🔄 Session reset. Next message starts fresh.");
      return true;
    }

    if (text === "/help") {
      await feishu.sendToChat(ev.chatId, [
        `**${this.config.name}** | \`${this.config.aiCli}\` on \`${this.config.platform}\``,
        "",
        "Commands:",
        "• `/reset` — Clear session and start fresh",
        "• `/stop` — Stop the current running task",
        "• `/help` — Show this help",
        "• `/status` — Show agent status",
        "",
        "Any other message runs the AI CLI on this machine.",
      ].join("\n"));
      return true;
    }

    if (text === "/stop") {
      if (this.config.aiCli === "cursor") {
        const stopped = stopCursorRun(ev.chatId);
        if (stopped) {
          await feishu.sendToChat(ev.chatId, "⏹️ Stop signal sent. Finishing current run…");
        } else {
          await feishu.sendToChat(ev.chatId, "No active run to stop.");
        }
      } else {
        // For codebuddy, just release the busy lock
        clearBusy(ev.chatId);
        await feishu.sendToChat(ev.chatId, "⏹️ Busy lock released. Send /reset to clear session.");
      }
      return true;
    }

    if (text === "/status") {
      const busy = isBusy(ev.chatId);
      await feishu.sendToChat(ev.chatId, [
        `**${this.config.name}**`,
        `Platform: \`${this.config.platform}\``,
        `AI CLI: \`${this.config.aiCli}\``,
        `Chat ID: \`${ev.chatId}\``,
        `Busy: ${busy ? "yes" : "no"}`,
      ].join("\n"));
      return true;
    }

    return false;
  }

  // -----------------------------------------------------------------------
  // Run AI and reply
  // -----------------------------------------------------------------------

  private async runAiAndReply(ev: FeishuMessageEvent): Promise<void> {
    const feishu = this.feishu!;
    const chatId = ev.chatId;

    // Busy lock
    if (isBusy(chatId)) {
      await feishu.sendToChat(chatId, "⏳ Previous request still processing. Please wait or send /reset.");
      return;
    }

    setBusy(chatId);
    try {
      // Send "working" indicator and get message_id for possible heartbeat
      let statusMsgId: string | undefined;
      try {
        statusMsgId = await feishu.replyAndGetId(ev.messageId, `⚙️ Working… [${this.config.aiCli}]`);
      } catch {
        await feishu.sendToChat(chatId, `⚙️ Working… [${this.config.aiCli}]`);
      }

      const result = await this.dispatchAi(ev.text, chatId);

      // Send result text
      let body = result.text || "(empty result)";
      body += formatUsageFooter(result);
      await feishu.sendToChat(chatId, body);

      // Clean up status message now that result is sent
      if (statusMsgId) {
        try {
          await feishu.editMessage(statusMsgId, `✅ Done [${this.config.aiCli}]`);
        } catch { /* best-effort */ }
      }
    } finally {
      clearBusy(chatId);
    }
  }

  private async dispatchAi(prompt: string, chatId: string) {
    const { aiCli, codebuddy: cbConfig, cursor: curConfig } = this.config;

    if (aiCli === "codebuddy" && cbConfig) {
      return runCodebuddy({
        prompt,
        chatId,
        config: cbConfig,
        workdir: this.workdir,
        codebuddyBin: this.codebuddyBin,
      });
    }

    if (aiCli === "cursor" && curConfig) {
      return runCursor({
        prompt,
        chatId,
        config: curConfig,
        workspace: this.workdir,
        agentBin: this.cursorAgentBin,
      });
    }

    throw new Error(`Cannot dispatch: no config for AI CLI "${aiCli}"`);
  }

  private get label(): string {
    return `${this.config.name} (${this.config.platform}→${this.config.aiCli})`;
  }
}
