This project is an ChatOps automation tool for developers. It breaks down the geographical barriers of traditional development environments by transforming mainstream Instant Messaging (IM) platforms—such as Lark, WeChat, and Telegram—into a mobile/remote "command-line terminal."

With this tool, you can simply send natural language or specific commands in a chat window. The underlying bot will automatically invoke and drive AI-powered programming CLI tools like Codex, Cursor, and CodeBuddy on your local or cloud environment. Whether you are on the go fixing an emergency bug via your phone, triggering a code review, or multi-tasking at your desk, it puts your development workflow right at your fingertips.

Key Features:

💬 Multi-Agent Concurrent: Configure multiple "IM Platform + AI CLI" groups in `.env` — all running simultaneously.

🤖 AI CLI Driven: Supports Codex, Cursor, CodeBuddy, and other modern AI coding assistant CLIs.

🔒 Secure Remote Control: Supports user allowlist to keep your development environment safe.

⚡ Lightweight & Fast: Extremely low latency, making "chat-to-code" a real-time reality.

---

## Quick Start

### 1. Configure
```bash
cp .env.example .env
# Edit .env and fill in tokens for each agent group
```

Each agent group follows the `AGENT_<N>_*` format:

```env
# Group 1: Feishu ↔ CodeBuddy
AGENT_1_NAME=CodeBuddy Bot
AGENT_1_PLATFORM=feishu
AGENT_1_AI_CLI=codebuddy
AGENT_1_FEISHU_APP_ID=cli_xxx
AGENT_1_FEISHU_APP_SECRET=xxx
AGENT_1_CODEBUDDY_API_KEY=ck_xxx

# Group 2: Feishu ↔ Cursor
AGENT_2_NAME=Cursor Bot
AGENT_2_PLATFORM=feishu
AGENT_2_AI_CLI=cursor
AGENT_2_FEISHU_APP_ID=cli_yyy
AGENT_2_FEISHU_APP_SECRET=yyy
AGENT_2_CURSOR_API_KEY=crsr_xxx

# Group 3: Feishu ↔ Codex (no API key needed — run `codex login` first)
AGENT_3_NAME=Codex Bot
AGENT_3_PLATFORM=feishu
AGENT_3_AI_CLI=codex
AGENT_3_FEISHU_APP_ID=cli_zzz
AGENT_3_FEISHU_APP_SECRET=zzz
```

> **Codex Auth:** Codex uses OAuth persistent login (`codex login`) — this is **not** the same as an OpenAI API Key (`sk-xxx`):
>
> | | OAuth Login (recommended) | API Key |
> |---|---|---|
> | Method | `codex login` via browser OAuth | `codex login --with-api-key` |
> | Billing | Charged against ChatGPT Pro/Lite **subscription** | Charged via OpenAI Platform **pay-as-you-go** |
> | Credential | Persisted in `~/.codex/auth.json` | `sk-xxx` static string |
> | Config in `.env` | ❌ No API key required | Pass via stdin |
>
> ⚠️ **Not recommended** to use API Key with Codex — your Pro subscription already includes Codex usage. Switching to API Key would result in double billing.

### 2. Codex Login (codex agent only)

```bash
# Browser OAuth (recommended)
codex login

# Or: with API Key (not recommended, see table above)
echo "sk-xxx" | codex login --with-api-key

# Verify login status
codex login status
```

### 3. Start
```bash
npm install
npm start
```

### 4. Usage
Send messages in the Feishu bot chat — all configured agent groups run simultaneously.

**Commands:**

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/reset` | Reset session + clear cumulative tokens |
| `/model` | List available models |
| `/model <id>` | Switch model (`/model default` to reset) |
| `/new [name]` | Create a new Feishu group = fresh session |
| `/stop` or `/cancel` | Stop the current running task |
| `/status` | Show agent status (CLI, model, etc.) |

**Features:**
- 📡 **Streaming output** — replies update in real-time as text is generated
- 💾 **Session persistence** — survives restarts (stored in `state/state_<N>.json`)
- 📊 **Token tracking** — per-turn + cumulative token usage in every reply