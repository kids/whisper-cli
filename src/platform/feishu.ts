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
