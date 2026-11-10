// Offline checks for the platform adapters (src/platform/*): WeCom with a fake SDK client,
// Telegram with a stubbed fetch, shared helpers, and .env parsing of the new platforms.
//   npx tsx scripts/im_check.ts
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunkByBytes, isChatKey, tailByBytes } from "../src/platform/types";
import { WeComClient, stripMention, wecomChatKey } from "../src/platform/wecom";
import { TelegramClient, chunkText, mdToTelegramHtml } from "../src/platform/telegram";
import { loadAllAgents } from "../src/config";
import type { ChatEvent } from "../src/platform/types";

let failed = 0;
const check = (name: string, ok: boolean, detail: unknown = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail !== "" ? "  " + String(typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 300) : ""}`);
  if (!ok) failed++;
};
const tmp = mkdtempSync(join(tmpdir(), "im-check-"));

// ---- shared helpers ----
{
  const s = "一二三\n".repeat(1000);
  const parts = chunkByBytes(s, 1000);
  check("chunkByBytes: every piece within limit", parts.every((p) => Buffer.byteLength(p) <= 1000));
  check("chunkByBytes: lossless", parts.join("") === s);
  check("chunkByBytes: oversized single line split", chunkByBytes("字".repeat(2000), 999).every((p) => Buffer.byteLength(p) <= 999));
  const tail = tailByBytes("x".repeat(5000) + "END", 100);
  check("tailByBytes keeps the end within limit", tail.endsWith("END") && Buffer.byteLength(tail) <= 100);
  check("isChatKey", isChatKey("oc_1") && isChatKey("wc_abc") && isChatKey("tg_-100") && !isChatKey("orc-loop:3") && !isChatKey("watch-1"));
}

// ---- config ----
{
  const env = join(tmp, ".env");
  writeFileSync(env, [
    "AGENT_1_PLATFORM=wecom", "AGENT_1_AI_CLI=claude", "AGENT_1_WECOM_BOT_ID=aibX", "AGENT_1_WECOM_BOT_SECRET=s3", "AGENT_1_ADMIN_MODE=1",
    "AGENT_2_PLATFORM=telegram", "AGENT_2_AI_CLI=claude", "AGENT_2_TELEGRAM_BOT_TOKEN=123:abc",
    "AGENT_3_PLATFORM=tg", "AGENT_3_AI_CLI=claude",
    "AGENT_4_PLATFORM=wecom", "AGENT_4_AI_CLI=claude", "AGENT_4_WECOM_BOT_ID=only-id",
  ].join("\n"));
  const agents = loadAllAgents(env);
  const a1 = agents.find((a) => a.index === 1);
  const a2 = agents.find((a) => a.index === 2);
  check("wecom group parsed (bot id + secret)", a1?.platform === "wecom" && a1.wecom?.botId === "aibX" && a1.wecom?.secret === "s3");
  check("ADMIN_MODE ignored off Feishu", a1?.adminMode === false);
  check("telegram group parsed", a2?.platform === "telegram" && a2.telegram?.botToken === "123:abc");
  check("groups missing credentials skipped", !agents.some((a) => a.index === 3 || a.index === 4), agents.map((a) => a.index));
}

// ---- WeCom ----
{
  const calls: { m: string; args: any[] }[] = [];
  const fakeWs: any = {
    replyStream: async (...args: any[]) => { calls.push({ m: "replyStream", args }); return {}; },
    replyStreamNonBlocking: async (...args: any[]) => { calls.push({ m: "nb", args }); return {}; },
    sendMessage: async (...args: any[]) => { calls.push({ m: "sendMessage", args }); return {}; },
    uploadMedia: async (_b: Buffer, o: any) => { calls.push({ m: "upload", args: [o] }); return { media_id: "MID" }; },
    sendMediaMessage: async (...args: any[]) => { calls.push({ m: "media", args }); return {}; },
    downloadFile: async () => ({ buffer: Buffer.from("PNGDATA"), filename: "a.png" }),
  };
  const wc: any = new WeComClient({ botId: "b", secret: "s" });
  wc.ws = fakeWs;
  const evs: ChatEvent[] = [];
  wc.onMessage((e: ChatEvent) => { evs.push(e); });
  const frame = (body: any) => ({ cmd: "aibot_msg_callback", headers: { req_id: "r-" + body.msgid }, body });

  check("chat key: group chatid / single userid", wecomChatKey({ chatid: "G1", from: { userid: "u" } }) === "wc_G1" && wecomChatKey({ from: { userid: "u9" } }) === "wc_u9");
  check("stripMention", stripMention("@机器人 帮我看下") === "帮我看下");

  await wc.onFrame(frame({ msgid: "m1", chatid: "G1", chattype: "group", from: { userid: "alice" }, msgtype: "text", text: { content: "@Bot 停掉监控" } }));
  check("group text → event", evs[0]?.chatId === "wc_G1" && evs[0].chatType === "group" && evs[0].text === "停掉监控" && evs[0].senderOpenId === "alice", evs[0]);
  await wc.onFrame(frame({ msgid: "m1", chatid: "G1", chattype: "group", from: { userid: "alice" }, msgtype: "text", text: { content: "dup" } }));
  check("duplicate msgid dropped", evs.length === 1);
  await wc.onFrame(frame({ msgid: "m2", chattype: "single", from: { userid: "bob" }, msgtype: "voice", voice: { content: "语音转文字" } }));
  check("voice → text, single chat keyed by userid", evs[1]?.messageType === "text" && evs[1].text === "语音转文字" && evs[1].chatId === "wc_bob" && evs[1].chatType === "p2p");
  await wc.onFrame(frame({ msgid: "m3", chattype: "single", from: { userid: "bob" }, msgtype: "mixed", mixed: { msg_item: [{ msgtype: "text", text: { content: "看图" } }, { msgtype: "image", image: { url: "u", aeskey: "k" } }] } }));
  check("mixed → text + image attachment", evs[2]?.text === "看图" && evs[2].attachments.length === 1 && evs[2].attachments[0].type === "image");
  const saved = await wc.downloadAttachments("m3", tmp, evs[2].attachments);
  check("attachment written from receipt-time cache", saved.length === 1 && existsSync(saved[0]) && readFileSync(saved[0], "utf8") === "PNGDATA" && saved[0].includes(".whisper-uploads"));
  let expired = false;
  try { await wc.downloadAttachments("m3", tmp, evs[2].attachments); } catch (e) { expired = /过期/.test((e as Error).message); }
  check("cache is single-use (clear error after)", expired);

  calls.length = 0;
  const id = await wc.sendCardAndGetId("wc_G1", "⚙️ 正在生成…", { replyTo: "m1", placeholder: true });
  check("card = stream reply to the triggering message", typeof id === "string" && calls[0]?.m === "replyStream" && calls[0].args[0].headers.req_id === "r-m1" && calls[0].args[3] === false);
  check("updates go non-blocking", (await wc.updateCardMessage(id, "部分输出")) && calls.at(-1)?.m === "nb");
  check("finalize closes the stream", (await wc.finalizeCard(id, "最终答案")) && calls.at(-1)?.m === "replyStream" && calls.at(-1)!.args[2] === "最终答案" && calls.at(-1)!.args[3] === true);
  check("closed stream refuses updates", !(await wc.updateCardMessage(id, "late")) && !(await wc.finalizeCard(id, "late")));
  const id2 = await wc.sendCardAndGetId("wc_G1", "again", { replyTo: "m1", placeholder: true });
  check("one stream per message", id2 === undefined);

  await wc.onFrame(frame({ msgid: "m4", chattype: "single", from: { userid: "bob" }, msgtype: "text", text: { content: "长回答" } }));
  const id3 = await wc.sendCardAndGetId("wc_bob", "…", { replyTo: "m4" });
  const ok3 = await wc.finalizeCard(id3, "长".repeat(8000)); // 24KB > stream limit
  check("oversized final → stream closed with pointer, returns false", !ok3 && calls.at(-1)?.m === "replyStream" && String(calls.at(-1)!.args[2]).includes("完整内容见下一条"));

  calls.length = 0;
  check("placeholder without a stream is not posted", (await wc.sendCardAndGetId("wc_G1", "⚙️", { replyTo: "watch-1", placeholder: true })) === undefined && calls.length === 0);
  check("non-placeholder without a stream is posted once", (await wc.sendCardAndGetId("wc_G1", "👀 监控 #1")) === undefined && calls[0]?.m === "sendMessage");
  calls.length = 0;
  await wc.sendMarkdown("wc_G1", "**hi**");
  check("sendMarkdown → sendMessage(chatid without prefix, markdown)", calls[0]?.args[0] === "G1" && calls[0].args[1].msgtype === "markdown" && calls[0].args[1].markdown.content === "**hi**");
  calls.length = 0;
  await wc.sendMarkdown("wc_G1", "x".repeat(45_000));
  check("long markdown split under 20KB", calls.length === 3 && calls.every((c) => Buffer.byteLength(c.args[1].markdown.content) <= 20_000));
  calls.length = 0;
  const f = join(tmp, "report.html");
  writeFileSync(f, "<html/>");
  await wc.sendAgentFiles("wc_G1", [{ filePath: f }]);
  check("file → uploadMedia + sendMediaMessage", calls[0]?.m === "upload" && calls[0].args[0].type === "file" && calls[0].args[0].filename === "report.html" && calls[1]?.m === "media" && calls[1].args[0] === "G1" && calls[1].args[2] === "MID");
  check("no threads on WeCom", (await wc.replyInThread("x", "y")) === false);
}

// ---- Telegram ----
{
  check("md → html: bold/code/link/escape", mdToTelegramHtml("**粗** `a<b` [x](https://e.com) 1<2") === '<b>粗</b> <code>a&lt;b</code> <a href="https://e.com">x</a> 1&lt;2', mdToTelegramHtml("**粗** `a<b` [x](https://e.com) 1<2"));
  check("md → html: fenced code untouched inside", mdToTelegramHtml("```py\nif a < b: **x**\n```").includes('<pre><code class="language-py">if a &lt; b: **x**\n</code></pre>'));
  check("md → html: heading", mdToTelegramHtml("## 标题") === "<b>标题</b>");
  const chunks = chunkText("```\n" + "line\n".repeat(2000) + "```");
  check("chunkText ≤4000 + fences balanced", chunks.length > 1 && chunks.every((c) => c.length <= 4010 && (c.match(/```/g) || []).length % 2 === 0));

  const reqs: { method: string; body: any }[] = [];
  let replies: Record<string, (body: any) => any> = {};
  const fakeFetch = async (url: string, init: any) => {
    if (String(url).includes("/file/botT/")) return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("JPG").buffer } as any;
    const method = String(url).split("/").pop()!;
    const body = init?.body instanceof FormData ? Object.fromEntries((init.body as FormData).entries()) : JSON.parse(init?.body || "{}");
    reqs.push({ method, body });
    const r = replies[method]?.(body) ?? { ok: true, result: { message_id: 77 } };
    return { status: 200, json: async () => r } as any;
  };
  (globalThis as any).fetch = fakeFetch;
  const tg: any = new TelegramClient({ botToken: "T" });
  tg.username = "my_bot"; tg.botId = 999;
  const evs: ChatEvent[] = [];
  tg.onMessage((e: ChatEvent) => { evs.push(e); });
  await tg.onUpdate({ message_id: 5, chat: { id: -1001, type: "supergroup" }, from: { id: 42 }, text: "@my_bot 别盯了" });
  check("group text → event, mention stripped", evs[0]?.chatId === "tg_-1001" && evs[0].text === "别盯了" && evs[0].messageId === "tg_-1001:5" && evs[0].chatType === "group" && evs[0].senderOpenId === "42", evs[0]);
  await tg.onUpdate({ message_id: 6, chat: { id: 7, type: "private" }, from: { id: 42 }, text: "/stop@my_bot" });
  check("/cmd@bot → /cmd", evs[1]?.text === "/stop" && evs[1].chatType === "p2p");
  await tg.onUpdate({ message_id: 8, chat: { id: -1001, type: "group" }, from: { id: 42 }, text: "进展如何", reply_to_message: { message_id: 3, from: { id: 999, is_bot: true }, text: "card" } });
  check("reply to a bot message → rootId (card thread)", evs[2]?.rootId === "tg_-1001:3");
  await tg.onUpdate({ message_id: 9, chat: { id: 7, type: "private" }, from: { id: 42 }, caption: "看看", photo: [{ file_id: "small" }, { file_id: "big" }] });
  check("photo → largest size + caption", evs[3]?.messageType === "image" && evs[3].attachments[0].fileKey === "big" && evs[3].text === "看看");
  await tg.onUpdate({ message_id: 10, chat: { id: 7, type: "private" }, from: { id: 1, is_bot: true }, text: "x" });
  check("bot messages ignored", evs.length === 4);

  reqs.length = 0;
  const id = await tg.sendCardAndGetId("tg_-1001", "⚙️ **生成中**");
  check("card id = tg_<chat>:<message_id>, sent as HTML", id === "tg_-1001:77" && reqs[0].body.parse_mode === "HTML" && reqs[0].body.text.includes("<b>生成中</b>") && reqs[0].body.chat_id === "-1001");
  replies = { editMessageText: () => ({ ok: false, error_code: 400, description: "Bad Request: message is not modified" }) };
  check("edit 'not modified' counts as ok", await tg.updateCardMessage(id, "same"));
  replies = { sendMessage: (b) => (b.parse_mode ? { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } : { ok: true, result: { message_id: 78 } }) };
  reqs.length = 0;
  await tg.sendMarkdown("tg_7", "<<bad");
  check("HTML rejected → plain-text retry", reqs.length === 2 && !reqs[1].body.parse_mode && reqs[1].body.text === "<<bad");
  replies = {};
  reqs.length = 0;
  check("replyInThread → reply_parameters", (await tg.replyInThread("tg_-1001:77", "第 3 轮")) && reqs[0].body.reply_parameters?.message_id === 77);
  reqs.length = 0;
  check("finalize oversized → tip + false", !(await tg.finalizeCard(id, "x".repeat(5000))) && reqs[0]?.method === "editMessageText");
  reqs.length = 0;
  const f = join(tmp, "plot.png");
  writeFileSync(f, "PNG");
  await tg.sendAgentImages("tg_7", [{ filePath: f }]);
  check("image → sendPhoto multipart", reqs[0]?.method === "sendPhoto" && reqs[0].body.chat_id === "7");
  replies = { getFile: () => ({ ok: true, result: { file_path: "photos/a.jpg", file_size: 3 } }) };
  const saved = await tg.downloadAttachments("tg_7:9", tmp, evs[3].attachments);
  check("download via getFile + file URL", saved.length === 1 && readFileSync(saved[0], "utf8") === "JPG");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
