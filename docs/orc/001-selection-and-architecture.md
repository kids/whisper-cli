# 001 orc：多 agent 任务调度层（选型与架构）

> 日期：2026-11-06　状态：方向已定，待做小验证（PoC）　分支：`feat/orc`
>
> 修订说明：群模式、进展同步、群公告约束、预制组合见 [002](002-chat-integration.md)。§4.1、§4.3、§4.4、§4.6、§4.7 中被 002 覆盖的地方已加标注。

## 0. 目标

做一个多 agent 任务入口：给主 agent 一个任务，系统负责拆解、分发、认领，并且：

- 有 **critic** 审查设计和代码，最好和实现者用**不同的模型，甚至不同的 CLI**；
- 有 **tester** 独立做验证，并把测试用例沉淀下来；
- 可以按需增加其他角色，**每个角色单独配置 agent 数量**；
- 调度高效，会话按需隔离，同时有共享记忆；
- 参考 DeepSeek Super-agent 的思路，但**编排调度尽量轻**。

## 1. 结论

**放在 whisper-cli 里，新建 `src/orc/` 作为确定性调度层：**

- whisper-cli 现有部分继续负责 **IM 出入口**（飞书）和**多 CLI 执行**（`src/ai/*` 适配器）；
- `src/orc/` 负责任务板、状态机和角色名额池。调度逻辑和审查、测试关卡都写在代码里，模型只在单个 agent 内部干活。

以下几条不做：

- 不 fork dsh，也不写成 dsh 插件；
- 不改造 dsh-superagent-prototype，只借鉴它的工程设计，不复用代码；
- 不用 CLI 自带的多 agent 编排（CodeBuddy 的 `--swarm`、teams、UI 里的 A2A 调用）。这些都由模型自己决定是否委派，不能保证必须经过审查和测试。

## 2. 调研事实

### 2.1 dsh（DeepSeek Harness）

- 本机装的是 `@deepseek-ai/dsh@0.2.0-rc.2`，MIT 协议，源码在 `github.com/deepseek-ai/deepseek-harness`。它基于 cordis 插件架构，安装后约 518MB。
- **Agent Teams 是一组插件**：
  - `dsh-experimental-agent-team`：团队服务，管理成员列表、消息队列、任务板和持久化日志；
  - `dsh-experimental-tool-agent-team`：给模型用的工具；
  - `dsh-experimental-client-ui-agent-team`：Web 界面；
  - `dsh-experimental-agent-team-profile`：组合包，在 `cordis.patch.yml` 里关掉普通子代理工具，再插入上面三个包。
- **已有能力**：
  - 任务板支持依赖关系，依赖完成后才能认领；
  - 任务更新带版本校验，不会互相覆盖；
  - 消息持久化：成员离线时排队，恢复后送达；
  - Lead 可以指派任务。
- **官方 README 列出的限制**：
  - 单进程运行，所有成员共用一个工作目录，没有 worktree 和文件锁；
  - 声明的写入范围只是提示；
  - 成员列表扁平且不可修改，只有一个总上限 `maxMembers`，不能按角色配数量；
  - 成员卡死或失败后，任务不会自动释放；
  - 消息不保证跨进程只投递一次；
  - experimental 包，不承诺稳定性。
- **teammate 的运行后端写死为进程内的 dsh agent**（`freshProvider: spawn` / `forkProvider: fork`）。`dsh-subagent` 留了换后端的接口（进程内、ACP、SDK、Codex、Claude Code），但 ACP 子代理只能一次性运行、不能续接。所以 CodeBuddy 目前没法挂成 dsh 的 teammate。

### 2.2 dsh-superagent-prototype

- 仓库 `github.com/deepseek-ai/dsh-superagent-prototype`，MIT 协议，研究原型，**以 dsh 组合包的形式交付**。
- Router 和 Worker 都是 dsh 会话（预设分别是 `dsh-superagent-router` / `dsh-superagent-worker`），用 dsh 自己的模型接入和工具。**它不直接调用外部 agent CLI。**
- **架构**（`docs/007-architecture.md`）：
  - `src/core` 是纯逻辑、不做 I/O，存储、权限策略、消息来源、评估器、执行器、对外发送都通过接口注入；
  - `DshExecutor`（`src/executor/dsh.ts`）是执行器接口的一个实现。
- 复杂度主要在**接收和准入**：消息来源接入、对话线程、是否接单的评估、授权、权限策略。主会话有 14 个工具。**它没有 critic/tester 流程。**
- `DshExecutor` 深度依赖 dsh 会话的内部机制：往运行中的会话插入消息、用会话事件判断消息已读、`ctx.jobs` / `ctx.subagents`。换成 CodeBuddy 需要全部重写。
- **公开实验数据**：P95 完成时间从约 30 分钟降到 15.7 分钟；代价是读缓存 token 约为单会话方案的 3.8 倍。

### 2.3 CodeBuddy

- CLI 版本 `codebuddy` 2.179.3。每个会话可以单独指定：`--model`、`--tools` / `--allowedTools` / `--disallowedTools`、`--permission-mode`、`-r/--resume`、`--session-id`、`--fork-session`、`-w/--worktree`、`--json-schema`、`--mcp-config`、`--append-system-prompt` 等。
- 还有 Python SDK `codebuddy-agent-sdk` 和 TS SDK `@tencent-ai/agent-sdk`。SDK 每个会话会启动一个 `codebuddy-headless` 子进程（约 170MB），支持在调度器进程里定义工具，再通过 MCP 挂给会话（`create_sdk_mcp_server`）。**本方案暂不用 SDK**，原因见 4.2。

### 2.4 whisper-cli 现状（本仓库）

- **IM 出入口**：飞书长连接，支持卡片和附件（`src/platform/feishu.ts`）。配置里已经有 `wecom` 类型，但还没有对应的适配器实现。
- **多 CLI 适配**：`src/ai/` 下有 codebuddy、codex、claude、gemini、cursor、pi 六个。每轮启动一次 CLI（`-p` + stream-json），支持续接会话，`workdir` 和 `model` 每次调用单独指定。
- **会话隔离**：适配器内部是 `Map<key, sessionId>`，key 可以用组合键，比如 `chatId#role:xxx`。这个 Map **只在内存里**，持久化靠 `agent-runner.ts` 自己完成。
- **`/review`**：一次性提示词，让 reviewer 审视上一轮回复。
- **`/team`**（`src/team.ts`，commit `65b6d38`）：多角色**讨论**。自动拆出 3～5 个视角角色，按顺序发言，限制轮数，最后由主持人收口。它没有任务、认领、产物，也没有「审查不过就打回」。
- **`dispatchAi`** 绑定的是一个 bot 组配置里的单个 CLI，不能按角色选 CLI。
- `agent-runner.ts` 已经 1570 行，新逻辑不再往里加。
- 运行环境 Node 22.19，内置 `node:sqlite`，不需要额外依赖。

## 3. 方案对比

| 方案 | 能复用什么 | 代价 | 结论 |
|---|---|---|---|
| A. 写成 dsh 插件，每个 agent 启动一个 cb | dsh 的插件生命周期和 Web 外壳 | dsh 的核心价值（agent 循环、工具、会话、上下文压缩、界面）都用不上；还要跟着 rc/experimental 接口变动 | 否 |
| B. 改 superagent，把执行器换成 cb | 分层干净的核心、存储、副作用队列 | 接收和准入逻辑大多用不上；执行器要重写；Router 仍是 dsh 的 LLM 会话；critic/tester 流程要自己加 | 否 |
| C. 新建独立项目（Python + SDK） | 照搬 superagent 的工程设计 | IM 出入口和多 CLI 适配都要重写一遍 | 否（被 D 取代） |
| **D. 放进 whisper-cli 的 `src/orc/`** | 飞书出入口、6 个 CLI 适配器、会话组合键 | 适配器要补少量参数；核心约 1000～1500 行 TS | **采用** |
| E. 从零写 agent 执行环境 | 无 | 工具、沙箱、上下文压缩都要重写 | 否 |

以后如果要接入 dsh 或 superagent，就把 orc 包装成 ACP agent 或 HTTP 服务，作为它们的执行器或子代理。方向是**它们来调 orc**，而不是把调度逻辑塞进它们内部。

## 4. 架构

### 4.1 总览

```
飞书 /task <目标>  ┐
orc CLI submit     ┴─▶ Planner（LLM，只负责拆任务，输出 JSON）─▶ SQLite 任务板
                                                               │
     调度循环（确定性逻辑，不用 LLM）◀─────────────────────────────┘
       ├─ 按角色池空闲名额，原子认领可执行任务（租约 + 心跳，超时自动回收）
       ├─ 每次尝试 = 一次适配器调用（role → cli + model + 会话 key + workdir）
       └─ 状态机硬性推进：
          design ─▶ critic ─▶ impl ─▶ critic ─▶ tester ─▶ ready ─▶ 人工验收
                     ▲ 不通过：带问题清单，用原 key 续接实现者会话返工（次数有上限，超过转人工）
     出口：只在三种情况通知飞书 —— 结果可用 / 需要决策 / 无法继续
```

> 002 修订：上图的阶段顺序只是 `dev` 组合的示例。流水线由 `orc/presets/*.yaml` 定义，代码负责执行，任务创建时保存配置快照。入口改为群 `mode=orc` + 主 agent 判断意图；每个任务另有一张原地更新的进展卡片。

### 4.2 执行方式：复用 `src/ai/*` 适配器，不用 SDK

- agent **不需要**任务板工具：
  - 调度器把上下文（规格、diff 摘要、历史审查意见、笔记索引）直接写进提示词；
  - 从输出里解析结构化结论，比如 critic 输出 `{verdict, issues[]}`，tester 输出 `{pass, cases[]}`。容错解析可以沿用 `parseRoster` 的写法。cb 可以额外加 `--json-schema` 约束输出格式。
- 共享笔记以文件形式放在 `.orc/` 下，agent 用自带的读文件工具查看。这样对所有 CLI 都通用，critic 可以用任意一家。
- 以后如果需要 agent 主动读写任务板，再通过 `--mcp-config` 挂一个本地 MCP 服务，不影响核心设计。
- **适配器需要补的参数**（按角色传入）：
  - `tools` / `disallowedTools`：critic 和 tester 只读；
  - `permissionMode`：cb 现在写死成 `bypassPermissions`；
  - `appendSystemPrompt`、`jsonSchema`；
  - 显式的 `sessionKey`（和 `chatId` 解耦）；
  - 返回 `sessionId`，供 orc 持久化。
- 新增 `src/orc/runner.ts`：按 `roles.yaml` 里的 `cli` 字段直接调用对应的 `runXxx`，**不经过 `dispatchAi`**。

### 4.3 角色配置 `roles.yaml`

> 002 修订：改为 `orc/roles/*.md`（人工维护的角色库）+ `orc/presets/*.yaml`（预制组合）+ 群级调整。指令只能选择和调整，不能现场生成角色（`discuss` 除外）。下面的字段说明仍然适用于角色的 frontmatter。

每个角色可配：`cli`、`model`、`count`（同时运行的数量）、`isolation`（`worktree` / `readonly` / `fresh`）、`tools`、`permission_mode`、`prompt`（追加的系统提示）、`max_turns`。

示例：

- `implementer`：cb + 主力模型，3 个，每个任务一个 worktree；
- `critic`：2 个，只读，用**不同的 CLI 或模型**（比如 codex 或 claude）；
- `tester`：1 个，每次都开全新会话，不继承实现者的对话，只看规格和产物；用例写入 `.orc/cases/`。

提示词可以参考 `/root/.codebuddy/agents/` 下的 `implementer.md`、`mighty.md`、`critic-manual.md`。

### 4.4 会话隔离与记忆共享

- **不共享对话记录**：
  - 返工时用原会话 key 续接实现者自己的会话；
  - critic 和 tester 永远开新会话，避免继承实现者的偏见；
  - 会话 key 格式为 `orc:<task>#<role>:<slot>`，对应的 sessionId 由 orc 存进 SQLite（适配器的内存 Map 重启后会丢）。
- **共享的只有三层**：
  1. 任务板和产物：规格、diff、审查意见、测试结论，放在 `.orc/tasks/<id>/`；
  2. 共享笔记：只能追加的决策和发现记录，放在 `.orc/notes.md`；
  3. 仓库文档：`CODEBUDDY.md` / `AGENTS.md` / ADR，由各 CLI 自动加载。
  4. （002 新增）群公告：每轮通过 `--append-system-prompt` 注入（不支持这个参数的 CLI 就放在提示词最前面），不落成工作区文件。

### 4.5 从 superagent 借鉴的工程设计

- **核心不做 I/O，通过接口与外部交互**：`src/orc/core` 是纯函数加事务，执行器和存储都注入进来，可以用内存版存储直接测试。
- **先记录再执行**：副作用（启动会话、投递消息、对外通知）在同一个事务里写进 `effect` 表，提交后再执行，失败按退避重试；名额不够时推迟执行，不算失败。
- **每类状态只有一个写入者**：任务和尝试记录只由 core 写，其他模块只读或发请求。
- **并发名额**：按角色限流，并为人工插话额外预留一个名额。
- **结构化汇报**：状态只有 `progress / ready / blocked / failed / dropped` 五种；只在结果可用、需要决策、无法继续三种情况通知人。
- **重启恢复**：被中断的任务重新启动时附带恢复说明，提示 agent：「在重复任何对外操作之前，先检查目录、git 历史和远端状态。」
- **暂时不需要**：消息来源的两级过滤（先规则后模型）、订阅直通、看门狗巡检。以后接群聊或 GitHub 时再加。

### 4.6 目录骨架（计划）

```
src/orc/
  core/          状态机 + 调度规则（纯逻辑）：task / attempt / review / verdict
  store.ts       node:sqlite：tasks, attempts(session_key, session_id, role, cli, model, worktree), effects
  effects.ts     持久化副作用队列 + 退避重试
  pool.ts        按 roles.yaml 分配角色名额
  runner.ts      role → src/ai/* 适配器；解析结构化输出
  worktree.ts    每个任务一个 worktree，critic/tester 只读
  prompts/       planner / implementer / critic / tester 模板
  cli.ts         orc submit / status / attach <task> / retry / stop（本地调试入口）
src/agent-runner.ts  只加 /task 命令与卡片通知的接线（出入口）
```

`src/orc/` **不依赖飞书**，飞书只是出入口之一。

### 4.7 和 `/team`、`/review` 的关系

- 002 修订：`/team` 并入组合体系。2026-11-09 再修订：`/team` 已删除，`discuss` 组合暂不做。
- `/review` 保持不变。orc 的 critic 是流水线里的一道关卡，不是聊天命令。

## 5. 小验证要确认的风险

1. 适配器补完参数后，critic 和 tester 在只读工具约束下能否正常工作；跨 CLI 续接会话是否稳定（各家的 resume 语义不同）。
2. 每次调用都启动一个 CLI 进程，并发 5～8 个时，内存和各家模型的限流能不能撑住。
3. 结构化结论（cb 的 `--json-schema`，其他 CLI 靠容错解析）稳不稳定。
4. 认证：各 CLI 的 key 或登录状态在 orc 里怎么配置（复用 bot 组配置，还是 `roles.yaml` 单独配）。
5. token 成本：多会话的开销对照 superagent 公布的 3.8 倍，看能否接受。
6. ～8. 见 002 §7：公告写回、其他 CLI 续接会话时追加内容是否每轮生效、主 agent 意图识别的误判率。

**第一步**：`core` + `store` + `effects` + `runner`，跑通一条 implementer(cb) → critic(另一个 CLI) → tester(cb 新会话) 的链路，先只用 CLI 入口，拿一个小需求逐项验证上面 5 点。跑通后再接飞书 `/task`。

## 参考

- dsh 本机安装：`/root/.nvm/versions/node/v22.19.0/lib/node_modules/@deepseek-ai/dsh`（各包 README 在 `node_modules/@deepseek-ai/*/README.zh.md`）
- superagent：`https://github.com/deepseek-ai/dsh-superagent-prototype`（重点看 `docs/003-execution.md`、`docs/007-architecture.md`）
- CodeBuddy CLI：`codebuddy --help`；SDK 类型定义：`codebuddy_agent_sdk/types.py`
