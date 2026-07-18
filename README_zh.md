本项目是一个 ChatOps 开发自动化工具。解除了开发环境的地理限制，将飞书、企业微信等主流即时通讯（IM）工具转化为移动端/远程的"命令行终端"。

通过本项目，你只需在聊天框中发送自然语言或特定指令，背后的机器人就能自动调用、驱动本地或云端的 Cursor、CodeBuddy 等 AI 辅助编程 CLI 工具。无论是出门在外通过手机紧急修复 Bug、触发代码审查，还是在工位上实现多端联动，它都能让你随时随地，触手可得。

核心特性：

💬 多组并发转发：在 `.env` 中配置多组「IM 平台 + AI CLI」token 组合，所有组同时启动转发服务。

🤖 AI CLI 驱动：完美对接 Codex、Cursor、CodeBuddy 等现代 AI 编程助手的命令行接口。

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

# 第 3 组：飞书 ↔ Codex（无需 API Key，先执行 codex login）
AGENT_3_NAME=Codex Bot
AGENT_3_PLATFORM=feishu
AGENT_3_AI_CLI=codex
AGENT_3_FEISHU_APP_ID=cli_zzz
AGENT_3_FEISHU_APP_SECRET=zzz
```

> **Codex 认证说明：** Codex 使用的是 OAuth 持久化认证（`codex login`），与 OpenAI API Key（`sk-xxx`）**不是同一回事**：
>
> | | OAuth 登录（推荐） | API Key |
> |---|---|---|
> | 方式 | `codex login` 网页 OAuth | `codex login --with-api-key` |
> | 计费 | 走 ChatGPT Pro/Lite **订阅额度** | 走 OpenAI Platform **按量付费** |
> | 凭据 | 持久化在 `~/.codex/auth.json` | `sk-xxx` 静态字符串 |
> | `.env` 中需要配置 | ❌ 无需任何 API Key | 需传 stdin |
>
> ⚠️ **不建议** 对 Codex 使用 API Key 方式——Pro 订阅已包含 Codex 调用额度，换成 API Key 会重复计费。

### 2. Codex 登录（仅 codex agent 需要）

```bash
# 浏览器 OAuth 登录（推荐）
codex login

# 或：使用 API Key（不推荐，见上表）
echo "sk-xxx" | codex login --with-api-key

# 验证登录状态
codex login status
```

### 3. 启动
```bash
npm install
npm start
```

### 4. 使用
在飞书 Bot 对话中发送消息即可，所有配置的 Agent 组同时在线。

**支持指令：**
| 指令 | 说明 |
|------|------|
| `/help` | 显示所有可用指令 |
| `/reset` | 重置当前会话，清零累计 token |
| `/model` | 查看可用模型列表 |
| `/model <id>` | 切换模型（`/model default` 恢复默认） |
| `/new [name]` | 创建新飞书群 = 全新独立会话 |
| `/stop` 或 `/cancel` | 终止当前运行的任务 |
| `/status` | 查看当前状态（CLI、模型等） |

**特性：**
- 📡 **流式输出** — 回复以卡片形式实时逐字更新，不用等完成
- 💾 **会话持久化** — 重启 bot 不丢会话历史（存储在 `state/state_<N>.json`）
- 📊 **Token 统计** — 每次回复显示本轮 + 会话累计 token 用量