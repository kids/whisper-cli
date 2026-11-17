// Offline checks for src/platform/slack.ts — no network, no Slack app needed:
// wire text → plain text, markdown → mrkdwn, chunking, id parsing, event mapping
// (mentions, threads, attachments, dedupe, bot echo), and chat.update wiring.
//   npx tsx scripts/slack_check.ts
import { SlackClient, chunkSlackText, parseSlackMsgKey, slChatKey, slackToPlain } from "../src/platform/slack";
import { markdownToSlackMrkdwn } from "../src/post";
import { PLATFORM_LABEL, isChatKey } from "../src/platform/types";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}`, detail ?? ""); }
}
const eq = (name: string, got: unknown, want: unknown) => check(name, JSON.stringify(got) === JSON.stringify(want), { got, want });

// ---- inbound text -----------------------------------------------------------
eq("plain: entities", slackToPlain("a &amp; b &lt;c&gt;"), "a & b <c>");
eq("plain: mention dropped", slackToPlain("<@U123> 部署一下"), "部署一下");
eq("plain: named mention kept", slackToPlain("问 <@U123|roi> 吧"), "问 @roi 吧");
eq("plain: channel ref", slackToPlain("去 <#C9|ops> 说"), "去 #ops 说");
eq("plain: link → markdown", slackToPlain("见 <https://x.dev|文档>"), "见 [文档](https://x.dev)");
eq("plain: bare link", slackToPlain("<https://x.dev/a?b=1>"), "https://x.dev/a?b=1");
eq("plain: @channel", slackToPlain("<!channel> 注意"), "@channel 注意");

// ---- markdown → mrkdwn ------------------------------------------------------
eq("md: bold", markdownToSlackMrkdwn("**重要**"), "*重要*");
eq("md: heading", markdownToSlackMrkdwn("## 结论"), "*结论*");
eq("md: link", markdownToSlackMrkdwn("[文档](https://x.dev)"), "<https://x.dev|文档>");
eq("md: inline code untouched", markdownToSlackMrkdwn("`**x**`"), "`**x**`");
{
  const table = markdownToSlackMrkdwn("前\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n后");
  check("md: table → code block", table.includes("```") && table.includes("| a | b |") && table.includes("| 1 | 2 |"), table);
}

// ---- chunking ---------------------------------------------------------------
{
  const parts = chunkSlackText("x".repeat(9000), 3900);
  check("chunk: within limit", parts.every((p) => p.length <= 3905), parts.map((p) => p.length));
  const fenced = chunkSlackText("```\n" + "y".repeat(5000) + "\n```", 3900);
  check("chunk: fences balanced", fenced.every((p) => (p.match(/```/g) || []).length % 2 === 0), fenced.map((p) => (p.match(/```/g) || []).length));
}

// ---- ids --------------------------------------------------------------------
eq("id: chat key", slChatKey("C123"), "sl_C123");
eq("id: msg key parse", parseSlackMsgKey("sl_C123:1712345678.123456"), { channel: "C123", ts: "1712345678.123456" });
check("id: bad key", parseSlackMsgKey("sl_C:abc") === undefined);
check("id: isChatKey + label", isChatKey("sl_C1") && PLATFORM_LABEL.slack === "Slack");

// ---- event mapping ----------------------------------------------------------
async function events(): Promise<void> {
  const c: any = new SlackClient({ botToken: "xoxb-test", appToken: "xapp-test" });
  const got: any[] = [];
  c.onMessage((ev: any) => { got.push(ev); });
  c.botUserId = "U0BOT123";

  await c.onMessageEvent({ type: "message", channel: "C1", ts: "111.1", text: "<@U0BOT123> 跑一下测试", user: "U1", channel_type: "channel" }, "Ev1");
  const first = got[0];
  check("event: mapped", !!first && first.chatId === "sl_C1" && first.messageId === "sl_C1:111.1"
    && first.text === "跑一下测试" && first.chatType === "group" && first.senderOpenId === "U1", first);

  await c.onMessageEvent({ type: "message", channel: "D1", ts: "2.2", text: "hi", user: "U1", channel_type: "im" }, "Ev2");
  check("event: dm is p2p", got[1]?.chatType === "p2p", got[1]);

  await c.onMessageEvent({ type: "message", channel: "C1", ts: "3.3", text: "thread reply", user: "U1", thread_ts: "111.1" }, "Ev3");
  check("event: thread root", got[2]?.rootId === "sl_C1:111.1", got[2]);

  const before = got.length;
  await c.onMessageEvent({ type: "message", channel: "C1", ts: "4.4", text: "echo", user: "U9", bot_id: "B1" }, "Ev4");
  await c.onMessageEvent({ type: "message", channel: "C1", ts: "5.5", text: "self", user: "U0BOT123" }, "Ev5");
  await c.onMessageEvent({ type: "message", channel: "C1", ts: "6.6", text: "edit", subtype: "message_changed", user: "U1" }, "Ev6");
  check("event: bot / self / edit ignored", got.length === before, got.slice(before));

  await c.onMessageEvent({ type: "message", channel: "C1", ts: "111.1", text: "<@U0BOT123> 跑一下测试", user: "U1" }, "Ev1");
  check("event: duplicate event_id ignored", got.length === before, got.length);

  await c.onMessageEvent({
    type: "message", subtype: "file_share", channel: "C1", ts: "7.7", text: "", user: "U1",
    files: [{ mimetype: "image/png", url_private: "https://files/x.png", name: "x.png" }],
  }, "Ev7");
  const withFile = got.at(-1);
  check("event: attachment", withFile?.messageType === "image"
    && withFile?.attachments?.[0]?.fileKey === "https://files/x.png"
    && withFile?.attachments?.[0]?.type === "image", withFile);
}

// ---- chat.update wiring -----------------------------------------------------
async function update(): Promise<void> {
  const c: any = new SlackClient({ botToken: "xoxb-test", appToken: "xapp-test", apiBase: "https://slack.test/api" });
  process.env.SLACK_UPDATE_MIN_MS = "0";
  const calls: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as any;
  try {
    const ok = await c.updateCardMessage("sl_C9:1700000000.000100", "**hi**");
    check("update: ok", ok === true);
    check("update: chat.update with channel + ts + mrkdwn",
      calls[0]?.url === "https://slack.test/api/chat.update"
      && calls[0]?.body.channel === "C9"
      && calls[0]?.body.ts === "1700000000.000100"
      && calls[0]?.body.text === "*hi*", calls[0]);
    check("update: bad id → false", (await c.updateCardMessage("nonsense", "x")) === false);
  } finally {
    globalThis.fetch = real;
  }
}

await events();
await update();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
