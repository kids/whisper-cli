// =============================================================================
// Slack adapter — Socket Mode in, Web API out (no public inbound endpoint)
// =============================================================================
// Why Socket Mode: Feishu/WeCom/Telegram all dial out and keep a connection. Slack's
// Events API would need a public HTTPS endpoint, signature checks and a 3s ack inside
// this process; Socket Mode keeps the same "process only dials out" shape.
//
// Ids: chat key "sl_<channel>"; message ids "sl_<channel>:<ts>" (ts doubles as the
// thread id, so a reply chain maps onto Slack threads 1:1).
//
// What maps cleanly: text (mrkdwn), editable messages (chat.update), threads, files
// both ways, images, channel creation.
// What degrades:
//   - no block-level markdown / tables → ../post.ts renders mrkdwn, tables become
//     code blocks
//   - no group announcement → one pinned "[whisper-rules]" message, updated in place,
//     which also carries the revision used for optimistic concurrency
//   - no quote-reply: replyTo is ignored; threads are the only nesting
//   - chat.update is rate limited per channel (~1/s), so streaming is throttled
// =============================================================================
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentFile, AgentImage, IncomingAttachment, SlackConfig } from "../types";
import { markdownToSlackMrkdwn } from "../post";
import type { CardOpts, ChatEvent, ImClient, MessageHandler } from "./types";

const PREFIX = "sl_";
const MAX_TEXT = 3_900;                // API limit 4000 characters
const MAX_DOWNLOAD = 100 * 1024 * 1024;
const RULES_MARK = "[whisper-rules]";
const RULES_TTL_MS = 60_000;

export const slChatKey = (channel: string): string => `${PREFIX}${channel}`;
const rawChat = (chatId: string): string => (chatId.startsWith(PREFIX) ? chatId.slice(PREFIX.length) : chatId);
const msgKey = (channel: string, ts: string): string => `${PREFIX}${channel}:${ts}`;

/** "sl_C123:1712345678.123456" → channel + ts */
export function parseSlackMsgKey(key: string): { channel: string; ts: string } | undefined {
  const m = /^sl_([A-Za-z0-9]+):([\d.]+)$/.exec(key || "");
  return m ? { channel: m[1], ts: m[2] } : undefined;
}

/** Split on line boundaries, keeping code fences balanced (Slack counts characters) */
export function chunkSlackText(text: string, max = MAX_TEXT): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split(/(?<=\n)/)) {
    if (cur.length + line.length > max && cur) { out.push(cur); cur = ""; }
    if (line.length > max) { for (let i = 0; i < line.length; i += max) out.push(line.slice(i, i + max)); continue; }
    cur += line;
  }
  if (cur) out.push(cur);
  return out.map((c) => ((c.match(/```/g) || []).length % 2 ? `${c}\n\`\`\`` : c));
}

/**
 * Slack wire text → plain text for the agent: entities, mentions, channel refs and
 * links. Links become markdown so the whole pipeline keeps one format (and going back
 * out is markdownToSlackMrkdwn's job).
 */
export function slackToPlain(text: string): string {
  return (text || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/<#([A-Za-z0-9]+)\|([^>]+)>/g, "#$2")
    .replace(/<#([A-Za-z0-9]+)>/g, "#$1")
    .replace(/<@([A-Za-z0-9]+)\|([^>]+)>/g, "@$2")
    .replace(/<@([A-Za-z0-9]+)>/g, "")
    .replace(/<!(channel|here|everyone)(?:\|([^>]+))?>/g, (_m, _k, name: string) => `@${name || "channel"}`)
    .replace(/<(https?:\/\/[^|>\s]+)\|([^>]+)>/g, "[$2]($1)")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface RulesHit { ts: string; rev: number; text: string }

export class SlackClient implements ImClient {
  public readonly platform = "slack" as const;
  private api: string;
  private handler: MessageHandler | null = null;
  private botUserId = "";
  private ws: any = null;
  private running = false;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelay = 1_000;
  private seen = new Map<string, number>();
  private lastUpdate = new Map<string, number>();
  private rules = new Map<string, RulesHit & { at: number }>();

  constructor(private config: SlackConfig) {
    this.api = (config.apiBase || "https://slack.com/api").replace(/\/+$/, "");
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  // -----------------------------------------------------------------------
  // Web API
  // -----------------------------------------------------------------------

  private async call<T = any>(
    method: string,
    body: Record<string, unknown> = {},
    opts: { token?: string; form?: boolean } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.api}/${method}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${opts.token || this.config.botToken}`,
          ...(opts.form
            ? { "content-type": "application/x-www-form-urlencoded; charset=utf-8" }
            : { "content-type": "application/json; charset=utf-8" }),
        },
        body: opts.form
          ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString()
          : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(Number(res.headers.get("retry-after") || 1) * 1_000, 30_000);
        console.warn(`[slack] ${method} rate limited, retry in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      const j = (await res.json().catch(() => ({}))) as any;
      if (!j.ok) {
        const err = new Error(`${method}: ${j.error || res.status}`) as Error & { code?: string };
        err.code = j.error || String(res.status);
        throw err;
      }
      return j as T;
    }
  }

  // -----------------------------------------------------------------------
  // Socket Mode
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    const me = await this.call<{ user_id: string; team?: string }>("auth.test");
    this.botUserId = me.user_id || "";
    this.running = true;
    console.log(`[slack] auth ok (bot=${this.botUserId}, team=${me.team || "?"})`);
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (!this.running) return;
    const WS = (globalThis as any).WebSocket;
    if (!WS) throw new Error("global WebSocket missing (Node >= 22 required for Socket Mode)");
    try {
      const r = await this.call<{ url: string }>("apps.connections.open", {}, { token: this.config.appToken });
      const ws = new WS(r.url);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectDelay = 1_000;
        console.log("[slack] socket open");
      });
      ws.addEventListener("message", (ev: any) => this.onFrame(ev?.data));
      ws.addEventListener("close", () => {
        if (!this.running) return;
        console.warn("[slack] socket closed, reconnecting");
        this.scheduleReconnect();
      });
      ws.addEventListener("error", () => { /* close follows; logged there */ });
    } catch (e) {
      console.error("[slack] connect failed:", (e as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    clearTimeout(this.connectTimer);
    this.connectTimer = setTimeout(() => void this.connect(), delay);
  }

  private onFrame(raw: unknown): void {
    let frame: any;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (frame.type === "disconnect") { this.ws?.close(); return; }
    if (frame.type !== "events_api") return;              // hello, slash_commands, interactive…
    // ack inside 3s or Slack retries the same event; dedupe by event_id as well
    try { this.ws?.send(JSON.stringify({ envelope_id: frame.envelope_id })); } catch { /* socket gone */ }
    const ev = frame.payload?.event;
    if (!ev || ev.type !== "message") return;
    void this.onMessageEvent(ev, frame.payload?.event_id).catch((e) => console.error("[slack] handler:", (e as Error).message));
  }

  private async onMessageEvent(ev: any, eventId?: string): Promise<void> {
    if (this.isDup(eventId || `${ev.channel}:${ev.ts}`)) return;
    if (ev.bot_id || (this.botUserId && ev.user === this.botUserId)) return;
    // file_share carries attachments; thread_broadcast is a normal reply shown in-channel
    if (ev.subtype && ev.subtype !== "file_share" && ev.subtype !== "thread_broadcast") return;
    if (!ev.channel || !ev.ts) return;

    const files: any[] = Array.isArray(ev.files) ? ev.files : [];
    const attachments: IncomingAttachment[] = files.map((f) => ({
      type: String(f.mimetype || "").startsWith("image/") ? "image" : "file",
      fileKey: String(f.url_private || f.url_private_download || ""),
      fileName: f.name || undefined,
    }));

    const event: ChatEvent = {
      messageId: msgKey(ev.channel, ev.ts),
      chatId: slChatKey(ev.channel),
      chatType: ev.channel_type === "im" ? "p2p" : "group",
      messageType: attachments.length ? (attachments.some((a) => a.type === "image") ? "image" : "file") : "text",
      text: slackToPlain(ev.text),
      senderOpenId: ev.user || "",
      content: ev.text || "",
      attachments,
      rootId: ev.thread_ts && ev.thread_ts !== ev.ts ? msgKey(ev.channel, ev.thread_ts) : undefined,
    };
    await this.handler?.(event);
  }

  private isDup(key: string): boolean {
    if (!key) return false;
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 500) {
      const cut = Date.now() - 10 * 60_000;
      for (const [k, t] of this.seen) if (t < cut) this.seen.delete(k);
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Outgoing
  // -----------------------------------------------------------------------

  private async postText(channel: string, text: string, threadTs?: string, opts: { placeholder?: boolean } = {}): Promise<string | undefined> {
    const md = markdownToSlackMrkdwn(text);
    if (!md || opts.placeholder) return undefined;
    let first: string | undefined;
    for (const piece of chunkSlackText(md)) {
      const r = await this.call<{ ts: string }>("chat.postMessage", {
        channel, text: piece, mrkdwn: true, unfurl_links: false, unfurl_media: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
      if (!first) first = r.ts;
    }
    return first;
  }

  async sendToChat(chatId: string, text: string): Promise<void> {
    await this.postText(rawChat(chatId), text);
  }

  async sendMarkdown(chatId: string, text: string): Promise<void> {
    await this.postText(rawChat(chatId), text);
  }

  async sendPostMarkdown(chatId: string, text: string, title?: string): Promise<void> {
    await this.postText(rawChat(chatId), title ? `*${title}*\n\n${text}` : text);
  }

  async sendCardAndGetId(chatId: string, text: string, opts?: CardOpts): Promise<string | undefined> {
    // No quote-reply on Slack: replyTo would open a new thread per message, so it is ignored.
    void opts;
    const channel = rawChat(chatId);
    const ts = await this.postText(channel, text);
    return ts ? msgKey(channel, ts) : undefined;
  }

  private async throttle(channel: string): Promise<void> {
    const min = Number(process.env.SLACK_UPDATE_MIN_MS || 1_100);
    const wait = (this.lastUpdate.get(channel) ?? 0) + min - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastUpdate.set(channel, Date.now());
  }

  async updateCardMessage(id: string, text: string): Promise<boolean> {
    const p = parseSlackMsgKey(id);
    if (!p) return false;
    try {
      await this.throttle(p.channel);
      await this.call("chat.update", { channel: p.channel, ts: p.ts, text: clip(markdownToSlackMrkdwn(text), MAX_TEXT), mrkdwn: true });
      return true;
    } catch (e) {
      const code = (e as Error & { code?: string }).code;
      if (code !== "message_not_found" && code !== "cant_update_message") console.error("[slack] updateCard:", (e as Error).message);
      return false;
    }
  }

  /** Slack messages stay editable; the last update is just another chat.update */
  finalizeCard(id: string, text: string): Promise<boolean> {
    return this.updateCardMessage(id, text);
  }

  async replyInThread(messageId: string, text: string): Promise<boolean> {
    const p = parseSlackMsgKey(messageId);
    if (!p) return false;
    try { await this.postText(p.channel, text, p.ts); return true; } catch { return false; }
  }

  async replyCardInThread(messageId: string, text: string): Promise<string | undefined> {
    const p = parseSlackMsgKey(messageId);
    if (!p) return undefined;
    try {
      const ts = await this.postText(p.channel, text, p.ts);
      return ts ? msgKey(p.channel, ts) : undefined;
    } catch { return undefined; }
  }

  // -----------------------------------------------------------------------
  // Files
  // -----------------------------------------------------------------------

  async downloadAttachments(_messageId: string, workspace: string, attachments: IncomingAttachment[]): Promise<string[]> {
    if (!attachments.length) return [];
    const dir = join(workspace, ".slack-uploads");
    mkdirSync(dir, { recursive: true });
    const saved: string[] = [];
    for (const att of attachments) {
      if (!/^https?:\/\//.test(att.fileKey)) continue;
      const res = await fetch(att.fileKey, {
        headers: { authorization: `Bearer ${this.config.botToken}` },
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`download ${res.status} ${res.statusText}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_DOWNLOAD) throw new Error(`attachment too large (${buf.length} bytes)`);
      const safe = (att.fileName || `${att.type}_${Date.now()}`).replace(/[/\\?%*:|"<>]/g, "_");
      const dest = join(dir, `${Date.now()}_${safe}`);
      writeFileSync(dest, buf);
      saved.push(dest);
      console.log(`[slack] downloaded ${att.type} → ${dest}`);
    }
    return saved;
  }

  private async upload(channel: string, data: Buffer, filename: string): Promise<void> {
    const ticket = await this.call<{ upload_url: string; file_id: string }>("files.getUploadURLExternal", {
      filename, length: data.length,
    }, { form: true });
    const put = await fetch(ticket.upload_url, { method: "PUT", body: new Uint8Array(data), signal: AbortSignal.timeout(180_000) });
    if (!put.ok) throw new Error(`upload ${put.status}`);
    await this.call("files.completeUploadExternal", {
      files: JSON.stringify([{ id: ticket.file_id, title: filename }]),
      channel_id: channel,
    }, { form: true });
  }

  async sendAgentImages(chatId: string, images: AgentImage[]): Promise<void> {
    const channel = rawChat(chatId);
    for (const img of images) {
      try {
        const data = img.filePath
          ? readFileSync(img.filePath)
          : img.imageData
            ? Buffer.from(img.imageData.replace(/^data:[^;]+;base64,/, ""), "base64")
            : undefined;
        if (!data?.length) continue;
        const name = img.filePath ? basename(img.filePath) : `image-${Date.now()}.png`;
        await this.upload(channel, data, name);
      } catch (e) {
        console.error("[slack] send image:", (e as Error).message);
      }
    }
  }

  async sendAgentFiles(chatId: string, files: AgentFile[]): Promise<void> {
    const channel = rawChat(chatId);
    for (const f of files) {
      try {
        await this.upload(channel, readFileSync(f.filePath), f.fileName || basename(f.filePath));
      } catch (e) {
        console.error("[slack] send file:", (e as Error).message);
      }
    }
  }

  async createSessionChat(name: string, ownerId: string): Promise<{ chatId: string | null; message: string }> {
    try {
      const ch = await this.call<{ channel?: { id?: string; name?: string } }>("conversations.create", { name, is_private: true });
      const id = ch.channel?.id;
      if (!id) return { chatId: null, message: "Slack 没有返回频道 id" };
      if (ownerId) await this.call("conversations.invite", { channel: id, users: ownerId }).catch(() => { /* bot may lack scope */ });
      return { chatId: slChatKey(id), message: `已创建 Slack 频道 #${ch.channel?.name || name}` };
    } catch (e) {
      return { chatId: null, message: (e as Error).message };
    }
  }

  // -----------------------------------------------------------------------
  // Instructions (= one pinned "[whisper-rules]" message)
  // -----------------------------------------------------------------------

  private async findRules(channel: string): Promise<RulesHit | undefined> {
    const hit = this.rules.get(channel);
    if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit;
    try {
      // pins.* predates JSON bodies: form-encoded only, otherwise invalid_arguments
      const r = await this.call<{ items?: { message?: { text?: string; ts?: string } }[] }>("pins.list", { channel }, { form: true });
      for (const item of r.items ?? []) {
        const text = item.message?.text || "";
        if (!text.startsWith(RULES_MARK)) continue;
        const rev = Number(/rev=(\d+)/.exec(text)?.[1] ?? 0);
        const body = text.replace(new RegExp(`^${escapeRe(RULES_MARK)}\\s*rev=\\d+\\n?`), "").trim();
        const found = { ts: item.message!.ts!, rev, text: body, at: Date.now() };
        this.rules.set(channel, found);
        return found;
      }
    } catch (e) {
      // missing pins:read → treat as "no announcement", callers fall back to chat memory
      const code = (e as Error & { code?: string }).code;
      if (code !== "missing_scope" && code !== "not_pinned") console.warn("[slack] pins.list:", (e as Error).message);
    }
    return undefined;
  }

  async getInstructions(chatId: string): Promise<string | undefined> {
    const hit = await this.findRules(rawChat(chatId));
    return hit?.text || undefined;
  }

  async instructionsRevision(chatId: string): Promise<number> {
    return (await this.findRules(rawChat(chatId)))?.rev ?? 0;
  }

  async appendInstructions(chatId: string, paragraphs: string[], expectRevision: number): Promise<number> {
    const channel = rawChat(chatId);
    const hit = await this.findRules(channel);
    const rev = hit?.rev ?? 0;
    if (rev !== expectRevision) {
      throw new Error(`announcement changed (rev ${expectRevision} → ${rev}); re-read and confirm again`);
    }
    const next = [hit?.text || "", ...paragraphs].filter(Boolean).join("\n");
    const newRev = rev + 1;
    const text = `${RULES_MARK} rev=${newRev}\n${next}`;
    if (hit) {
      await this.call("chat.update", { channel, ts: hit.ts, text, mrkdwn: true });
    } else {
      const r = await this.call<{ ts: string }>("chat.postMessage", { channel, text, mrkdwn: true, unfurl_links: false });
      await this.call("pins.add", { channel, timestamp: r.ts }, { form: true }).catch(() => { /* pins:write missing → degraded to "no announcement" */ });
    }
    this.rules.delete(channel);
    return newRev;
  }
}
