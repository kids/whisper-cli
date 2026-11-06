// =============================================================================
// Group announcement = the chat's agent instructions (docs/orc/002 §4)
// =============================================================================
// Read path: every run checks the announcement revision (one cheap API call);
// blocks are re-fetched and converted only when the revision changed. The text
// is injected per turn (--append-system-prompt or prompt prefix) — it is never
// written into the workspace, so chats sharing a repo don't leak into each other.
//
// Write path: append-only text blocks guarded by the revision read beforehand.
// Only docx-type announcements are supported (legacy ones answer 232097).
// =============================================================================
import type * as Lark from "@larksuiteoapi/node-sdk";

export const MAX_INSTRUCTION_CHARS = 4000;

// docx block_type → key holding the text payload
const HEADING_TYPES: Record<number, number> = { 3: 1, 4: 2, 5: 3, 6: 4, 7: 5, 8: 6, 9: 7, 10: 8, 11: 9 };
const TEXT_KEY: Record<number, string> = {
  2: "text", 3: "heading1", 4: "heading2", 5: "heading3", 6: "heading4", 7: "heading5",
  8: "heading6", 9: "heading7", 10: "heading8", 11: "heading9",
  12: "bullet", 13: "ordered", 14: "code", 15: "quote", 17: "todo",
};

export interface AnnouncementBlock {
  block_id?: string;
  block_type: number;
  parent_id?: string;
  children?: string[];
  [k: string]: any;
}

function elementsToText(elements: any[] | undefined): string {
  if (!Array.isArray(elements)) return "";
  return elements
    .map((el) => {
      if (el?.text_run?.content != null) {
        const s = String(el.text_run.content);
        const st = el.text_run.text_element_style;
        if (st?.inline_code) return `\`${s}\``;
        if (st?.link?.url) return `[${s}](${decodeURIComponent(st.link.url)})`;
        return s;
      }
      if (el?.mention_user) return "@用户";
      if (el?.mention_doc) return el.mention_doc.title ? `《${el.mention_doc.title}》` : "《文档》";
      if (el?.equation?.content) return `$${el.equation.content}$`;
      return "";
    })
    .join("");
}

/** Lossy docx-blocks → markdown (text/heading/list/code/quote/todo; others become placeholders) */
export function blocksToMarkdown(blocks: AnnouncementBlock[]): string {
  const out: string[] = [];
  let ordered = 0;
  for (const b of blocks) {
    const t = b.block_type;
    if (t === 1) continue; // page root
    if (t !== 13) ordered = 0;
    const key = TEXT_KEY[t];
    if (key) {
      const text = elementsToText(b[key]?.elements).trimEnd();
      if (HEADING_TYPES[t]) out.push(`${"#".repeat(Math.min(HEADING_TYPES[t], 6))} ${text}`);
      else if (t === 12) out.push(`- ${text}`);
      else if (t === 13) out.push(`${++ordered}. ${text}`);
      else if (t === 14) out.push("```\n" + text + "\n```");
      else if (t === 15) out.push(`> ${text}`);
      else if (t === 17) out.push(`- [${b.todo?.style?.done ? "x" : " "}] ${text}`);
      else out.push(text);
      continue;
    }
    if (t === 22) out.push("---");
    else if (t === 27) out.push("[图片]");
    else if (t === 31) out.push("[表格]");
    else if (t === 34 || t === 19) continue; // quote container / callout: children carry the text
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function truncateInstructions(md: string, max = MAX_INSTRUCTION_CHARS): { text: string; truncated: boolean } {
  if (md.length <= max) return { text: md, truncated: false };
  return { text: md.slice(0, max) + "\n…（群公告过长，已截断）", truncated: true };
}

/** Wrap instructions for injection; empty announcement → undefined (inject nothing) */
export function formatInstructions(md: string, revisionId: number): string | undefined {
  if (!md.trim()) return undefined;
  return `【本群指令 · 来自群公告 rev ${revisionId}】以下是本群的长期约束，优先级高于一般习惯，低于用户当轮的明确要求：\n\n${md}`;
}

// ---------------------------------------------------------------------------
// API (docx chat announcement)
// ---------------------------------------------------------------------------

export interface AnnouncementSnapshot {
  revisionId: number;
  markdown: string;
  truncated: boolean;
  rootBlockId?: string;
  fetchedAt: number;
}

const cache = new Map<string, AnnouncementSnapshot>();
const failUntil = new Map<string, number>();
const FAIL_BACKOFF_MS = 10 * 60 * 1000;

async function getRevision(client: Lark.Client, chatId: string): Promise<number> {
  const r: any = await (client as any).docx.chatAnnouncement.get({ path: { chat_id: chatId } });
  if (r?.code !== 0) throw new Error(`chatAnnouncement.get code=${r?.code} msg=${r?.msg}`);
  return Number(r.data?.revision_id ?? 0);
}

async function listBlocks(client: Lark.Client, chatId: string): Promise<AnnouncementBlock[]> {
  const items: AnnouncementBlock[] = [];
  let pageToken: string | undefined;
  for (let i = 0; i < 20; i++) {
    const r: any = await (client as any).docx.chatAnnouncementBlock.list({
      path: { chat_id: chatId },
      params: { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
    });
    if (r?.code !== 0) throw new Error(`chatAnnouncementBlock.list code=${r?.code} msg=${r?.msg}`);
    items.push(...(r.data?.items ?? []));
    if (!r.data?.has_more) break;
    pageToken = r.data?.page_token;
  }
  return items;
}

/** Fresh snapshot, bypassing the cache */
export async function fetchAnnouncement(client: Lark.Client, chatId: string): Promise<AnnouncementSnapshot> {
  const revisionId = await getRevision(client, chatId);
  const blocks = await listBlocks(client, chatId);
  const { text, truncated } = truncateInstructions(blocksToMarkdown(blocks));
  const snap: AnnouncementSnapshot = {
    revisionId,
    markdown: text,
    truncated,
    rootBlockId: blocks.find((b) => b.block_type === 1)?.block_id,
    fetchedAt: Date.now(),
  };
  cache.set(chatId, snap);
  return snap;
}

/**
 * Instructions to inject for this chat, or undefined (empty / unsupported /
 * API failure). Never throws: a broken announcement must not block the bot.
 */
export async function getChatInstructions(client: Lark.Client, chatId: string): Promise<string | undefined> {
  if (!chatId.startsWith("oc_")) return undefined; // not a group/p2p chat id (e.g. orc session keys)
  if ((failUntil.get(chatId) ?? 0) > Date.now()) return undefined;
  try {
    const rev = await getRevision(client, chatId);
    let snap = cache.get(chatId);
    if (!snap || snap.revisionId !== rev) snap = await fetchAnnouncement(client, chatId);
    return formatInstructions(snap.markdown, snap.revisionId);
  } catch (e) {
    failUntil.set(chatId, Date.now() + FAIL_BACKOFF_MS);
    console.warn(`[announcement] ${chatId.slice(0, 10)} unavailable, skip for 10m: ${(e as Error).message}`);
    return undefined;
  }
}

export function cachedAnnouncement(chatId: string): AnnouncementSnapshot | undefined {
  return cache.get(chatId);
}

/**
 * Append plain-text paragraphs to the announcement, guarded by `expectRevision`.
 * Throws on revision conflict so the caller can re-read and re-confirm with a human.
 */
export async function appendAnnouncementText(
  client: Lark.Client,
  chatId: string,
  paragraphs: string[],
  expectRevision: number,
): Promise<number> {
  const current = await getRevision(client, chatId);
  if (current !== expectRevision) {
    throw new Error(`announcement changed (rev ${expectRevision} → ${current}); re-read and confirm again`);
  }
  const snap = cache.get(chatId)?.revisionId === current ? cache.get(chatId)! : await fetchAnnouncement(client, chatId);
  if (!snap.rootBlockId) throw new Error("announcement root block not found");
  const r: any = await (client as any).docx.chatAnnouncementBlockChildren.create({
    path: { chat_id: chatId, block_id: snap.rootBlockId },
    params: { revision_id: current },
    data: {
      children: paragraphs.map((p) => ({ block_type: 2, text: { elements: [{ text_run: { content: p } }] } })),
    },
  });
  if (r?.code !== 0) throw new Error(`chatAnnouncementBlockChildren.create code=${r?.code} msg=${r?.msg}`);
  cache.delete(chatId);
  return Number(r.data?.document_revision_id ?? current + 1);
}
