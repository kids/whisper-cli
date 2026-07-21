/**
 * 调试：监听飞书消息，打印 chat_id（勿与 npm start 同时运行）
 *
 * 用法: npx tsx scripts/capture-chat-id.ts
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENV_PATH = process.env.FEISHU_ENV || resolve(ROOT, ".env");

function parseEnv(path: string) {
  const raw = readFileSync(path, "utf-8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

if (!existsSync(ENV_PATH)) {
  console.error(`未找到: ${ENV_PATH}`);
  process.exit(1);
}

const env = parseEnv(ENV_PATH);
const appId = env.AGENT_1_FEISHU_APP_ID || env.FEISHU_APP_ID;
const appSecret = env.AGENT_1_FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;
if (!appId || !appSecret) {
  console.error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置（或 AGENT_1_FEISHU_*）");
  process.exit(1);
}

const larkClient = new Lark.Client({
  appId,
  appSecret,
  domain: Lark.Domain.Feishu,
});

const dispatcher = new Lark.EventDispatcher({});
dispatcher.register({
  "im.chat.access_event.bot_p2p_chat_entered_v1": async (data) => {
    const ev = data as Record<string, unknown>;
    const chatId = ev.chat_id as string;
    console.log(`\n[私聊进入] chat_id=${chatId}`);
    if (chatId) {
      try {
        await larkClient.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "text",
            content: JSON.stringify({ text: "👋 已连接！请发送 hi 测试。" }),
          },
        });
      } catch (err) {
        console.error("[欢迎失败]", err);
      }
      console.log(`\nFEISHU_CHAT_ID=${chatId}\nAGENT_1_FEISHU_CHAT_ID=${chatId}\n`);
    }
  },
  "im.message.receive_v1": async (data) => {
    const ev = data as Record<string, unknown>;
    const msg = ev.message as Record<string, unknown>;
    if (!msg) return;
    const chatId = msg.chat_id as string;
    const messageId = msg.message_id as string;
    console.log(`\n[收到] chat_id=${chatId}`);
    try {
      await larkClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: "✅ 已收到，chat_id 已打印到终端。" }),
        },
      });
    } catch (err) {
      console.error("[回复失败]", err);
    }
    console.log(`\nFEISHU_CHAT_ID=${chatId}\nAGENT_1_FEISHU_CHAT_ID=${chatId}\n`);
  },
});

const ws = new Lark.WSClient({
  appId,
  appSecret,
  domain: Lark.Domain.Feishu,
  loggerLevel: Lark.LoggerLevel.info,
});

console.log("等待飞书消息…（勿与 npm start 同时运行）\n");
ws.start({ eventDispatcher: dispatcher });
