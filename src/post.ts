// =============================================================================
// Feishu post helpers — markdown → post body + chunking (from feishu-cursor)
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
