本项目是一个 ChatOps 开发自动化工具。解除了开发环境的地理限制，将飞书、企业微信等主流即时通讯（IM）工具转化为移动端/远程的"命令行终端"。

通过本项目，你只需在聊天框中发送自然语言或特定指令，背后的机器人就能自动调用、驱动本地或云端的 Cursor、CodeBuddy 等 AI 辅助编程 CLI 工具。无论是出门在外通过手机紧急修复 Bug、触发代码审查，还是在工位上实现多端联动，它都能让你随时随地，触手可得。

核心特性：

💬 多组并发转发：在 `.env` 中配置多组「IM 平台 + AI CLI」token 组合，所有组同时启动转发服务。

🤖 AI CLI 驱动：完美对接 Cursor、CodeBuddy 等现代 AI 编程助手的命令行接口。

🔒 安全远程控制：支持用户白名单，确保你的开发环境安全无虞。

⚡ 轻量高效：极低的延迟，让"聊天即编程"成为现实。

---

## 快速开始

### 1. 配置
```bash
cp .env.example .env
# 编辑 .env，填入各组 Agent 的令牌
```

每组 Agent 按 `AGENT_<N>_*` 格式配置，例如：
```env
# 第 1 组：飞书 ↔ CodeBuddy
AGENT_1_NAME=CodeBuddy Bot
AGENT_1_PLATFORM=feishu
AGENT_1_AI_CLI=codebuddy
AGENT_1_FEISHU_APP_ID=cli_xxx
AGENT_1_FEISHU_APP_SECRET=xxx
AGENT_1_CODEBUDDY_API_KEY=ck_xxx

# 第 2 组：飞书 ↔ Cursor
AGENT_2_NAME=Cursor Bot
AGENT_2_PLATFORM=feishu
AGENT_2_AI_CLI=cursor
AGENT_2_FEISHU_APP_ID=cli_yyy
AGENT_2_FEISHU_APP_SECRET=yyy
AGENT_2_CURSOR_API_KEY=crsr_xxx
```

### 2. 启动
```bash
npm install
npm start
```

### 3. 使用
在飞书 Bot 对话中发送消息即可，所有配置的 Agent 组同时在线。
支持指令：`/help` `/reset` `/stop` `/status`