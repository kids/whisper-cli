// Live check for src/announcement.ts against a throwaway group.
// Creates a bot-owned group, reads → appends → re-reads the announcement,
// verifies the revision guard, then dissolves the group.
//   npx tsx scripts/announce_check.ts [agentIndex=2]
import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync } from "node:fs";
import {
  appendAnnouncementText,
  blocksToMarkdown,
  fetchAnnouncement,
  getChatInstructions,
} from "../src/announcement";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const idx = process.argv[2] || "2";
const client = new Lark.Client({
  appId: env[`AGENT_${idx}_FEISHU_APP_ID`],
  appSecret: env[`AGENT_${idx}_FEISHU_APP_SECRET`],
  loggerLevel: Lark.LoggerLevel.error,
});

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

// Pure conversion
const md = blocksToMarkdown([
  { block_type: 1 },
  { block_type: 3, heading1: { elements: [{ text_run: { content: "规则" } }] } },
  { block_type: 12, bullet: { elements: [{ text_run: { content: "结论先行" } }] } },
  { block_type: 13, ordered: { elements: [{ text_run: { content: "a" } }] } },
  { block_type: 13, ordered: { elements: [{ text_run: { content: "b" } }] } },
  { block_type: 2, text: { elements: [{ text_run: { content: "x", text_element_style: { inline_code: true } } }, { mention_user: {} }] } },
  { block_type: 27 },
]);
check("blocksToMarkdown", md === "# 规则\n- 结论先行\n1. a\n2. b\n`x`@用户\n[图片]", JSON.stringify(md));

async function main() {
  const created: any = await client.im.chat.create({
    params: { user_id_type: "open_id" },
    data: { name: `orc-announce-check-${Date.now()}`, chat_mode: "group", chat_type: "private" },
  });
  const chatId: string | undefined = created?.data?.chat_id;
  check("create test group", created?.code === 0 && !!chatId, `code=${created?.code} msg=${created?.msg}`);
  if (!chatId) return;
  try {
    const s0 = await fetchAnnouncement(client, chatId);
    check("read empty announcement", s0.markdown === "" && !!s0.rootBlockId, `rev=${s0.revisionId}`);
    check("empty → no injection", (await getChatInstructions(client, chatId)) === undefined);

    const rev1 = await appendAnnouncementText(client, chatId, ["回复先给一句话结论", "代码改动需附测试"], s0.revisionId);
    const s1 = await fetchAnnouncement(client, chatId);
    check("append + re-read", s1.markdown === "回复先给一句话结论\n代码改动需附测试", `rev ${s0.revisionId}→${s1.revisionId} (api said ${rev1})`);

    const inj = await getChatInstructions(client, chatId);
    check("injection text", !!inj && inj.includes(`rev ${s1.revisionId}`) && inj.includes("代码改动需附测试"));

    let conflict = "";
    try { await appendAnnouncementText(client, chatId, ["stale write"], s0.revisionId); }
    catch (e) { conflict = (e as Error).message; }
    check("stale revision rejected", conflict.includes("announcement changed"), conflict);
  } finally {
    const del: any = await client.im.chat.delete({ path: { chat_id: chatId } }).catch((e: any) => e?.response?.data);
    check("dissolve test group", del?.code === 0, `code=${del?.code}`);
  }
}

main()
  .catch((e) => { console.log("FAIL unexpected", e?.response?.data ?? e?.message ?? e); failed++; })
  .finally(() => { console.log(failed ? `\n${failed} FAILED` : "\nALL PASS"); process.exit(failed ? 1 : 0); });
