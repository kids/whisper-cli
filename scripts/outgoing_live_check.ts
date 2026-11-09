// Live check for [[image]] / [[file]] against a throwaway Feishu group:
// reply text → extractSendOps/resolveOutgoing → FeishuClient upload+send → read back → dissolve.
//   npx tsx scripts/outgoing_live_check.ts [agentIndex=2]
import { deflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeishuClient } from "../src/platform/feishu";
import { extractSendOps, resolveOutgoing } from "../src/outgoing";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const idx = process.argv[2] || "2";
const feishu = new FeishuClient({ appId: env[`AGENT_${idx}_FEISHU_APP_ID`], appSecret: env[`AGENT_${idx}_FEISHU_APP_SECRET`] } as any);
const client: any = feishu.getClient();

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };

/** Minimal valid 64×32 RGB PNG (gradient) */
function png(): Buffer {
  const crc = (b: Buffer) => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const w = 64, h = 32;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 4; raw[o + 1] = y * 8; raw[o + 2] = 160; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function main() {
  const ws = mkdtempSync(join(tmpdir(), "outgoing-live-"));
  writeFileSync(join(ws, "loss.png"), png());
  writeFileSync(join(ws, "report.html"), "<!doctype html><meta charset=utf-8><h1>实验报告</h1><p>loss 收敛</p>");
  writeFileSync(join(ws, "summary.md"), "# 结论\n\n- loss 在第 3 轮收敛\n");
  writeFileSync(join(ws, ".env"), "SECRET=1");

  const reply = ["训练曲线和报告如下。", "[[image]] loss.png", "[[file]] report.html", `[[file]] ${join(ws, "summary.md")}`, "[[file]] .env"].join("\n");
  const { text, ops } = extractSendOps(reply);
  const out = resolveOutgoing(ops, { cwd: ws, roots: [ws] });
  check("resolved 1 image + 2 files, .env refused", out.images.length === 1 && out.files.length === 2 && out.notes.length === 1 && text === "训练曲线和报告如下。", JSON.stringify(out.notes));

  const created: any = await client.im.chat.create({ params: { user_id_type: "open_id" }, data: { name: `outgoing-check-${Date.now()}`, chat_mode: "group", chat_type: "private" } });
  const chatId: string | undefined = created?.data?.chat_id;
  check("create test group", created?.code === 0 && !!chatId, `code=${created?.code} msg=${created?.msg}`);
  if (!chatId) return;
  try {
    await feishu.sendAgentImages(chatId, out.images);
    await feishu.sendAgentFiles(chatId, out.files);
    await new Promise((r) => setTimeout(r, 1500));
    const list: any = await client.im.v1.message.list({ params: { container_id_type: "chat", container_id: chatId, page_size: 20 } });
    const items: any[] = (list?.data?.items ?? []).filter((m: any) => m.sender?.sender_type === "app");
    const types = items.map((m) => m.msg_type);
    const names = items.filter((m) => m.msg_type === "file").map((m) => JSON.parse(m.body?.content || "{}").file_name).sort();
    check("image message delivered", types.includes("image"), types.join(","));
    check("html + md delivered as files", JSON.stringify(names) === JSON.stringify(["report.html", "summary.md"]), JSON.stringify(names));
    check("no failure notice", !items.some((m) => /发送失败/.test(m.body?.content || "")));
  } finally {
    const del: any = await client.im.chat.delete({ path: { chat_id: chatId } }).catch((e: any) => e?.response?.data);
    check("dissolve test group", del?.code === 0, `code=${del?.code}`);
    rmSync(ws, { recursive: true, force: true });
  }
}

main().catch((e) => { failed++; console.log("FAIL crashed", e); }).finally(() => { console.log(failed ? `\n${failed} FAILED` : "\nALL PASS"); process.exit(failed ? 1 : 0); });
