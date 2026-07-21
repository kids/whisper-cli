本项目是一个 ChatOps 开发自动化工具。解除了开发环境的地理限制，将飞书、企业微信等主流即时通讯（IM）工具转化为移动端/远程的"命令行终端"。

通过本项目，你只需在聊天框中发送自然语言或特定指令，背后的机器人就能自动调用、驱动本地或云端的 Cursor、CodeBuddy 等 AI 辅助编程 CLI 工具。无论是出门在外通过手机紧急修复 Bug、触发代码审查，还是在工位上实现多端联动，它都能让你随时随地，触手可得。

核心特性：

💬 多组并发转发：在 `.env` 中配置多组「IM 平台 + AI CLI」token 组合，所有组同时启动转发服务。

🤖 AI CLI 驱动：完美对接 Codex、Cursor、CodeBuddy 等现代 AI 编程助手的命令行接口。

🔒 安全远程控制：支持用户白名单，确保你的开发环境安全无虞。

⚡ 轻量高效：极低的延迟，让"聊天即编程"成为现实。

从 feishu-cursor 合并的特性：

📋 管理台模式：私聊 = `/新任务` `/列表` `/归档`；每个工作群 = 独立 AI session

🗂 工作区路由：`projects.json` 支持 `项目名:指令` 路由到不同 workspace，可配 `systemPromptFile`

🔍 `/review`：以 reviewer 视角审视上一轮回复（别名 `/审视` `/critique`）

📎 附件：群内发图片/文件自动下载到工作区；Agent 产出的图片/文件自动回传

---

## 快速开始

### 1. 配置
```bash
cp .env.example .env
# 编辑 .env，填入各组 Agent 的令牌
# 工作区路由：编辑 projects.json
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

# 第 2 组：飞书 ↔ Cursor（管理台模式）
AGENT_2_NAME=Cursor Bot
AGENT_2_PLATFORM=feishu
AGENT_2_AI_CLI=cursor
AGENT_2_ADMIN_MODE=true
AGENT_2_FEISHU_APP_ID=cli_yyy
AGENT_2_FEISHU_APP_SECRET=yyy
AGENT_2_FEISHU_CHAT_ID=oc_xxx
AGENT_2_CURSOR_API_KEY=crsr_xxx
AGENT_2_WORKDIR=/path/to/project

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

systemd（Linux）：
```bash
sudo cp whisper-cli.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-cli
```

### 4. 使用
在飞书 Bot 对话中发送消息即可，所有配置的 Agent 组同时在线。

**通用指令：**
| 指令 | 说明 |
|------|------|
| `/help` `/帮助` | 显示所有可用指令 |
| `/reset` `/重置` | 重置当前会话，清零累计 token |
| `/model` | 查看可用模型列表 |
| `/model <id>` | 切换模型（`/model default` 恢复默认） |
| `/new [name]` | 创建新飞书群 = 全新独立会话（非管理台模式） |
| `/stop` `/停止` | 终止当前运行的任务 |
| `/review [焦点]` | 审视上一轮 bot 回复 |
| `/status` `/状态` | 查看当前状态（CLI、模型等） |

**管理台模式（`ADMIN_MODE=true`，Cursor 默认开启）：**

私聊专用：
| 指令 | 说明 |
|------|------|
| `/新任务 标题` | 建群，开新 AI session |
| `/新任务 finch:首条指令` | 建群并立即执行 |
| `/列表` | 活跃任务群 |
| `/归档 编号` | 归档任务 |

工作群内直接发自然语言；支持 `项目名:指令` 路由（见 `projects.json`）。

**特性：**
- 📡 **流式输出** — 回复以卡片形式实时逐字更新，不用等完成
- 💾 **会话持久化** — 重启 bot 不丢会话历史（存储在 `state/state_<N>.json`）
- 📊 **Token 统计** — 每次回复显示本轮 + 会话累计 token 用量
- 🗂 **多工作区** — `projects.json` 路由 + 可选系统提示文件
- 📎 **附件往返** — 下载用户图片/文件，回传 Agent 产出

### 辅助脚本

```bash
# 抓取 chat_id（勿与 start 同时跑）
npm run capture-chat-id

# 主动发一条消息
python scripts/send.py "hello"
```
