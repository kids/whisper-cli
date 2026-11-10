// =============================================================================
// WeCom (企业微信) 智能机器人 adapter — WebSocket long connection (@wecom/aibot-node-sdk)
// =============================================================================
// What maps cleanly:
//   receive text / voice (already transcribed) / image / file / mixed; send markdown,
//   images and files proactively (sendMessage / uploadMedia + sendMediaMessage)
// What degrades:
//   - no message editing: the only updatable thing is the stream reply to the message
//     that triggered the turn. We open it for the "generating…" card and close it with
//     the final text; it is closed automatically after WECOM_STREAM_MAX_MS (default 5 min)
//     and the result is then posted as a new message
//   - other "cards" (watch / orc progress) are posted once and not refreshed
//   - no threads (replyInThread → false), no group creation, no group announcement
//   - incoming media URLs expire after 5 minutes, so attachments are downloaded on receipt
//   - in groups the bot only sees messages that @ it
// =============================================================================
import { WSClient, generateReqId, type WsFrame } from "@wecom/aibot-node-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentFile, AgentImage, IncomingAttachment, WeComConfig } from "../types";
import { chunkByBytes, tailByBytes, type CardOpts, type ChatEvent, type ImClient, type MessageHandler } from "./types";

const PREFIX = "wc_";
const STREAM_MAX_MS = Number(process.env.WECOM_STREAM_MAX_MS || 5 * 60_000);
const STREAM_MAX_BYTES = 20_000;           // API limit 20480
const MD_MAX_BYTES = Number(process.env.WECOM_MD_MAX_BYTES || 20_000);
const MD_FALLBACK_BYTES = 4_000;
const FRAME_TTL_MS = 6 * 60_000;
const MEDIA_TTL_MS = 60 * 60_000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

interface StreamState {
  frame: WsFrame;
  sid: string;
  startedAt: number;
  last: string;
  finished: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export function wecomChatKey(body: { chatid?: string; from?: { userid?: string } }): string {
  return PREFIX + (body.chatid || body.from?.userid || "");
}

/** Strip a leading "@机器人" mention (group messages carry it) */
export function stripMention(text: string): string {
  return text.replace(/^\s*@\S+\s*/, "").trim();
}

export class WeComClient implements ImClient {
  public readonly platform = "wecom" as const;
  private ws: WSClient;
  private handler: MessageHandler | null = null;
  private seen = new Map<string, number>();
  private frames = new Map<string, { frame: WsFrame; at: number; used: boolean }>();
  private streams = new Map<string, StreamState>();
  private media = new Map<string, { buffer: Buffer; name: string; at: number }>();

  constructor(private config: WeComConfig) {
    this.ws = new WSClient({
      botId: config.botId,
      secret: config.secret,
      maxReconnectAttempts: -1,
      logger: {
        debug: () => {},
        info: (m: string) => console.log(`[wecom] ${m}`),
        warn: (m: string, ...a: unknown[]) => console.warn(`[wecom] ${m}`, ...a),
        error: (m: string, ...a: unknown[]) => console.error(`[wecom] ${m}`, ...a),
      },
    });
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  start(): void {
    this.ws.on("authenticated", () => console.log(`[wecom] authenticated (botId=${this.config.botId.slice(0, 10)}...)`));
    this.ws.on("disconnected", (r: string) => console.warn(`[wecom] disconnected: ${r}`));
    this.ws.on("error", (e: Error) => console.error(`[wecom] error: ${e.message}`));
    this.ws.on("message", (frame: WsFrame) => {
      void this.onFrame(frame).catch((e) => console.error("[wecom] handler error:", e));
    });
    this.ws.connect();
  }

  // -----------------------------------------------------------------------
  // Incoming
  // -----------------------------------------------------------------------

  private async onFrame(frame: WsFrame): Promise<void> {
    const b = frame.body as any;
    if (!b?.msgid) return;
    if (this.isDup(b.msgid)) return;
    this.gc();
    this.frames.set(b.msgid, { frame, at: Date.now(), used: false });

    const chatId = wecomChatKey(b);
    const chatType = b.chattype === "group" ? "group" : "p2p";
    const texts: string[] = [];
    const attachments: IncomingAttachment[] = [];
    let messageType: string = b.msgtype;

    const grab = async (kind: "image" | "file", url?: string, aeskey?: string) => {
      if (!url) return;
      const key = `${b.msgid}:${attachments.length}`;
      try {
        const { buffer, filename } = await this.ws.downloadFile(url, aeskey);
        const name = filename || (kind === "image" ? "image.jpg" : "file");
        this.media.set(key, { buffer, name, at: Date.now() });
        attachments.push({ type: kind, fileKey: key, fileName: name });
      } catch (e) {
        console.error(`[wecom] download ${kind} failed:`, (e as Error).message);
        texts.push(`[${kind === "image" ? "图片" : "文件"}下载失败]`);
      }
    };

    switch (b.msgtype) {
      case "text": texts.push(b.text?.content ?? ""); break;
      case "voice": texts.push(b.voice?.content ?? ""); messageType = "text"; break;
      case "image": await grab("image", b.image?.url, b.image?.aeskey); break;
      case "file": await grab("file", b.file?.url, b.file?.aeskey); break;
      case "mixed":
        messageType = "post";
        for (const it of b.mixed?.msg_item ?? []) {
          if (it.msgtype === "text") texts.push(it.text?.content ?? "");
          else if (it.msgtype === "image") await grab("image", it.image?.url, it.image?.aeskey);
        }
        break;
      default: break; // video etc. → rejected upstream as unsupported
    }
    let text = stripMention(texts.join("\n"));
    const quoted = b.quote?.text?.content || b.quote?.voice?.content;
    if (quoted && text) text = `> 引用：${String(quoted).slice(0, 500)}\n\n${text}`;

    console.log(`[消息] wecom ${chatType} chat=${chatId.slice(0, 12)} type=${messageType} text=${text.slice(0, 80)}${attachments.length ? ` atts=${attachments.length}` : ""}`);
    const ev: ChatEvent = {
      messageId: b.msgid, chatId, chatType, messageType, text,
      senderOpenId: b.from?.userid ?? "", content: "", attachments,
    };
    await this.handler?.(ev);
  }

  // -----------------------------------------------------------------------
  // Outgoing text
  // -----------------------------------------------------------------------

  private to(chatId: string): string {
    return chatId.startsWith(PREFIX) ? chatId.slice(PREFIX.length) : chatId;
  }

  private async pushMarkdown(to: string, content: string): Promise<void> {
    const r = await this.ws.sendMessage(to, { msgtype: "markdown", markdown: { content } });
    if (r?.errcode) throw new Error(`errcode=${r.errcode} ${r.errmsg ?? ""}`);
  }

  async sendMarkdown(chatId: string, text: string): Promise<void> {
    const to = this.to(chatId);
    for (const chunk of chunkByBytes(text || " ", MD_MAX_BYTES)) {
      try {
        await this.pushMarkdown(to, chunk);
      } catch (e) {
        // unknown per-message limit on some tenants: retry in small pieces
        console.warn(`[wecom] send failed (${(e as Error).message}), retrying in ${MD_FALLBACK_BYTES}B pieces`);
        for (const small of chunkByBytes(chunk, MD_FALLBACK_BYTES)) {
          await this.pushMarkdown(to, small).catch((e2) => console.error("[wecom] send exception:", (e2 as Error).message));
        }
      }
    }
  }

  sendToChat(chatId: string, text: string): Promise<void> {
    return this.sendMarkdown(chatId, text);
  }

  sendPostMarkdown(chatId: string, text: string, title = ""): Promise<void> {
    return this.sendMarkdown(chatId, title ? `**${title}**\n\n${text}` : text);
  }

  // -----------------------------------------------------------------------
  // "Cards" = the stream reply to the triggering message
  // -----------------------------------------------------------------------

  async sendCardAndGetId(chatId: string, text: string, opts?: CardOpts): Promise<string | undefined> {
    const f = opts?.replyTo ? this.frames.get(opts.replyTo) : undefined;
    if (!f || f.used || Date.now() - f.at > STREAM_MAX_MS - 30_000) {
      // nothing to stream into: post once (unless it is just a "working…" stub), no later updates
      if (!opts?.placeholder) await this.sendMarkdown(chatId, text);
      return undefined;
    }
    f.used = true;
    const sid = generateReqId("stream");
    const s: StreamState = { frame: f.frame, sid, startedAt: f.at, last: text, finished: false };
    try {
      await this.ws.replyStream(f.frame, sid, tailByBytes(text, STREAM_MAX_BYTES), false);
    } catch (e) {
      console.warn(`[wecom] stream open failed: ${(e as Error).message}`);
      await this.sendMarkdown(chatId, text);
      return undefined;
    }
    // close it before the platform does; the caller then posts the result separately
    s.timer = setTimeout(() => {
      if (s.finished) return;
      s.finished = true;
      void this.ws.replyStream(s.frame, s.sid, tailByBytes(`${s.last}\n\n…（还在处理，完成后单独发结果）`, STREAM_MAX_BYTES), true)
        .catch((e) => console.warn(`[wecom] stream auto-close failed: ${(e as Error).message}`));
    }, Math.max(1000, STREAM_MAX_MS - (Date.now() - f.at)));
    s.timer.unref?.();
    this.streams.set(sid, s);
    return `ws:${sid}`;
  }

  async updateCardMessage(id: string, text: string): Promise<boolean> {
    const s = this.streams.get(id.replace(/^ws:/, ""));
    if (!s || s.finished) return false;
    s.last = text;
    try {
      // skips the frame while the previous one is still unacknowledged (no backlog)
      await this.ws.replyStreamNonBlocking(s.frame, s.sid, tailByBytes(text, STREAM_MAX_BYTES), false);
      return true;
    } catch (e) {
      console.warn(`[wecom] stream update failed: ${(e as Error).message}`);
      return false;
    }
  }

  async finalizeCard(id: string, text: string): Promise<boolean> {
    const s = this.streams.get(id.replace(/^ws:/, ""));
    if (!s || s.finished) return false;
    s.finished = true;
    if (s.timer) clearTimeout(s.timer);
    this.streams.delete(s.sid);
    const fits = Buffer.byteLength(text) <= STREAM_MAX_BYTES;
    try {
      await this.ws.replyStream(s.frame, s.sid, fits ? text : tailByBytes(`${s.last}\n\n（完整内容见下一条）`, STREAM_MAX_BYTES), true);
      return fits;
    } catch (e) {
      console.warn(`[wecom] stream finish failed: ${(e as Error).message}`);
      return false;
    }
  }

  async replyInThread(): Promise<boolean> {
    return false;
  }

  // -----------------------------------------------------------------------
  // Attachments
  // -----------------------------------------------------------------------

  async downloadAttachments(_messageId: string, workspace: string, attachments: IncomingAttachment[]): Promise<string[]> {
    if (!attachments.length) return [];
    const dir = join(workspace, ".whisper-uploads");
    mkdirSync(dir, { recursive: true });
    const saved: string[] = [];
    for (const att of attachments) {
      const m = this.media.get(att.fileKey);
      if (!m) throw new Error("附件已过期（企微的下载链接只有 5 分钟有效），请重新发送");
      const dest = join(dir, `${Date.now()}_${m.name.replace(/[/\\?%*:|"<>]/g, "_")}`);
      writeFileSync(dest, m.buffer);
      this.media.delete(att.fileKey);
      saved.push(dest);
    }
    return saved;
  }

  private async sendMedia(chatId: string, kind: "image" | "file", buffer: Buffer, filename: string): Promise<void> {
    const up = await this.ws.uploadMedia(buffer, { type: kind, filename });
    if (!up?.media_id) throw new Error("upload returned no media_id");
    const r = await this.ws.sendMediaMessage(this.to(chatId), kind, up.media_id);
    if (r?.errcode) throw new Error(`errcode=${r.errcode} ${r.errmsg ?? ""}`);
  }

  async sendAgentImages(chatId: string, images: AgentImage[]): Promise<void> {
    for (const img of images) {
      const label = img.filePath || "generated image";
      try {
        const buffer = img.filePath && existsSync(img.filePath) ? readFileSync(img.filePath) : img.imageData ? Buffer.from(img.imageData, "base64") : undefined;
        if (!buffer) continue;
        if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`image > 10MB (${buffer.length})`);
        await this.sendMedia(chatId, "image", buffer, img.filePath ? basename(img.filePath) : "image.png");
      } catch (e) {
        await this.sendMarkdown(chatId, `⚠️ 图片发送失败 (${label}): ${(e as Error).message.slice(0, 300)}`);
      }
    }
  }

  async sendAgentFiles(chatId: string, files: AgentFile[]): Promise<void> {
    for (const f of files) {
      try {
        if (!f.filePath || !existsSync(f.filePath)) continue;
        const buffer = readFileSync(f.filePath);
        if (buffer.length > MAX_FILE_BYTES) throw new Error(`file > 20MB (${buffer.length})`);
        await this.sendMedia(chatId, "file", buffer, f.fileName || basename(f.filePath));
      } catch (e) {
        await this.sendMarkdown(chatId, `⚠️ 文件发送失败 (${f.filePath}): ${(e as Error).message.slice(0, 300)}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private isDup(id: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    if (this.seen.has(id)) return true;
    this.seen.set(id, now);
    return false;
  }

  private gc(): void {
    const now = Date.now();
    for (const [k, f] of this.frames) if (now - f.at > FRAME_TTL_MS) this.frames.delete(k);
    for (const [k, m] of this.media) if (now - m.at > MEDIA_TTL_MS) this.media.delete(k);
    for (const [k, s] of this.streams) if (s.finished || now - s.startedAt > FRAME_TTL_MS) this.streams.delete(k);
  }
}
