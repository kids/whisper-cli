// =============================================================================
// Telegram Bot API adapter — long polling (getUpdates), no extra dependency
// =============================================================================
// Ids: chat key "tg_<chat id>"; message ids "tg_<chat id>:<message_id>" so they are
// globally unique and a reply to a bot message carries the card id as rootId.
// Supported: text / caption, photo, document, editable cards (editMessageText),
// reply-to as a thread stand-in, sendPhoto / sendDocument.
// Not available: group creation, group announcement. In groups the bot only sees
// all messages if privacy mode is off (BotFather /setprivacy), else @mentions,
// replies to it and /commands.
// =============================================================================
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentFile, AgentImage, IncomingAttachment, TelegramConfig } from "../types";
import { type ChatEvent, type ImClient, type MessageHandler } from "./types";

const PREFIX = "tg_";
const MAX_CHARS = 4000;                 // API limit 4096 (after entity parsing)
const MAX_DOWNLOAD = 20 * 1024 * 1024;  // getFile limit
const MAX_UPLOAD = 50 * 1024 * 1024;

export function tgChatKey(chatId: number | string): string {
  return `${PREFIX}${chatId}`;
}
function parseMsgKey(key: string): { chat: string; mid: number } | undefined {
  const m = /^tg_(-?\d+):(\d+)$/.exec(key);
  return m ? { chat: m[1], mid: Number(m[2]) } : undefined;
}
const rawChat = (chatId: string) => (chatId.startsWith(PREFIX) ? chatId.slice(PREFIX.length) : chatId);

// ---- markdown → Telegram HTML (small subset; plain-text fallback on parse errors) ----

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mdToTelegramHtml(md: string): string {
  const out: string[] = [];
  const parts = md.split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    const fence = /^```([^\n]*)\n([\s\S]*?)```$/.exec(part);
    if (fence) {
      const lang = fence[1].trim();
      out.push(lang ? `<pre><code class="language-${esc(lang)}">${esc(fence[2])}</code></pre>` : `<pre>${esc(fence[2])}</pre>`);
      continue;
    }
    const inline = part.split(/(`[^`\n]+`)/g).map((seg) => {
      if (/^`[^`\n]+`$/.test(seg)) return `<code>${esc(seg.slice(1, -1))}</code>`;
      let s = esc(seg);
      s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
      s = s.replace(/^&gt;\s?(.*)$/gm, "┃ $1");
      s = s.replace(/^---+$/gm, "──────");
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
      s = s.replace(/__([^_\n]+)__/g, "<u>$1</u>");
      s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => `<a href="${u.replace(/"/g, "&quot;")}">${t}</a>`);
      return s;
    });
    out.push(inline.join(""));
  }
  return out.join("");
}

/** Split long markdown on line boundaries, never inside a ``` block when avoidable */
export function chunkText(text: string, max = MAX_CHARS): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (cur.length + line.length > max && cur) { chunks.push(cur); cur = ""; }
    if (line.length > max) { for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max)); continue; }
    cur += line;
  }
  if (cur) chunks.push(cur);
  // keep code fences balanced per chunk
  return chunks.map((c) => ((c.match(/```/g) || []).length % 2 ? c + "\n```" : c));
}

// ---- client -----------------------------------------------------------------------

export class TelegramClient implements ImClient {
  public readonly platform = "telegram" as const;
  private api: string;
  private fileBase: string;
  private handler: MessageHandler | null = null;
  private offset = 0;
  private running = false;
  private username = "";
  private botId = 0;
  private lastEdit = new Map<string, string>();

  constructor(private config: TelegramConfig) {
    const base = (config.apiBase || "https://api.telegram.org").replace(/\/+$/, "");
    this.api = `${base}/bot${config.botToken}`;
    this.fileBase = `${base}/file/bot${config.botToken}`;
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  private async call<T = any>(method: string, body?: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<T> {
    const isForm = body instanceof FormData;
    const res = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number; parameters?: { retry_after?: number } };
    if (!j.ok) {
      const err = new Error(`${method}: ${j.error_code ?? res.status} ${j.description ?? ""}`) as Error & { code?: number; retryAfter?: number };
      err.code = j.error_code ?? res.status;
      err.retryAfter = j.parameters?.retry_after;
      throw err;
    }
    return j.result as T;
  }

  async start(): Promise<void> {
    const me = await this.call<{ id: number; username: string }>("getMe");
    this.username = me.username;
    this.botId = me.id;
    console.log(`[telegram] logged in as @${me.username}`);
    this.running = true;
    void this.poll();
  }

  stop(): void {
    this.running = false;
  }

  private async poll(): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const ups = await this.call<any[]>("getUpdates", { offset: this.offset, timeout: 50, allowed_updates: ["message"] }, 65_000);
        backoff = 1000;
        for (const u of ups) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          if (u.message) void this.onUpdate(u.message).catch((e) => console.error("[telegram] handler error:", e));
        }
      } catch (e) {
        const err = e as Error & { code?: number };
        if (err.code === 409) console.error("[telegram] another getUpdates consumer / webhook is active for this token");
        else console.warn(`[telegram] poll failed: ${err.message}`);
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  private async onUpdate(m: any): Promise<void> {
    if (m.from?.is_bot) return;
    const chat = tgChatKey(m.chat.id);
    const chatType = m.chat.type === "private" ? "p2p" : "group";
    let text: string = m.text ?? m.caption ?? "";
    // "/help@my_bot" → "/help"; leading "@my_bot " mention → removed
    if (this.username) {
      text = text.replace(new RegExp(`^(/\\w+)@${this.username}\\b`, "i"), "$1");
      text = text.replace(new RegExp(`^\\s*@${this.username}\\b\\s*`, "i"), "");
    }
    text = text.trim();
    const attachments: IncomingAttachment[] = [];
    let messageType = "text";
    if (Array.isArray(m.photo) && m.photo.length) {
      const best = m.photo[m.photo.length - 1];
      attachments.push({ type: "image", fileKey: best.file_id, fileName: "photo.jpg" });
      messageType = "image";
    } else if (m.document) {
      attachments.push({ type: m.document.mime_type?.startsWith("image/") ? "image" : "file", fileKey: m.document.file_id, fileName: m.document.file_name || "file" });
      messageType = "file";
    } else if (m.text === undefined) {
      messageType = m.sticker ? "sticker" : m.voice ? "voice" : m.video ? "video" : "other";
    }
    const reply = m.reply_to_message;
    if (reply && !reply.from?.is_bot) {
      const quoted: string = reply.text ?? reply.caption ?? "";
      if (quoted && text) text = `> 引用：${quoted.slice(0, 500)}\n\n${text}`;
    }
    console.log(`[消息] telegram ${chatType} chat=${chat} type=${messageType} text=${text.slice(0, 80)}${attachments.length ? ` atts=${attachments.length}` : ""}`);
    const ev: ChatEvent = {
      messageId: `${chat}:${m.message_id}`, chatId: chat, chatType, messageType, text,
      senderOpenId: String(m.from?.id ?? ""), content: "", attachments,
      rootId: reply && reply.from?.id === this.botId ? `${chat}:${reply.message_id}` : undefined,
    };
    await this.handler?.(ev);
  }

  // -----------------------------------------------------------------------
  // Outgoing
  // -----------------------------------------------------------------------

  /** Send one message as HTML, falling back to plain text if Telegram rejects the markup */
  private async sendOne(chat: string, text: string, extra: Record<string, unknown> = {}): Promise<number | undefined> {
    const body = { chat_id: chat, link_preview_options: { is_disabled: true }, ...extra };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await this.call<{ message_id: number }>("sendMessage", { ...body, text: mdToTelegramHtml(text), parse_mode: "HTML" });
        return r.message_id;
      } catch (e) {
        const err = e as Error & { code?: number; retryAfter?: number };
        if (err.code === 429 && err.retryAfter && attempt === 0) { await new Promise((r) => setTimeout(r, err.retryAfter! * 1000)); continue; }
        if (err.code === 400) {
          try { return (await this.call<{ message_id: number }>("sendMessage", { ...body, text })).message_id; }
          catch (e2) { console.error("[telegram] send failed:", (e2 as Error).message); return undefined; }
        }
        console.error("[telegram] send failed:", err.message);
        return undefined;
      }
    }
    return undefined;
  }

  async sendMarkdown(chatId: string, text: string): Promise<void> {
    for (const c of chunkText(text || " ")) await this.sendOne(rawChat(chatId), c);
  }

  sendToChat(chatId: string, text: string): Promise<void> {
    return this.sendMarkdown(chatId, text);
  }

  sendPostMarkdown(chatId: string, text: string, title = ""): Promise<void> {
    return this.sendMarkdown(chatId, title ? `**${title}**\n\n${text}` : text);
  }

  async sendCardAndGetId(chatId: string, text: string): Promise<string | undefined> {
    const chat = rawChat(chatId);
    const mid = await this.sendOne(chat, chunkText(text)[0]);
    return mid ? `${tgChatKey(chat)}:${mid}` : undefined;
  }

  async updateCardMessage(id: string, text: string): Promise<boolean> {
    const k = parseMsgKey(id);
    if (!k) return false;
    if (text.length > MAX_CHARS) text = "…\n" + text.slice(-(MAX_CHARS - 2));
    if (this.lastEdit.get(id) === text) return true;
    const body = { chat_id: k.chat, message_id: k.mid, link_preview_options: { is_disabled: true } };
    try {
      await this.call("editMessageText", { ...body, text: mdToTelegramHtml(text), parse_mode: "HTML" });
    } catch (e) {
      const err = e as Error & { code?: number };
      if (/not modified/i.test(err.message)) return true;
      if (err.code === 429) return true; // streaming update dropped; the final edit retries
      if (err.code !== 400) { console.warn(`[telegram] edit failed: ${err.message}`); return false; }
      try { await this.call("editMessageText", { ...body, text }); }
      catch (e2) { if (!/not modified/i.test((e2 as Error).message)) { console.warn(`[telegram] edit failed: ${(e2 as Error).message}`); return false; } }
    }
    this.lastEdit.set(id, text);
    if (this.lastEdit.size > 500) this.lastEdit.delete(this.lastEdit.keys().next().value!);
    return true;
  }

  async finalizeCard(id: string, text: string): Promise<boolean> {
    if (text.length > MAX_CHARS) {
      await this.updateCardMessage(id, "✅ 完成，见下方。");
      return false;
    }
    for (let i = 0; i < 3; i++) {
      try {
        const k = parseMsgKey(id);
        if (!k) return false;
        // bypass the 429 swallow of streaming updates: final text must land
        await this.call("editMessageText", { chat_id: k.chat, message_id: k.mid, text: mdToTelegramHtml(text), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        return true;
      } catch (e) {
        const err = e as Error & { code?: number; retryAfter?: number };
        if (/not modified/i.test(err.message)) return true;
        if (err.code === 429) { await new Promise((r) => setTimeout(r, (err.retryAfter ?? 1) * 1000)); continue; }
        return this.updateCardMessage(id, text); // 400 parse error → plain-text path
      }
    }
    return false;
  }

  async replyInThread(messageId: string, text: string): Promise<boolean> {
    const k = parseMsgKey(messageId);
    if (!k) return false;
    const mid = await this.sendOne(k.chat, chunkText(text)[0], { reply_parameters: { message_id: k.mid, allow_sending_without_reply: true } });
    return mid !== undefined;
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
      const f = await this.call<{ file_path?: string; file_size?: number }>("getFile", { file_id: att.fileKey });
      if (!f.file_path) throw new Error("Telegram 没有返回文件路径（Bot API 只能下载 20MB 以内的文件）");
      if ((f.file_size ?? 0) > MAX_DOWNLOAD) throw new Error("文件超过 20MB，Telegram Bot API 无法下载");
      const res = await fetch(`${this.fileBase}/${f.file_path}`, { signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      const name = (att.fileName || basename(f.file_path)).replace(/[/\\?%*:|"<>]/g, "_");
      const dest = join(dir, `${Date.now()}_${name}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      saved.push(dest);
    }
    return saved;
  }

  private async upload(chatId: string, method: "sendPhoto" | "sendDocument", field: "photo" | "document", buffer: Buffer, name: string): Promise<void> {
    const form = new FormData();
    form.append("chat_id", rawChat(chatId));
    form.append(field, new Blob([new Uint8Array(buffer)]), name);
    await this.call(method, form, 120_000);
  }

  async sendAgentImages(chatId: string, images: AgentImage[]): Promise<void> {
    for (const img of images) {
      const label = img.filePath || "generated image";
      try {
        const buffer = img.filePath && existsSync(img.filePath) ? readFileSync(img.filePath) : img.imageData ? Buffer.from(img.imageData, "base64") : undefined;
        if (!buffer) continue;
        const name = img.filePath ? basename(img.filePath) : "image.png";
        // sendPhoto recompresses and caps at 10MB; big images go as documents
        if (buffer.length <= 10 * 1024 * 1024) await this.upload(chatId, "sendPhoto", "photo", buffer, name);
        else await this.upload(chatId, "sendDocument", "document", buffer, name);
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
        if (buffer.length > MAX_UPLOAD) throw new Error(`file > 50MB (${buffer.length})`);
        await this.upload(chatId, "sendDocument", "document", buffer, f.fileName || basename(f.filePath));
      } catch (e) {
        await this.sendMarkdown(chatId, `⚠️ 文件发送失败 (${f.filePath}): ${(e as Error).message.slice(0, 300)}`);
      }
    }
  }
}
