// =============================================================================
// Feishu (Lark) platform adapter — WebSocket long-connection mode
// =============================================================================
import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "../types";

// ---------------------------------------------------------------------------
// Message event types
// ---------------------------------------------------------------------------

export interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  chatType: string;        // "p2p" | "group"
  messageType: string;     // "text" | "post" | "image" | "file"
  text: string;            // parsed plain text
  senderOpenId: string;
  content: string;         // raw JSON content
}

export type MessageHandler = (event: FeishuMessageEvent) => Promise<void> | void;

// ---------------------------------------------------------------------------
// Client wrapper
// ---------------------------------------------------------------------------

export class FeishuClient {
  public readonly appId: string;
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private handler: MessageHandler | null = null;
  private seen = new Map<string, number>(); // dedup

  constructor(config: FeishuConfig) {
    this.appId = config.appId;
    const baseConfig = { appId: config.appId, appSecret: config.appSecret };
    this.client = new Lark.Client(baseConfig);
    this.wsClient = new Lark.WSClient({
      ...baseConfig,
      loggerLevel: Lark.LoggerLevel.info,
    });
  }

  /** Get raw Lark client for sending messages */
  getClient(): Lark.Client {
    return this.client;
  }

  /** Set the message handler */
  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  /** Start WebSocket connection and begin processing events */
  start(): void {
    const dispatcher = new Lark.EventDispatcher({});

    dispatcher.register({
      "im.message.receive_v1": async (data: any) => {
        const ev = data as Record<string, unknown>;
        const msg = ev.message as Record<string, unknown> | undefined;
        if (!msg) return;

        const messageId = msg.message_id as string;
        const chatId = msg.chat_id as string;
        const chatType = (msg.chat_type as string) || "p2p";
        const messageType = msg.message_type as string;
        const content = msg.content as string;

        // Dedup
        if (this.isDup(messageId)) return;

        // Skip bot's own messages
        const sender = ev.sender as Record<string, unknown> | undefined;
        if (sender?.sender_type === "app") return;

        // Parse text
        const text = parseFeishuContent(content, messageType).trim();

        // Extract sender open_id
        const senderOpenId = extractFeishuSenderOpenId(ev);

        if (this.handler) {
          await this.handler({
            messageId,
            chatId,
            chatType,
            messageType,
            text,
            senderOpenId,
            content,
          });
        }
      },

      // Suppress noisy events
      "im.message.message_read_v1": async () => {},
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
  }

  /** Reply to a message with markdown (renders as Feishu post) */
  async replyMarkdown(messageId: string, text: string): Promise<void> {
    const post = {
      zh_cn: {
        content: [[{ tag: "md", text: text.slice(0, 4000) }]],
      },
    };
    await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "post",
        content: JSON.stringify(post),
      },
    });
  }

  /** Send a markdown message to a chat */
  async sendToChat(chatId: string, text: string): Promise<void> {
    // Split long messages
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, 4000));
      remaining = remaining.slice(4000);
    }
    if (chunks.length === 0) chunks.push("");

    for (const chunk of chunks) {
      const post = {
        zh_cn: {
          content: [[{ tag: "md", text: chunk }]],
        },
      };
      try {
        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "post",
            content: JSON.stringify(post),
          },
        });
        if (resp.code !== 0) {
          console.error(`[feishu] send error code=${resp.code} msg=${resp.msg}`);
        }
      } catch (e) {
        console.error("[feishu] send exception:", e);
      }
    }
  }

  /** Edit an existing message (status update) */
  async editMessage(messageId: string, text: string): Promise<void> {
    const post = {
      zh_cn: {
        content: [[{ tag: "md", text: text.slice(0, 4000) }]],
      },
    };
    await this.client.im.v1.message.update({
      path: { message_id: messageId },
      data: {
        msg_type: "post",
        content: JSON.stringify(post),
      },
    });
  }

  /** Send an initial reply to get a message_id for heartbeats */
  async sendAndGetId(chatId: string, text: string): Promise<string | undefined> {
    const post = {
      zh_cn: {
        content: [[{ tag: "md", text: text.slice(0, 4000) }]],
      },
    };
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: chatId,
          msg_type: "post",
          content: JSON.stringify(post),
        },
      });
      return resp.data?.message_id;
    } catch {
      return undefined;
    }
  }

  /** Reply to get a message_id for heartbeats */
  async replyAndGetId(messageId: string, text: string): Promise<string | undefined> {
    const post = {
      zh_cn: {
        content: [[{ tag: "md", text: text.slice(0, 4000) }]],
      },
    };
    try {
      const resp = await this.client.im.v1.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "post",
          content: JSON.stringify(post),
        },
      });
      return resp.data?.message_id;
    } catch {
      return undefined;
    }
  }

  // -----------------------------------------------------------------------
  // Interactive card (schema 2.0) — for real-time streaming patches
  // -----------------------------------------------------------------------

  /** Build a Feishu interactive card (schema 2.0) with markdown body */
  static buildMarkdownCard(content: string): string {
    return JSON.stringify({
      schema: "2.0",
      config: { width_mode: "fill", update_multi: true },
      body: { elements: [{ tag: "markdown", content }] },
    });
  }

  /** Send a streaming card and return its message_id for subsequent patches */
  async sendCardAndGetId(chatId: string, text: string): Promise<string | undefined> {
    const content = FeishuClient.buildMarkdownCard(text);
    try {
      const resp = await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "interactive", content },
      });
      return resp.code === 0 ? resp.data?.message_id : undefined;
    } catch { return undefined; }
  }

  /** Patch (update in-place) an existing interactive card message */
  async updateCardMessage(messageId: string, text: string): Promise<void> {
    const content = FeishuClient.buildMarkdownCard(text);
    try {
      const resp = await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content },
      });
      if (resp.code !== 0) console.error(`[feishu] updateCard FAIL code=${resp.code} msg=${resp.msg}`);
    } catch (e) {
      console.error("[feishu] updateCard exception:", e);
    }
  }

  /**
   * Send with card-first fallback: try interactive card, fall back to text.
   * Also splits long messages.
   */
  async sendMarkdown(chatId: string, text: string): Promise<void> {
    const chunks = text.length
      ? Array.from({ length: Math.ceil(text.length / 4000) }, (_, i) => text.slice(i * 4000, i * 4000 + 4000))
      : [""];
    for (const chunk of chunks) {
      if (!chunk) { await this.sendText(chatId, ""); continue; }
      try {
        const content = FeishuClient.buildMarkdownCard(chunk);
        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: { receive_id: chatId, msg_type: "interactive", content },
        });
        if (resp.code !== 0) {
          console.error(`[feishu] card error code=${resp.code}, falling back to text`);
          await this.sendText(chatId, chunk);
        }
      } catch {
        await this.sendText(chatId, chunk);
      }
    }
  }

  /** Create a Feishu group with a fresh session */
  async createSessionChat(name: string, ownerOpenId: string): Promise<{ chatId: string | null; message: string }> {
    try {
      const resp = await this.client.im.v1.chat.create({
        params: { user_id_type: "open_id" },
        data: { name, chat_mode: "group", chat_type: "private", user_id_list: [ownerOpenId] },
      });
      if (resp.code !== 0) return { chatId: null, message: `⚠️ Failed: code=${resp.code} msg=${resp.msg}` };
      return { chatId: resp.data?.chat_id ?? null, message: `✅ Created「${name}」` };
    } catch (e) {
      return { chatId: null, message: `⚠️ Failed: ${String(e)}` };
    }
  }

  /** Send a plain text message */
  async sendText(chatId: string, chunk: string): Promise<void> {
    try {
      await this.client.im.v1.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text: chunk }) },
      });
    } catch (e) {
      console.error("[feishu] sendText exception:", e);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private isDup(id: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 60_000) this.seen.delete(k);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Content parsers
// ---------------------------------------------------------------------------

function parseFeishuContent(content: string, messageType: string): string {
  try {
    const p = JSON.parse(content);
    if (messageType === "text") return p.text || "";
    if (messageType === "post") {
      const texts: string[] = [];
      for (const lang of Object.values(p) as Array<{
        title?: string;
        content?: Array<Array<{ tag: string; text?: string }>>;
      }>) {
        if (lang?.title) texts.push(lang.title);
        if (Array.isArray(lang?.content)) {
          for (const para of lang.content) {
            for (const e of para) {
              if ((e.tag === "text" || e.tag === "md") && e.text) texts.push(e.text);
            }
          }
        }
      }
      return texts.join("\n");
    }
    if (messageType === "image") return "[Image]";
    if (messageType === "file") return p.file_name ? `[File: ${p.file_name}]` : "[File]";
  } catch { /* JSON parse failure, return raw */ }
  return content;
}

function extractFeishuSenderOpenId(ev: Record<string, unknown>): string {
  const tryId = (obj: unknown): string | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    const r = obj as Record<string, unknown>;
    if (typeof r.open_id === "string") return r.open_id;
    const sid = r.sender_id as Record<string, string> | undefined;
    return sid?.open_id || sid?.union_id;
  };

  return (
    tryId(ev.sender) ||
    tryId((ev.sender as Record<string, unknown>)?.sender_id) ||
    tryId(ev.operator_id) ||
    tryId(ev.operator) ||
    ""
  );
}
