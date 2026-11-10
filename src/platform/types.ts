// =============================================================================
// Platform-neutral chat client contract (Feishu / WeCom / Telegram)
// =============================================================================
// Chat ids are namespaced so every module can tell a real chat from an internal
// session key ("<chatId>#role:x", "orc-loop:3", …):
//   feishu  oc_xxx            (native)
//   wecom   wc_<chatid|userid>
//   tg      tg_<numeric chat id>
// Capabilities differ; adapters degrade instead of failing:
//   - updateCardMessage: Feishu/Telegram edit in place; WeCom only while the
//     reply stream for the triggering message is open (≈5 min), else false
//   - replyInThread: Feishu thread, Telegram reply-to, WeCom → false (caller posts)
//   - createSessionChat: Feishu only
//   - group announcement: Feishu only (see larkOf in ./feishu)
// =============================================================================
import type { AgentFile, AgentImage, IncomingAttachment, Platform } from "../types";

export interface ChatEvent {
  messageId: string;
  chatId: string;
  chatType: string;        // "p2p" | "group"
  messageType: string;     // "text" | "post" | "image" | "file" | other (rejected)
  text: string;            // parsed plain text
  senderOpenId: string;    // platform user id (allowlist key)
  content: string;         // raw content (debug only)
  attachments: IncomingAttachment[];
  /** set when the message was posted inside a thread / reply chain (root message id) */
  rootId?: string;
}

export type MessageHandler = (event: ChatEvent) => Promise<void> | void;

export interface CardOpts { replyTo?: string; placeholder?: boolean }

export interface ImClient {
  readonly platform: Platform;
  onMessage(handler: MessageHandler): void;
  start(): void | Promise<void>;
  sendToChat(chatId: string, text: string): Promise<void>;
  sendMarkdown(chatId: string, text: string): Promise<void>;
  sendPostMarkdown(chatId: string, text: string, title?: string): Promise<void>;
  /**
   * Message that can be updated later. `replyTo` = the triggering message (WeCom streams
   * need it); `placeholder` = text is only a "working…" stub, skip it where it could
   * never be updated (WeCom without a reply stream)
   */
  sendCardAndGetId(chatId: string, text: string, opts?: CardOpts): Promise<string | undefined>;
  /** In-place update; false if the platform refused (caller falls back to a new message) */
  updateCardMessage(id: string, text: string): Promise<boolean>;
  /** Last update of a card (WeCom closes the stream); false → caller posts the text instead */
  finalizeCard(id: string, text: string): Promise<boolean>;
  replyInThread(messageId: string, text: string): Promise<boolean>;
  /** Card reply in the message's thread, returning an id for updateCardMessage; absent = no threads (WeCom) */
  replyCardInThread?(messageId: string, text: string): Promise<string | undefined>;
  downloadAttachments(messageId: string, workspace: string, attachments: IncomingAttachment[]): Promise<string[]>;
  sendAgentImages(chatId: string, images: AgentImage[]): Promise<void>;
  sendAgentFiles(chatId: string, files: AgentFile[]): Promise<void>;
  createSessionChat?(name: string, ownerId: string, description?: string): Promise<{ chatId: string | null; message: string }>;
}

/** A real chat (any platform), as opposed to an internal session key */
export function isChatKey(id: string): boolean {
  return /^(oc_|wc_|tg_)/.test(id);
}

export const PLATFORM_LABEL: Record<Platform, string> = { feishu: "飞书", wecom: "企微", telegram: "Telegram" };

/** Split text into pieces of at most `maxBytes` UTF-8 bytes, preferring line breaks */
export function chunkByBytes(text: string, maxBytes: number): string[] {
  if (!text) return [""];
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  const push = () => { if (cur) out.push(cur); cur = ""; curBytes = 0; };
  for (const line of text.split(/(?<=\n)/)) {
    const lb = Buffer.byteLength(line);
    if (curBytes + lb <= maxBytes) { cur += line; curBytes += lb; continue; }
    push();
    if (lb <= maxBytes) { cur = line; curBytes = lb; continue; }
    // a single oversized line: cut by characters
    let piece = "";
    let pb = 0;
    for (const ch of line) {
      const cb = Buffer.byteLength(ch);
      if (pb + cb > maxBytes) { out.push(piece); piece = ""; pb = 0; }
      piece += ch; pb += cb;
    }
    cur = piece; curBytes = pb;
  }
  push();
  return out.length ? out : [""];
}

/** Keep the tail of a long streaming text within `maxBytes` */
export function tailByBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const chars = [...text];
  let bytes = Buffer.byteLength("…\n");
  let i = chars.length;
  while (i > 0) {
    const b = Buffer.byteLength(chars[i - 1]);
    if (bytes + b > maxBytes) break;
    bytes += b;
    i--;
  }
  return "…\n" + chars.slice(i).join("");
}
