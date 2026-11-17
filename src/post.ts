// =============================================================================
// Render helpers — Feishu post body, Slack mrkdwn, chunking
// =============================================================================

export type PostNode = { tag: string; text?: string; [key: string]: unknown };
export type PostParagraph = PostNode[];

export interface PostBody {
  zh_cn: {
    title: string;
    content: PostParagraph[];
  };
}

const MAX_POST_BYTES = 28_000;

/** Split Markdown into Feishu post paragraphs (one md node each) */
export function markdownToPostBody(text: string, title = ""): PostBody {
  const trimmed = text.trim() || "(空)";
  const paragraphs = splitParagraphs(trimmed);
  return {
    zh_cn: {
      title: title.slice(0, 200),
      content: paragraphs.map((p) => [{ tag: "md", text: p }]),
    },
  };
}

/**
 * Markdown → Slack mrkdwn. Slack is not GFM: bold is single-asterisk, links are
 * <url|text>, and tables do not exist — a table becomes a code block so columns
 * stay aligned instead of collapsing into pipes.
 */
export function markdownToSlackMrkdwn(md: string): string {
  const out: string[] = [];
  const parts = md.split(/(```[^\n]*\n[\s\S]*?```)/g);
  for (const part of parts) {
    if (/^```/.test(part)) { out.push(part); continue; }
    const lines = part.split("\n");
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      // a table block: consecutive lines starting with |
      if (/^\s*\|/.test(lines[i])) {
        const table: string[] = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { table.push(lines[i].trim()); i++; }
        i--;
        out.push(kept.join("\n"));
        kept.length = 0;
        out.push(["```", ...table, "```"].join("\n"));
        continue;
      }
      kept.push(lines[i]);
    }
    out.push(kept.join("\n"));
  }
  return out.join("")
    .split(/(`[^`\n]+`)/g)
    .map((seg) => {
      if (/^`[^`\n]+`$/.test(seg)) return seg;
      let s = seg;
      s = s.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
      s = s.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
      s = s.replace(/__([^_\n]+)__/g, "*$1*");
      s = s.replace(/~~([^~\n]+)~~/g, "~$1~");
      s = s.replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt: string, url: string) => alt ? `<${url}|${alt}>` : url);
      s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, url: string) => `<${url}|${t}>`);
      return s;
    })
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split oversized content into multiple posts (~30KB Feishu card limit) */
export function chunkMarkdown(text: string, maxBytes = MAX_POST_BYTES): string[] {
  const trimmed = text.trim();
  if (!trimmed) return ["(空)"];
  if (Buffer.byteLength(trimmed, "utf-8") <= maxBytes) return [trimmed];

  const chunks: string[] = [];
  let buf = "";
  for (const para of splitParagraphs(trimmed)) {
    const candidate = buf ? `${buf}\n\n${para}` : para;
    if (Buffer.byteLength(candidate, "utf-8") > maxBytes) {
      if (buf) chunks.push(buf);
      if (Buffer.byteLength(para, "utf-8") > maxBytes) {
        chunks.push(...hardSplit(para, maxBytes));
        buf = "";
      } else {
        buf = para;
      }
    } else {
      buf = candidate;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.length > 0 ? chunks : [trimmed.slice(0, maxBytes)];
}

function splitParagraphs(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inFence = false;

  for (const line of text.split("\n")) {
    if (line.trim().startsWith("```")) inFence = !inFence;
    if (!inFence && line.trim() === "" && buf.trim()) {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += (buf ? "\n" : "") + line;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.length > 0 ? parts : [text];
}

function hardSplit(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxBytes, text.length);
    while (end > i && Buffer.byteLength(text.slice(i, end), "utf-8") > maxBytes) end--;
    if (end === i) end = Math.min(i + 1, text.length);
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
