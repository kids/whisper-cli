本项目是一个 ChatOps 开发自动化工具。解除了开发环境的地理限制，把飞书群（也支持企业微信、Telegram）变成移动端/远程的"命令行终端"。

通过本项目，你只需在聊天框中发送自然语言或特定指令，背后的机器人就能自动调用、驱动本地或云端的 Codex、Claude Code、Gemini、Cursor、CodeBuddy、Pi 等 AI 辅助编程 CLI 工具。无论是出门在外通过手机紧急修复 Bug、触发代码审查，还是在工位上实现多端联动，它都能让你随时随地，触手可得。

核心特性：

💬 多组并发转发：在 `.env` 中配置多组「IM 平台 + AI CLI」token 组合，所有组同时启动转发服务。

🤖 AI CLI 驱动：对接 Codex、Claude Code、Gemini、Cursor、CodeBuddy、Pi 等 AI 编程助手的命令行接口。

🔒 安全远程控制：支持用户白名单（`AGENT_<N>_ALLOWLIST`），确保你的开发环境安全无虞。

📌 群公告即指令：群公告的内容每轮注入给 agent，作为本群的长期约束；改公告就是改规则。

🧠 群记忆：按群保存事实和偏好，对 agent 说「记住…」即可，所有 CLI 通用。

⏱ 长任务监控：训练、批处理放后台跑，由代码定时检查进程、日志、指标，跑完或出错再叫 agent，等待期间不耗 token。

📎 附件往返：群内发图片/文件自动下载到工作区；说「画个图发群里」「整理成 html 发我」，agent 会把图片、html、md、pdf 等发回群里（只发工作区和 /tmp 下的文件，`.env`、密钥类文件不会发送）。

🧭 多 agent 团队（orc）：说「这个交给团队做，测试全过为止」，就由团队接手——预制流水线（开发、修 bug、调研、只审不改），或「监督者 + 执行者」的监督循环，完成门禁、不可逆操作确认等由代码把关；运行中随时用自然语言插话、回答提问、换模型。普通对话还是单 agent 处理，系统自动判断该交给谁。

从 feishu-cursor 合并的特性：

📋 管理台模式：私聊 = `/新任务` `/列表` `/归档`；每个工作群 = 独立 AI session

🗂 工作区路由：`projects.json` 支持 `项目名:指令` 路由到不同 workspace，可配 `systemPromptFile`

🔍 `/review`：以 reviewer 视角审视上一轮回复（别名 `/审视` `/critique`）

整体设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

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

# 第 4 组：飞书 ↔ Claude Code（无需 API Key，先执行 claude /login）
AGENT_4_NAME=Claude Bot
AGENT_4_PLATFORM=feishu
AGENT_4_AI_CLI=claude
AGENT_4_FEISHU_APP_ID=cli_aaa
AGENT_4_FEISHU_APP_SECRET=aaa

# 第 5 组：飞书 ↔ Gemini CLI（无需 API Key，先交互登录 gemini）
AGENT_5_NAME=Gemini Bot
AGENT_5_PLATFORM=feishu
AGENT_5_AI_CLI=gemini
AGENT_5_FEISHU_APP_ID=cli_bbb
AGENT_5_FEISHU_APP_SECRET=bbb

# 第 6 组：飞书 ↔ Pi（无需 API Key，先在 pi 交互里 /login）
AGENT_6_NAME=Pi Bot
AGENT_6_PLATFORM=feishu
AGENT_6_AI_CLI=pi
AGENT_6_FEISHU_APP_ID=cli_ccc
AGENT_6_FEISHU_APP_SECRET=ccc

# 第 7 组：企业微信智能机器人（长连接）↔ CodeBuddy
AGENT_7_PLATFORM=wecom
AGENT_7_AI_CLI=codebuddy
AGENT_7_WECOM_BOT_ID=aibxxx
AGENT_7_WECOM_BOT_SECRET=xxx
AGENT_7_CODEBUDDY_API_KEY=ck_xxx

# 第 8 组：Telegram ↔ Claude Code
AGENT_8_PLATFORM=telegram
AGENT_8_AI_CLI=claude
AGENT_8_TELEGRAM_BOT_TOKEN=123456:ABC-xxx
```

> 每组 Bot 必须使用**独立的机器人凭证**（不同飞书 `APP_ID` / 企微 Bot ID / Telegram token），否则长连接会互相抢事件。`AI_CLI` 也接受别名：`codex-cli`、`claude-code` / `claude-code-cli`、`gemini-cli`。完整的可选项（白名单、工作目录、Pi 的 provider 等）见 `.env.example`。

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

### 2. CLI 登录（Codex / Claude / Gemini / Pi 需要）

```bash
# Codex — 浏览器 OAuth（推荐，走 ChatGPT 订阅额度）
codex login
codex login status

# Claude Code — Claude.ai 订阅（推荐）
claude /login

# Gemini CLI — 首次交互运行完成 Google OAuth
gemini

# Pi — 交互里 /login 选 "ChatGPT Plus/Pro (Codex)"；验证：
pi auth check --provider openai-codex --json
```

不建议把订阅类 CLI 换成 API Key（会变成按量付费，和订阅重复计费）。若必须使用 API Key：

```bash
# Codex（不推荐）
echo "sk-xxx" | codex login --with-api-key

# Claude：在 .env 里设 AGENT_N_ANTHROPIC_API_KEY
# Gemini：在 .env 里设 AGENT_N_GEMINI_API_KEY 或 AGENT_N_GOOGLE_API_KEY
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

> 服务直接运行工作目录里的代码；更新代码后 `systemctl restart <服务名>` 生效。

### 4. 使用
在群里直接说话即可（企微群里要 @ 机器人），所有配置的 Agent 组同时在线。不需要记命令：

| 你说 | 会发生什么 |
|------|------|
| 「令牌桶和漏桶有什么区别」「修一下 app.ts 第 30 行的报错」 | 单 agent 直接回答或动手改 |
| 「画一下 loss 曲线发群里」「把报告整理成 html 发我」 | agent 生成文件并发到群里 |
| 「后台跑这个训练，跑完或出错叫我」 | 登记监控，等待期间不耗 token，跑完通知你 |
| 「停掉监控」「别盯了」「训练那个监控关了」「监控全停了」 | 停止监控（被监控的进程不受影响）；有多个时会问你停哪个 |
| 「记住：GPU 机器只有 2 张卡」 | 记入本群记忆，之后每轮都会带上 |
| 「以后所有回复先给一句话结论」 | 提议写入群公告，你回「确认」才生效 |
| 「这个交给团队做，测试全过为止」「让两个模型交叉评审一下」 | 交给多 agent 团队，群里出现任务卡片 |
| 「#12 到哪了」「限流那个改用 redis」「先别推」「执行者换成 claude」「别每轮都刷屏」 | 交给主 agent，调整进行中的任务 |
| 「回到单聊模式」「以后都走团队」 | 切换本群的分派方式 |

**谁来处理：** 默认由代码按规则判断每条消息该给单 agent 还是主 agent（不额外调用模型，没有延迟）：
- 说了要团队做、要反复迭代到达标、要换模型交叉评审、要切换模式 → 主 agent；
- 提到进行中的任务（编号、标题里的词）、问进展、叫停、重试、换模型 → 主 agent；
- 团队在等你回答问题、或主 agent 在等你确认时的简短回复 → 主 agent；
- 在任务卡片的回复串里说话 → 主 agent；
- 其余普通对话、带附件的消息 → 单 agent。

判断错了也没关系：主 agent 发现只是普通问题会转回单 agent；单 agent 发现一件事需要团队（比如要反复迭代到测试全过）会自己转交。

**兜底命令**（一般用不到）：
| 指令 | 说明 |
|------|------|
| `/stop` `/cancel` `/停止` | 立即终止当前运行（绕过排队，含本群团队任务） |
| `/reset` `/重置` | 重置会话，清零累计 token |
| `/model [id]` | 查看 / 切换模型（`/model default` 恢复默认） |
| `/new [name]` | 创建新飞书群 = 全新独立会话（仅飞书，非管理台模式） |
| `/review [焦点]` | 审视上一轮 bot 回复 |
| `/status` `/sys` | 当前状态（CLI、模型、工作区）+ 机器资源 |
| `/help` | 帮助 |

其他命令（`/mode`、`/task`、`/tasks`、`/orc`、`/watch`、`/记忆` 等）都还能用，完整列表见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

团队任务需要当前工作区是 git 仓库：每个任务在独立的 worktree 和分支上做，不动你的主分支；不可逆操作（推送、部署等）必须你明确同意才会执行。

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

**各平台差异：** 对话、群记忆、长任务监控、附件收发、多 agent 团队在三个平台都能用；下面这些受平台限制：

| | 飞书 | 企业微信（智能机器人） | Telegram |
|---|---|---|---|
| 群里收哪些消息 | 全部 | 只收 @ 机器人的 | 关闭隐私模式后全部，否则只收 @、回复和 /命令 |
| 回复实时刷新 | ✅ 卡片 | ✅ 流式消息，约 5 分钟后收尾，结果另发 | ✅ 编辑消息（约 3 秒一刷） |
| 监控 / 团队任务卡片原地刷新 | ✅ | ❌ 只发一次，结束时另发通知 | ✅ |
| 团队任务的回复串 | ✅ 话题 | ❌ 直接发在群里 | ✅ 回复卡片那条消息 |
| 群公告当规则 | ✅ | ❌（用「记住…」代替） | ❌（用「记住…」代替） |
| 建群：`/new`、管理台 `/新任务` | ✅ | ❌ | ❌ |
| 收图片 / 文件 | ✅ | ✅（链接 5 分钟失效，收到即下载） | ✅（20MB 以内） |
| 发图片 / 文件 | ✅ | ✅ | ✅ |
- 🗂 **多工作区** — `projects.json` 路由 + 可选系统提示文件
- 📎 **附件往返** — 下载用户发的图片/文件；agent 产出的图片和文件发回群里

### 辅助脚本

```bash
# 抓取 chat_id（勿与 start 同时跑）
npm run capture-chat-id

# 主动发一条消息
python scripts/send.py "hello"
```

### 开发与检查

```bash
npx tsc --noEmit                     # 类型检查
npx tsx scripts/orc_check.ts         # 离线检查，另有 orc_loop_check / watch_check / memory_check / outgoing_check 等
```

`scripts/` 下 `orc_lead_check` 和带 `live` / `agent` 的脚本会调用真实模型或真实飞书（临时建群，测完解散），说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §9。
