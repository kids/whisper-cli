// =============================================================================
// Feishu (Lark) platform adapter — WebSocket long-connection mode
// =============================================================================
import * as Lark from "@larksuiteoapi/node-sdk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { AgentFile, AgentImage, FeishuConfig, IncomingAttachment } from "../types";
import { chunkMarkdown, markdownToPostBody } from "../post";

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
  attachments: IncomingAttachment[];
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

        // Parse text + attachments
        const text = parseFeishuContent(content, messageType).trim();
        const attachments = parseIncomingAttachments(content, messageType);

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
            attachments,
          });
        }
      },

      // Suppress noisy events
      "im.message.message_read_v1": async () => {},
      "im.chat.access_event.bot_p2p_chat_entered_v1": async () => {},
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
  async createSessionChat(name: string, ownerOpenId: string, description?: string): Promise<{ chatId: string | null; message: string }> {
    try {
      const resp = await this.client.im.v1.chat.create({
        params: { user_id_type: "open_id" },
        data: {
          name,
          description: description || "whisper-cli 工作群 · 在此与 AI CLI 对话",
          chat_mode: "group",
          chat_type: "private",
          user_id_list: [ownerOpenId],
        },
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
  // Attachments — download incoming / upload agent images & files
  // -----------------------------------------------------------------------

  async downloadAttachments(
    messageId: string,
    workspace: string,
    attachments: IncomingAttachment[],
  ): Promise<string[]> {
    if (attachments.length === 0) return [];
    const dir = join(workspace, ".feishu-uploads");
    mkdirSync(dir, { recursive: true });
    const saved: string[] = [];

    for (const att of attachments) {
      const resourceType = att.type === "image" ? "image" : "file";
      const resp = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: att.fileKey },
        params: { type: resourceType },
      });
      const safeName = (att.fileName || `${att.type}_${att.fileKey.slice(0, 8)}`)
        .replace(/[/\\?%*:|"<>]/g, "_");
      const dest = join(dir, `${Date.now()}_${safeName}`);
      await resp.writeFile(dest);
      saved.push(dest);
      console.log(`[feishu] downloaded ${resourceType} → ${dest}`);
    }
    return saved;
  }

  async sendAgentImages(chatId: string, images: AgentImage[]): Promise<void> {
    for (const img of images) {
      try {
        const buffer = loadImageBuffer(img);
        if (!buffer) continue;
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`image > 10MB (${buffer.length})`);
        const res = await this.client.im.image.create({
          data: { image_type: "message", image: buffer },
        });
        if (!res?.image_key) throw new Error("missing image_key");
        await this.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "image",
            content: JSON.stringify({ image_key: res.image_key }),
          },
        });
        console.log(`[feishu] sent image ${img.filePath || "base64"}`);
      } catch (err) {
        const label = img.filePath || "generated image";
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[feishu] image failed ${label}:`, msg);
        await this.sendMarkdown(chatId, `⚠️ 图片发送失败 (${label}): ${msg.slice(0, 500)}`);
      }
    }
  }

  async sendAgentFiles(chatId: string, files: AgentFile[]): Promise<void> {
    for (const f of files) {
      try {
        if (!f.filePath || !existsSync(f.filePath)) continue;
        const buffer = readFileSync(f.filePath);
        if (buffer.length > MAX_FILE_BYTES) throw new Error(`file > 30MB (${buffer.length})`);
        const fileName = f.fileName || basename(f.filePath);
        const res = await this.client.im.file.create({
          data: {
            file_type: inferFileType(fileName),
            file_name: fileName,
            file: buffer,
          },
        });
        if (!res?.file_key) throw new Error("missing file_key");
        await this.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "file",
            content: JSON.stringify({ file_key: res.file_key }),
          },
        });
        console.log(`[feishu] sent file ${f.filePath}`);
      } catch (err) {
        const label = f.filePath || "file";
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[feishu] file failed ${label}:`, msg);
        await this.sendMarkdown(chatId, `⚠️ 文件发送失败 (${label}): ${msg.slice(0, 500)}`);
      }
    }
  }

  /** Send markdown via post body with smart chunking (feishu-cursor post.ts) */
  async sendPostMarkdown(chatId: string, text: string, title = ""): Promise<void> {
    const chunks = chunkMarkdown(text);
    for (let i = 0; i < chunks.length; i++) {
      const partTitle = chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})`.trim() : title;
      const body = markdownToPostBody(chunks[i], partTitle);
      try {
        const resp = await this.client.im.v1.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "post",
            content: JSON.stringify(body),
          },
        });
        if (resp.code !== 0) {
          console.error(`[feishu] post error code=${resp.code}, falling back`);
          await this.sendMarkdown(chatId, chunks[i]);
        }
      } catch {
        await this.sendMarkdown(chatId, chunks[i]);
      }
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

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 30 * 1024 * 1024;

function loadImageBuffer(img: AgentImage): Buffer | undefined {
  if (img.filePath && existsSync(img.filePath)) return readFileSync(img.filePath);
  if (img.imageData) return Buffer.from(img.imageData, "base64");
  return undefined;
}

function inferFileType(fileName: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = extname(fileName).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".doc" || ext === ".docx") return "doc";
  if (ext === ".xls" || ext === ".xlsx") return "xls";
  if (ext === ".ppt" || ext === ".pptx") return "ppt";
  if (ext === ".mp4" || ext === ".mov") return "mp4";
  return "stream";
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
    if (messageType === "image") return "";
    if (messageType === "file") return p.file_name ? `[文件: ${p.file_name}]` : "[文件]";
  } catch { /* JSON parse failure, return raw */ }
  return content;
}

export function parseIncomingAttachments(
  content: string,
  messageType: string,
): IncomingAttachment[] {
  try {
    const p = JSON.parse(content);
    if (messageType === "file" && p.file_key) {
      return [{ type: "file", fileKey: p.file_key, fileName: p.file_name }];
    }
    if (messageType === "image" && p.image_key) {
      return [{ type: "image", fileKey: p.image_key, fileName: "image.png" }];
    }
  } catch { /* ignore */ }
  return [];
}

export function buildPromptWithAttachments(text: string, localPaths: string[]): string {
  const trimmed = text.trim();
  const base = trimmed || (localPaths.length > 0 ? "请查看并处理用户上传的附件。" : "");
  if (localPaths.length === 0) return base;
  const list = localPaths.map((p) => `- \`${p}\``).join("\n");
  return `${base}\n\n**用户上传的附件（已保存到工作区）：**\n${list}`;
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
