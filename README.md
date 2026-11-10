This project is a ChatOps automation tool for developers. It turns a Feishu (Lark) group into a mobile/remote "command-line terminal" (WeCom config keys are reserved, but sending/receiving is not implemented yet).

With this tool, you can simply send natural language or specific commands in a chat window. The underlying bot will automatically invoke and drive AI-powered programming CLI tools like Codex, Claude Code, Gemini, Cursor, CodeBuddy and Pi on your local or cloud environment. Whether you are on the go fixing an emergency bug via your phone, triggering a code review, or multi-tasking at your desk, it puts your development workflow right at your fingertips.

Key Features:

💬 Multi-Agent Concurrent: Configure multiple "IM Platform + AI CLI" groups in `.env` — all running simultaneously.

🤖 AI CLI Driven: Supports Codex, Claude Code, Gemini, Cursor, CodeBuddy and Pi.

🔒 Secure Remote Control: User allowlist (`AGENT_<N>_FEISHU_ALLOWLIST`) keeps your development environment safe.

📌 Group announcement = instructions: the group announcement is injected into every agent turn as the chat's standing rules.

🧠 Group memory: per-chat facts and preferences — just tell the agent "remember …"; works for every CLI.

⏱ Long-job watches: training / batch jobs run in the background; code checks process, logs and metrics on a timer and wakes the agent when done or failed — zero tokens while waiting.

📎 Attachments both ways: images/files posted in the chat are downloaded into the workspace; say "plot it and post it here" or "send me the report as html" and the agent sends images, html, md, pdf … back (only from the workspace / tmp; `.env` and key files are never sent).

🧭 Multi-agent teams (orc): say "hand this to the team, until all tests pass" and a team takes over — preset pipelines (dev, fix, research, review-only) or a supervisor loop, with code enforcing the finish gate, irreversible-action approval and budgets; steer it in plain words at any time (add requirements, answer its questions, switch models). Ordinary chat stays with the single agent; routing is automatic.

Merged from feishu-cursor:

📋 Admin mode: DM = `/新任务` `/列表` `/归档`; each work group = its own AI session

🗂 Workspace routing: `projects.json` routes `project:instruction` to different workspaces, optional `systemPromptFile`

🔍 `/review`: critique the previous reply as a reviewer (aliases `/审视` `/critique`)

Design overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (Chinese).

---

## Quick Start

### 1. Configure
```bash
cp .env.example .env
# Edit .env and fill in tokens for each agent group
# Workspace routing: edit projects.json
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

# Group 2: Feishu ↔ Cursor (admin mode)
AGENT_2_NAME=Cursor Bot
AGENT_2_PLATFORM=feishu
AGENT_2_AI_CLI=cursor
AGENT_2_ADMIN_MODE=true
AGENT_2_FEISHU_APP_ID=cli_yyy
AGENT_2_FEISHU_APP_SECRET=yyy
AGENT_2_FEISHU_CHAT_ID=oc_xxx
AGENT_2_CURSOR_API_KEY=crsr_xxx
AGENT_2_WORKDIR=/path/to/project

# Group 3: Feishu ↔ Codex (no API key needed — run `codex login` first)
AGENT_3_NAME=Codex Bot
AGENT_3_PLATFORM=feishu
AGENT_3_AI_CLI=codex
AGENT_3_FEISHU_APP_ID=cli_zzz
AGENT_3_FEISHU_APP_SECRET=zzz

# Group 4: Feishu ↔ Claude Code (no API key — run `claude /login` first)
AGENT_4_NAME=Claude Bot
AGENT_4_PLATFORM=feishu
AGENT_4_AI_CLI=claude
AGENT_4_FEISHU_APP_ID=cli_aaa
AGENT_4_FEISHU_APP_SECRET=aaa

# Group 5: Feishu ↔ Gemini CLI (no API key — complete `gemini` OAuth first)
AGENT_5_NAME=Gemini Bot
AGENT_5_PLATFORM=feishu
AGENT_5_AI_CLI=gemini
AGENT_5_FEISHU_APP_ID=cli_bbb
AGENT_5_FEISHU_APP_SECRET=bbb

# Group 6: Feishu ↔ Pi (no API key — `/login` inside an interactive `pi` first)
AGENT_6_NAME=Pi Bot
AGENT_6_PLATFORM=feishu
AGENT_6_AI_CLI=pi
AGENT_6_FEISHU_APP_ID=cli_ccc
AGENT_6_FEISHU_APP_SECRET=ccc
```

> Each Feishu bot group needs its **own Feishu app** (different `APP_ID`); long-connection events cannot be shared. `AI_CLI` aliases: `codex-cli`, `claude-code` / `claude-code-cli`, `gemini-cli`. All optional keys (allowlist, workdir, Pi provider …) are listed in `.env.example`.

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

### 2. CLI Login (Codex / Claude / Gemini / Pi)

```bash
# Codex — browser OAuth (recommended; billed to ChatGPT subscription)
codex login
codex login status

# Claude Code — Claude.ai subscription (recommended)
claude /login

# Gemini CLI — first interactive run completes Google OAuth
gemini

# Pi — `/login` inside interactive pi, pick "ChatGPT Plus/Pro (Codex)"; verify:
pi auth check --provider openai-codex --json
```

Avoid swapping subscription CLIs to API keys (pay-as-you-go would double-bill). If you must:

```bash
# Codex (not recommended)
echo "sk-xxx" | codex login --with-api-key

# Claude: AGENT_N_ANTHROPIC_API_KEY in .env
# Gemini: AGENT_N_GEMINI_API_KEY or AGENT_N_GOOGLE_API_KEY in .env
```

### 3. Start
```bash
npm install
npm start
```

systemd (Linux):
```bash
sudo cp whisper-cli.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now whisper-cli
```

> The service runs the code in its working directory; after updating, `systemctl restart <service>`.

### 4. Usage
Just talk in the Feishu group — all configured agent groups run simultaneously. No commands to learn:

| You say | What happens |
|---------|--------------|
| "what's the difference between token bucket and leaky bucket", "fix the error on app.ts line 30" | the single agent answers or edits |
| "plot the loss curve and post it here", "send me the report as html" | the agent creates the file and posts it |
| "run this training in the background, ping me when done or failed" | a watch is registered; zero tokens while waiting |
| "remember: the GPU box only has 2 cards" | stored in this group's memory, included every turn |
| "from now on, start every reply with a one-line conclusion" | proposed as a group-announcement rule; applied after you say "confirm" |
| "hand this to the team, until all tests pass", "have two models cross-review it" | a multi-agent team takes it; a task card appears |
| "how's #12 going", "use redis for the rate limiter", "don't push yet", "switch the worker to claude", "stop posting every round" | the lead agent adjusts the running task |
| "back to single-agent mode", "always use the team from now on" | changes how this group routes messages |

**Who handles a message:** by default code-only rules decide per message (no extra model call, no latency):
- asks for a team / iterating until a target is met / cross-model review / a mode switch → lead agent;
- mentions a running task (id, words from its title), asks for progress, stops, retries, switches models → lead agent;
- a short reply while a task waits for your answer or the lead waits for your confirmation → lead agent;
- replies in a task card's thread → lead agent;
- everything else, and messages with attachments → single agent.

Wrong guesses recover on their own: the lead hands plain questions back to the single agent, and the single agent hands work to a team when it needs one (e.g. iterating until tests pass). The keyword rules are Chinese-first (see `src/orc/route.ts`).

**Fallback commands** (rarely needed):

| Command | Description |
|---------|-------------|
| `/stop` `/cancel` | Stop the current run immediately (bypasses the queue; includes this group's team tasks) |
| `/reset` | Reset session + clear cumulative tokens |
| `/model [id]` | List / switch models (`/model default` to reset) |
| `/new [name]` | Create a new Feishu group = fresh session (non-admin mode) |
| `/review [focus]` | Critique the previous bot reply |
| `/status` `/sys` | Agent status (CLI, model, workspace) + host resources |
| `/help` | Help |

Other commands (`/mode`, `/task`, `/tasks`, `/orc`, `/watch`, `/记忆` …) still work; full list in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

Team tasks need the workspace to be a git repo: each task works on its own worktree and branch, your main branch is untouched; irreversible actions (push, deploy …) only run after your explicit approval.

**Admin mode (`ADMIN_MODE=true`, on by default for Cursor):**

DM only:

| Command | Description |
|---------|-------------|
| `/新任务 <title>` | Create a group with a new AI session |
| `/新任务 finch:<instruction>` | Create the group and run immediately |
| `/列表` | Active task groups |
| `/归档 <n>` | Archive a task |

In work groups just send natural language; `project:instruction` routing via `projects.json`.

**Features:**
- 📡 **Streaming output** — replies update in real-time as text is generated
- 💾 **Session persistence** — survives restarts (stored in `state/state_<N>.json`)
- 📊 **Token tracking** — per-turn + cumulative token usage in every reply
- 🗂 **Multi-workspace** — `projects.json` routing + optional system prompt file
- 📎 **Attachments** — user images/files are downloaded; images/files the agent produces are posted back

### Helper scripts

```bash
# Capture a chat_id (don't run alongside `npm start`)
npm run capture-chat-id

# Send a message
python scripts/send.py "hello"
```

### Development & checks

```bash
npx tsc --noEmit                     # type check
npx tsx scripts/orc_check.ts         # offline checks; also orc_loop_check / watch_check / memory_check / outgoing_check …
```

`orc_lead_check` and the `*live*` / `*agent*` scripts in `scripts/` call real models or real Feishu (temporary groups, dissolved afterwards); see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §9.
