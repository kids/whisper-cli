// =============================================================================
// Outgoing attachments — the agent asks, code sends (no IM credentials in prompts)
// =============================================================================
//   [[image]] /abs/or/relative/plot.png       → image message
//   [[file]]  /abs/or/relative/report.html    → file message (html / md / pdf / csv / zip …)
// One per line (lines inside ``` fences are ignored); the lines are stripped from
// the reply. A path must live under an allowed root (chat workspace, bot workdir,
// project dirs, tmp, WHISPER_SEND_ROOTS) and must not look like a secret (.env,
// keys, .ssh …). Bare image paths in the reply are still picked up as a quiet
// fallback; bare non-image paths are never sent (they used to be — leak risk).
// Platform-neutral: the platform client only needs sendAgentImages / sendAgentFiles.
// =============================================================================
import { existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AgentFile, AgentImage } from "./types";

export interface SendOp { kind: "image" | "file"; raw: string }
export interface Outgoing { images: AgentImage[]; files: AgentFile[]; notes: string[] }

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_ITEMS = 10;
const IMG_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".ico"]);
const OP_RE = /^[ \t>*-]*`?\[\[(image|file|图片|文件)\]\]\s*(.*?)`?\s*$/i;
const BARE_IMG_RE = /(?:^|[\s`'"(（：:])(\/[^\s`'"()（）]+\.(?:png|jpe?g|gif|webp|bmp))(?=[\s`'")）,，。；;]|$)/gi;

// secrets / credentials: never sent, whatever the agent says
const SECRET_NAME = [
  /^\.env(\..+)?$/i, /^\.(npmrc|pypirc|netrc|pgpass|git-credentials)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|gpg|asc)$/i, /^(credentials|secrets?)(\.\w+)?$/i, /^authorized_keys$|^known_hosts$/,
  /^credentials\.enc$|^\.encryption_key$/,
];
const SECRET_DIR = new Set([".ssh", ".gnupg", ".aws", ".kube", ".docker", ".git"]);

/** Pull `[[image]]` / `[[file]]` lines out of a reply */
export function extractSendOps(text: string): { text: string; ops: SendOp[] } {
  const ops: SendOp[] = [];
  const keep: string[] = [];
  let fence = false;
  for (const line of (text || "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : OP_RE.exec(line);
    if (!m) { keep.push(line); continue; }
    const kind = /image|图片/i.test(m[1]) ? "image" : "file";
    if (m[2].trim()) ops.push({ kind, raw: m[2].trim() });
  }
  return { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), ops };
}

/** Allowed roots for a reply in `workspace` (never "/") */
export function sendRoots(extra: (string | undefined)[]): string[] {
  const env = (process.env.WHISPER_SEND_ROOTS || "").split(":");
  const out: string[] = [];
  for (const r of [...extra, tmpdir(), "/tmp", ...env]) {
    if (!r || !r.trim()) continue;
    try {
      const p = realpathSync(resolve(r.trim()));
      if (p !== "/" && !out.includes(p)) out.push(p);
    } catch { /* missing root */ }
  }
  return out;
}

const within = (p: string, root: string) => { const r = relative(root, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

export function secretReason(p: string): string | undefined {
  const parts = p.split(sep).filter(Boolean);
  const name = parts[parts.length - 1] ?? "";
  if (SECRET_NAME.some((re) => re.test(name))) return "看起来是密钥 / 凭证文件";
  const dir = parts.slice(0, -1).find((d) => SECRET_DIR.has(d));
  if (dir) return `在 ${dir} 目录里`;
  return undefined;
}

function candidates(raw: string): string[] {
  const unq = raw.replace(/^[<"'`]+|[>"'`]+$/g, "").trim();
  const first = unq.split(/\s+/)[0];
  return [...new Set([unq, first].filter(Boolean))].map((p) => p.replace(/^~(?=\/|$)/, process.env.HOME || "~"));
}

/** Validate requested paths (+ bare image paths as a quiet fallback) into sendable attachments */
export function resolveOutgoing(ops: SendOp[], o: { cwd: string; roots: string[]; fallbackText?: string }): Outgoing {
  const out: Outgoing = { images: [], files: [], notes: [] };
  const seen = new Set<string>();
  const add = (kind: "image" | "file", raw: string, quiet: boolean) => {
    const say = (why: string) => { if (!quiet) out.notes.push(`⚠️ 没有发送 \`${raw}\`：${why}`); };
    if (out.images.length + out.files.length >= MAX_ITEMS) return say(`一次最多发 ${MAX_ITEMS} 个附件`);
    const path = candidates(raw).map((p) => resolve(o.cwd, p)).find((p) => existsSync(p));
    if (!path) return say("文件不存在（路径要写全，最好用绝对路径）");
    let real: string;
    try { real = realpathSync(path); } catch (e) { return say((e as Error).message); }
    if (seen.has(real)) return;
    const st = statSync(real);
    if (!st.isFile()) return say("不是普通文件");
    if (!o.roots.some((r) => within(real, r))) return say(`不在允许发送的目录里（${o.roots.map((r) => "`" + r + "`").join("、")}）`);
    const secret = secretReason(real);
    if (secret) return say(`${secret}，不发送`);
    if (st.size === 0) return say("文件是空的");
    seen.add(real);
    const isImg = IMG_EXT.has(extname(real).toLowerCase());
    if (kind === "image" && isImg && st.size <= MAX_IMAGE_BYTES) { out.images.push({ filePath: real }); return; }
    if (st.size > MAX_FILE_BYTES) return say(`超过 ${MAX_FILE_BYTES >> 20}MB`);
    if (kind === "image" && !quiet) out.notes.push(!isImg ? `ℹ️ \`${basename(real)}\` 不是图片格式，按文件发送` : `ℹ️ \`${basename(real)}\` 超过 ${MAX_IMAGE_BYTES >> 20}MB，按文件发送`);
    if (quiet && kind === "image") return; // oversized bare mention: don't surprise anyone
    out.files.push({ filePath: real, fileName: basename(real) });
  };
  for (const op of ops) add(op.kind, op.raw, false);
  if (o.fallbackText) for (const m of o.fallbackText.matchAll(BARE_IMG_RE)) add("image", m[1], true);
  return out;
}

/** System-prompt hint: how an agent gets an image / file into the chat */
export function formatSendHint(): string {
  return [
    "【往群里发图片 / 文件】",
    "需要把图片或文件发到群里时：先保存成本地文件（图表用 savefig 等存成 png；报告存成 .html / .md / .pdf / .csv），再在回复里**单独占一行**写：",
    "[[image]] /绝对路径/图.png",
    "[[file]] /绝对路径/报告.html",
    "系统会自动上传并发送（这些行不会显示给人），一次最多 10 个。不要自己调用飞书 / 企微接口、不要去找 token 或 chat_id。",
    "限制：图片 ≤10MB（png/jpg/gif/webp/bmp），其他文件 ≤30MB；文件要在当前工作区、项目目录或 /tmp 下；.env、密钥、.ssh 等不会发送。",
  ].join("\n");
}
