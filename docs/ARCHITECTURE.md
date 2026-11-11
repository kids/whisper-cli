# whisper-cli 整体设计

> 更新：2026-11-10　对应代码：`main`
>
> 本文是**当前实现**的总览，以它为准。历史设计和选型理由见 [orc/001](orc/001-selection-and-architecture.md)（调度层选型）、[orc/002](orc/002-chat-integration.md)（群模式、群公告、预制组合）；两者写于监督循环、附件发送之前，部分内容已被本文取代。
> `docs/orc/architecture.html` 是讨论用的图文版，不入库。

## 0. 定位

把飞书群（也支持企业微信智能机器人、Telegram，见 §1.1）里的消息转给本机的 AI CLI（codebuddy / codex / claude / cursor / gemini / pi），把回复发回群里。在此之上提供：

- **群级上下文**：群公告当指令、群记忆、最近对话，按群隔离，CLI 无关。
- **长任务监控**：后台训练等作业由代码定时探测，不占 CLI 进程、不耗 token。
- **附件发送**：agent 在回复里声明要发的图片 / 文件，由代码上传发送。
- **orc 编排**：多 agent 流水线，以及"监督者 + 执行者"的监督循环。

贯穿全局的三条原则：

1. **LLM 提议，代码裁决。** 模型只输出结构化的意图（回复里的 `[[...]]` 行、主 agent 的动作 JSON、监督者的动作 JSON），是否执行、怎么执行由代码决定；预算、门禁、不可逆操作确认模型绕不过去。
2. **凭证不进提示词。** agent 不直接调 IM 接口，不拿 token 或 chat_id；发消息、发附件、建监控都由 bot 进程代办。
3. **IM 只负责投递，状态在本地。** 长连接只用来收消息，发送走 HTTP；任务、账本、监控都持久化，进程重启后继续。

## 1. 分层

```
入口层   ImClient（src/platform/types.ts）：飞书 feishu.ts · 企微 wecom.ts · Telegram telegram.ts
          │
路由层   AgentRunner（src/agent-runner.ts）：一个 bot 一个实例
          ├─ 斜杠命令：/help /reset /model /new /status /记住 /记忆 /watch /mode /orc /task /tasks /stop
          └─ 消息分派（src/orc/route.ts，纯代码规则，§2.1）
               ├─ 普通对话 → 单 agent：直接跑 CLI
               └─ 要团队 / 说到进行中的任务 / 待回答的问题 / 任务卡片回复串 → 主 agent（lead）选动作
          │
上下文层 群公告（announcement.ts）· 群记忆（memory.ts）· 最近对话（recent.ts）· 监控 / 发送提示
          │
执行层   各 CLI 适配（src/ai/*.ts）：每轮一个子进程，-p 模式，可续接会话
          │
后处理   回复里的 [[remember]] / [[forget]] / [[watch]] / [[unwatch]] / [[task]] / [[image]] / [[file]] 行
          → 由代码执行并从回复中去掉
          │
编排层   orc（src/orc/*）：流水线引擎（core.ts）+ 监督循环引擎（loop.ts）+ 调度器（scheduler.ts）
          │
持久层   state/*.json · ~/.orc/orc.db（SQLite）· ~/.orc/worktrees · ~/.orc/tasks/<id>/
```

### 1.1 平台适配

`AgentRunner` 只依赖 `ImClient` 接口（`src/platform/types.ts`）；群 id 带前缀区分平台：飞书 `oc_…`（原样）、企微 `wc_<chatid 或 userid>`、Telegram `tg_<chat id>`，`isChatKey()` 用它区分真实会话和内部 session key。

| 能力 | 飞书 | 企微智能机器人（`@wecom/aibot-node-sdk` 长连接） | Telegram（Bot API 长轮询） |
|---|---|---|---|
| 收消息 | 全部 | 群里只收 @ 的；文本 / 语音（已转文字）/ 图片 / 文件 / 图文混排 | 隐私模式关闭才收全部；文本、图片、文件（带说明文字） |
| 回复原地刷新 | 卡片 patch | 只能刷新"回复触发消息的流式消息"，`WECOM_STREAM_MAX_MS` 后收尾，结果另发 | `editMessageText`，3 秒一刷，429 时丢中间帧 |
| 监控卡片 / 任务卡片刷新 | ✅ | ❌（发一次，不刷新） | ✅ |
| 回复串 | 话题 | ❌（`replyInThread` 返回 false，改发群里） | 回复卡片消息；回复 bot 消息带 `rootId`，所以回复任务卡片 = 进卡片回复串 |
| 群公告 | ✅ | ❌（lead 的 announce 动作改为提示"记住…"） | ❌ |
| 建群 / 管理台 | ✅ | ❌（`ADMIN_MODE` 忽略，`/new` 提示手动拉群） | ❌ |
| 附件下载 | `messageResource` | 链接 5 分钟失效，收到消息时就下载到内存，处理时落盘 | `getFile`，≤20MB |
| markdown | 卡片 / post | 原样（单条 ≤20KB，按字节分段） | 转 HTML 子集，解析失败退回纯文本；4000 字分段 |

## 2. 一条消息的路径

1. 平台事件进入 `AgentRunner`，按群串行排队；`/stop` 绕过队列直接终止当前运行。斜杠命令直接处理；「把工作目录切到 …」/ `项目名:指令` 由代码切换本群工作区（§2.2）；「停掉监控」这类短句由代码直接停（§4）；其余消息先分派（§2.1），交给单 agent 的走下面 2–5 步，交给主 agent 的见 §6.1。
2. 组装系统提示（`--append-system-prompt` 或前缀，不写进工作区，避免共用仓库的群互相串）：
   - 群公告（仅飞书；按 revision 缓存，变了才重新拉取）；
   - 本群工作区，以及「只有用户能切、你自己切不了」；
   - 群记忆；
   - 进行中的监控摘要和 `[[watch]]` 用法（可用 `WHISPER_WATCH_HINT=0` 关掉）；
   - 附件发送用法（`[[image]]` / `[[file]]`）；
   - 转交团队的用法（`[[task]]`，可用 `WHISPER_TASK_HINT=0` 关掉）。
3. 在该群绑定的工作区里运行 CLI，流式更新回复卡片；超时由 `AGENT_STALL_MS`（默认 45 分钟无输出）和 `AGENT_MAX_MS` 控制。
4. 后处理回复：抽出 `[[...]]` 行交给对应模块，余下文本发回群里；长回复、表格多的回复发一条 post，卡片改成提示"见下方"，避免重复。
5. 记录到最近对话（`state/recent-turns.json`，每群最多 10 轮），供 orc 主 agent 读取。

### 2.1 消息分派：单 agent 还是主 agent

用户不需要知道有两种 agent，也不需要命令。每条消息先由 `src/orc/route.ts` 的规则判断（纯代码，不调模型、没有延迟），两边都能纠正误判，所以规则只需要在常见情况下对：

- **主 agent → 单 agent**：主 agent 判断其实只是普通问答、讨论、一轮能做完的事时，用 `chat` 动作把消息原样交给单 agent。
- **单 agent → 团队**：单 agent 判断一件事需要团队时，在回复里写一行 `[[task]] {"goal":…,"preset":"loop","criteria":[…],"constraints":[…]}`，代码提交任务、发进展卡片（这一行不显示给人）。

分派顺序（命中即停）：

| # | 条件 | 去向 |
|---|---|---|
| 1 | 本群是编排模式（orc） | 主 agent |
| 2 | 在任务卡片的回复串里说话 | 主 agent |
| 3 | 有监督循环任务在等人回答，且消息较短（≤40 字）、像是在调整任务、点名了任务或说到"任务 / 执行者"等 | 主 agent |
| 4 | 主 agent 有待确认的提议，且消息只是"好 / 确认 / 算了 / 就这么改"之类 | 主 agent |
| 5 | 本群是单 agent 模式（single） | 单 agent |
| 6 | 要切换模式（"切到编排模式""回到单聊模式""退出团队模式"） | 主 agent |
| 7 | 消息带图片 / 文件（主 agent 看不到附件） | 单 agent |
| 8 | 命中"要团队"关键词 | 主 agent |
| 8.5 | 说到"监控 / 别盯了"，且没点名任务、没提"任务 / 执行者" | 单 agent |
| 9 | 本群有进行中的任务（或 24 小时内失败 / 卡住的），且消息点名了任务（`#12`、"12 号那个"、标题里连续 4 个字），或是在调整任务（"先别 / 停一下 / 再试 / 放弃 / 换成 / 进展 / 刷屏"等，短消息或带"任务 / 执行者"字样） | 主 agent |
| 10 | 其他 | 单 agent |

"要团队"关键词（参考，完整正则见 `TEAM_PATTERNS`）：

| 类别 | 例子 |
|---|---|
| 交给团队 | 交给团队、让团队、团队来做、派个团队 |
| 多 agent | 多 agent、多个模型一起、多智能体、分工协作 |
| 编排 / 监督 | 编排、监督循环、监督者 |
| 开任务 | 开个任务、建个后台任务、提交任务 |
| 换模型评审 | 交叉评审、换个模型再审一遍、两个模型分别看 |
| 迭代到达标 | 一直调参直到 loss 低于 0.3、反复修直到测试全部通过为止、自动迭代、帮我盯着跑 |

刻意**不**算团队信号的：普通的"修一下 / 跑一下测试 / 改成异步"（单 agent 一轮能做）、"后台跑训练、跑完叫我"（单 agent 用 `[[watch]]`）、"记住…"（单 agent 用 `[[remember]]`）。

本群模式（一般不用改；说"回到单聊模式""以后都走团队"也能切）：

| 模式 | 行为 |
|---|---|
| `auto`（默认） | 按上表分派 |
| `single` | 只用单 agent；第 2–4 条（回复串、待回答的问题、待确认的提议）仍交给主 agent |
| `orc` | 每条消息都先经过主 agent，要动手的事都交给团队 |

离线用例在 `scripts/route_check.ts`（65 条分派用例）；主 agent 在 auto 模式下把误分派的消息交回、切换模式的能力在 `scripts/orc_lead_check.ts`（真实模型）里验证。

### 2.2 工作区

每个群的工作区按这个顺序取：显式设置（`state/chat-workspace.json`）→ 管理台任务群登记的目录（`.tasks.json`）→ `WORKDIR`。单 agent、主 agent 和团队任务（orc 取它所在的 git 仓库）都用它。

- 设置方式：`/工作区 <绝对路径或项目名>`（`/workspace` `/ws` `/cd` 同义，`/工作区 默认` 恢复）；说「把（群的）工作目录切到 X」「工作区换成 X」「切到 X 项目」「cd X」；或消息以 `项目名:` 开头。后面带的指令（「…然后跑一下测试」）切换后照常执行。项目名查 `projects.json`（已 gitignore，本机自行维护）。
- 切换真的改变了目录时，丢弃本群单 agent 会话（CLI 的会话按目录存放），token 累计保留；回复里说明新目录是不是 git 仓库（不是就用不了团队任务）。
- 模型无法自己切换。群记忆里「工作目录是 X」这类条目会让模型以为已经切过，所以：切换时删除这类条目；agent / 主 agent 用 `[[remember]]` 写这类条目时拒收并提示正确做法。

## 3. 群级上下文：谁读、谁写

| 内容 | 存储 | 谁读 | 谁写 |
|---|---|---|---|
| 群公告（本群的长期指令） | 飞书群公告（docx） | 每轮注入所有 agent（单 agent、主 agent、orc 各角色） | 人直接改；主 agent 的 `announce` 动作需人确认后追加，带版本校验 |
| 群记忆（事实、偏好） | `state/chat-memory/`（`CHAT_MEMORY_DIR`），每群 ≤60 条 | 每轮注入 | `/记住`、`/记忆 forget/clear`；单 agent 回复里的 `[[remember]]` / `[[forget]]`；主 agent 的 `remember` / `forget`。orc 的 worker 只读 |
| 最近对话 | `state/recent-turns.json` | orc 主 agent（每条消息都是新会话，只靠它接上下文） | 单 agent 和主 agent 每轮自动记录 |

不用 CodeBuddy 自带的 Auto Memory：它按 cwd 区分，共用仓库的群会串，orc 的 worktree 会把它打散，其他 CLI 也看不到。

## 4. 长任务监控（`src/watch.ts`）

一次 CLI 运行有时长上限，不能干等几个小时的训练。做法是 agent 把作业放后台、登记监控、结束本轮；之后由代码定时探测。

- 登记：单 agent 回复里写 `[[watch]] {"title":…,"pid":…,"log":…,"done":…,"wake_on":[…],"stale":"30m","metrics":{…},"file":…,"cmd":…,"every":"10m","timeout":"2d","report":"1h","note":"给人看的进展","on_wake":"…"}`；刷新卡片 `[[watch]] {"id":N,"note":"…"}`；取消 `[[unwatch]] <编号>`。
- 人停监控直接说：「停掉监控」「别盯了」「训练那个监控关了」「停掉监控 #3」「监控全停了」。短句（≤40 字）、不是疑问、不是复合指令（"…然后…"、提到进程 / kill）时由代码直接处理（`parseStopWatchIntent` / `planStopWatches`），不跑模型：给了编号停编号；说"全部"停本群全部；否则按标题里的词匹配；只有一个就停它；有多个且分不出来就列出来问。其余说法交给单 agent（它有 `[[unwatch]]` 和本群监控列表）；分派层把说到"监控"的消息留给单 agent，不送主 agent。监督循环挂着的监控（`orc-loop:<id>`）不让单独停，提示改为叫停任务，免得任务卡住。`/watch stop <编号>` 仍可用。
- 探测类型：进程存活、日志尾正则（完成标记、报错）、日志多久没更新、指标文件、产物文件、自定义只读命令。每 `WATCH_TICK_MS`（默认 15 秒）扫描到期项，单项最短间隔 30 秒。探测零 token，只决定何时触发，**不写进群卡片**。
- **群卡片 = agent 的 `note` 原文**（无状态壳、无探测摘要、无停法提示）；没有 note 时只显示 `监控 #N 标题`。探测不会刷新卡片，只有 agent 改 note（或结束时）才更新。
- 可选 `report`（≥30 分钟）：到点软叫醒 agent，让它写关键进展进 `note`；条件满足、出错或超时：**不把探测日志/指标原文贴进群**（那是难读的模板）；有 `on_wake` 则静默唤醒 agent 写人话，orc 监督循环则交回账本由监督者汇报；仅无 `on_wake` 的监控发一句短通知。
- 状态存 `state/watches.json`，重启后接着探测。
- orc 监督循环的 `wait` 动作复用同一套监控（`sessionKey = orc-loop:<taskId>`），触发后交回该任务的账本，而不是唤醒群里的 agent。

## 5. 附件发送（`src/outgoing.ts`）

agent 先把图片或报告存成本地文件，再在回复里单独占一行：

```
[[image]] /abs/path/loss.png
[[file]]  /abs/path/report.html
```

- 由 `AgentRunner` 统一解析，对所有 CLI 生效（中文别名 `[[图片]]` / `[[文件]]` 也认），代码块里的行不算；这些行从回复中去掉。
- 相对路径按当前工作区解析。只允许发送工作区、项目目录、bot 工作目录、`/tmp` 和 `WHISPER_SEND_ROOTS` 下的文件；会先解析软链再判断。
- `.env`、私钥、证书、`.ssh` / `.git` 等目录里的文件一律拒发。
- 图片 ≤10MB，超了或不是图片格式就按文件发送；其他文件 ≤30MB；每条回复最多 10 个。
- 发不出去时在回复末尾说明原因。
- 兜底：回复里直接出现的图片绝对路径仍会静默发送；其他类型的裸路径**不会**再自动上传（以前会，有泄露风险）。
- 平台层实现 `sendAgentImages` / `sendAgentFiles`：飞书先上传拿 key 再发；企微 `uploadMedia` + `sendMediaMessage`；Telegram `sendPhoto` / `sendDocument`。

## 6. orc 编排

### 6.1 入口与主 agent

- 消息怎么到主 agent 见 §2.1。主 agent（lead）只读、短超时、每次新会话，默认模型见 §6.2 角色表下方，可用 `ORC_LEAD_MODEL` 覆盖。上下文是：本群模式和分派理由、最近对话、本群进行中的任务（含待回答的问题、当前角色）、可用的组合和角色、待确认的提议；在任务卡片回复串里说话时，还会标明是哪个任务。
- 兜底命令（用户一般不用）：`/mode auto|single|orc [组合]`、`/task <目标>`、`/task <id>`、`/task stop|retry|attach <id> …`、`/tasks`、`/orc`、`/orc preset <名> | reset | confirm | cancel`。bot 自己的提示文案只教自然语言（"回复「确认」""说「再试一次」"），不再教命令。
- 主 agent 只输出一个动作，由代码执行：

| 动作 | 作用 |
|---|---|
| `reply` | 直接回答 |
| `submit {goal, preset?, criteria?, constraints?}` | 提交任务；人的原话一起存下，供后续引用核对 |
| `attach {task, text, urgent?}` | 给进行中的任务补充要求；`urgent` 会打断正在干活的 worker |
| `answer {task, option?, text?}` | 回答监督循环提出的问题 |
| `status` / `stop` / `retry {note?}` | 查询、终止、重试 |
| `config {patch, task?, verbosity?}` | 不带 task：改本群以后的编排，需确认。带 task：对进行中的监督循环任务立即生效（换角色的 CLI / 模型、调播报档位） |
| `confirm` / `cancel` | 确认或放弃待确认的提议 |
| `announce` | 追加群公告，需确认 |
| `remember` / `forget` | 改群记忆 |
| `mode {auto\|single\|orc}` | 切换本群的分派方式 |
| `chat` | 不是团队的事，把消息原样交给单 agent |

所以无论交给团队、换模型、改记忆、调方向还是回答问题，人都只需要在群里用自然语言说。

### 6.2 预制组合与角色

编排不现场生成，从 `orc/presets/*.yaml` 选，角色定义在 `orc/roles/*.md`（frontmatter 写 CLI、输出类型、隔离方式、超时，正文是角色提示词）。群可以在组合基础上改角色的 CLI / 模型。

| 组合 | 形态 | 内容 |
|---|---|---|
| `dev` | 流水线 | 规划 →（可选）设计评审 → 实现 ⇄ 评审 → 独立测试 |
| `fix` | 流水线 | 写失败用例复现 → 修复 → 回归测试 → 评审 |
| `research` | 流水线 | 调研 → 对抗式审视 → 汇总 |
| `review` | 流水线 | 两个不同模型各审一遍 → 汇总，只审不改 |
| `loop` | 监督循环 | 监督者 supervisor ⇄ 执行者 implementer，审查者 critic |

| 角色 | 默认 CLI / 模型 | 输出 | 隔离 |
|---|---|---|---|
| planner | codebuddy / claude-sonnet-5.5 | plan | 只读 |
| supervisor | codebuddy / claude-sonnet-5.5 | action | 只读 |
| implementer / reproducer | codebuddy / deepseek-v4.1-flash-ioa | impl | worktree 可写（implementer 续接会话） |
| tester | codebuddy / deepseek-v4.1-flash-ioa | test | 每次新开 |
| researcher / synthesizer | codebuddy / deepseek-v4.1-flash-ioa | report | 只读 |
| critic | codebuddy / gpt-6.1-sol | verdict | 只读 |
| critic_alt | codebuddy / claude-opus-5.5 | verdict | 只读 |

模型写在 `orc/roles/<角色>.md` 文件头。把角色换到别的 CLI 而不指定模型时，用那个 CLI 的默认模型；换到 cursor 一律是 `auto`。主 agent 默认：codebuddy bot 用 claude-sonnet-5.5，cursor bot 用 auto，其他 CLI 用各自默认；`ORC_LEAD_MODEL` 优先。

本机没有某个角色的默认 CLI 时（比如没装 codebuddy），这个角色自动改用本机已配置的 CLI：优先用本群 bot 自己的 CLI，模型用那个 CLI 的默认值（cursor 为 `auto`）。提交任务、`/orc` 和主 agent 看到的编排都会说明改用了什么。人明确指定的 CLI 不会被替换，没配置就报错。

通用机制：每个任务一个 git worktree 和分支，写入角色每轮自动提交；只读角色越权写入会被回滚；角色并发名额限制；所有副作用（启动、通知、轮次）都是持久化 effect，崩溃恢复后重放。

### 6.3 流水线（`core.ts`）

纯状态机：按组合里的阶段顺序跑，评审或测试不通过就按 `on_fail` 退回。支持可选阶段（群里按需启用）、只给意见不阻塞的阶段（advisory），以及规划者把任务拆成子任务（子任务全部结束后父任务再收尾）。适合目标清晰、能一次验收的任务。

**退回由进展决定，不由轮数决定**（`decideAfterAttempt`）：

- **只剩建议级问题**（没有 blocker / major）：按这单的评审口径不算不过 → 带着已知问题继续下一阶段，并在反馈和通知里列出这些"建议"。
- **这一轮没有新问题**（剩下的问题是上一轮那批、只是行号或措辞变了）：继续退回重做，这属于在收敛。
- **每轮都在冒新问题**：说明卡的不是代码而是尺子 → 交给 advisor 仲裁：按这单的评审口径判断剩下的是不是真会让结论站不住。按口径不影响结论就带着已知问题继续（逐条列给人看），否则写决策说明交给人。
- `max_loops` 退化成**失控保护**（默认 review 6 / test 3 / critique 6），不是正常退出方式。

**评审口径（`bar`）**：提交任务时由主 agent 按任务性质写一段话，评审者按它把关——探索性、一次性分析只拦会让结论错的问题；生产 / 对外交付才按工程标准全套卡。不写则按"目标是否达成、结论是否站得住"的一般尺度。口径是任务属性，不是全局参数，所以不同任务可以不同尺度。

### 6.4 监督循环（`ledger.ts` + `loop.ts`）

适合需要反复试错、长时间实验、或目标会随讨论调整的任务。监督者替代"人盯着长会话"：看进展、调方向、纠错、追问。

**每一轮**：调度器取出一个持久化的 `loop` effect（同一任务的轮次不重叠，全局并发 `ORC_LOOP_CONCURRENCY`，默认 3）→ 从账本重建上下文 → 监督者在**新的只读会话**里提出一个动作 → 代码校验 → 执行 → 结果写回账本 → 排下一轮。进程崩溃时这一轮会带 `recover` 标记重跑，监督者会被提示先核实再重复操作。

**账本**（SQLite `ledgers` 表，每轮记录在 `loop_steps`）：

- 目标、验收标准 `C1…`、约束 `K1…`（带版本号）、计划、关键决定；
- 证据 `E1…`：每条记录采集时的代码版本（sha）；
- 观察记录、人的消息队列（inbox）、人的原话记录（用于核对引用）、已获批准的不可逆操作、待回答的问题；
- worker 会话（epoch、已续接轮数）、预算、守卫计数、等待中的监控。

**动作集与代码把关**：

| 动作 | 作用 | 代码把关 |
|---|---|---|
| `instruct {text, fresh?}` | 给 worker 下指令，默认续接会话；约束和验收标准由代码附上 | 含不可逆操作（push、部署、删库等，前面有"不要"等否定词的不算）时，必须先有人批准，一次批准只放行一次 |
| `verify {checks}` | 代码直接跑只读检查命令，结果成为证据 | 必须是只读命令；最多 8 条；单条超时 ≤1800 秒（默认 10 分钟） |
| `report {progress, …}` | 给人看的进展和建议，不阻塞 | 不能连续两轮都是 report |
| `update_constraints {changes, reason, source, quote?}` | 改约束或验收标准 | 收紧可以直接改；修改、删除必须 `source=human`，并原样引用人说过的话（代码核对原话记录） |
| `review {focus?}` | 让审查者看当前改动，结论成为证据 | 需要配置了审查者 |
| `wait {watch, heartbeat?, keep?}` | 挂起等外部作业，复用监控模块 | 需要绑定群；监控规格按 `/watch` 规则校验；心跳最短 10 分钟 |
| `ask {question, why, options, default}` | 问人 | `why` 只能是 irreversible / high_cost / goal_ambiguous。irreversible 必须有一个 `go` 选项且它不能是默认，超时也不自动执行；其他问题 4 小时（`ORC_LOOP_ASK_TIMEOUT_MS`）没回复按默认继续 |
| `finish {summary, acceptance}` | 完成 | 每条验收标准都要对应一条**在当前代码版本上采集并通过**的证据；代码改过之后旧证据作废；`require_review` 时还要有通过的审查 |
| `abort {reason, tried, blockers, unmet}` | 放弃 | 字段必填，`unmet` 必须是已有的验收标准 |

被拒的提议不会执行，拒绝理由写进下一轮的上下文。

**守卫**（触发后转成问人，默认选项多为"停下"）：

- 原地打转：连续 4 轮进展没有变化；
- 同一个错误出现 3 次时提示监督者，5 次时问人；
- 连续 3 次提议无效；
- 预算：轮数、worker 运行次数、活跃时长（默认 60 / 25 / 8 小时），用到 80% 时提醒，用完问人是否追加；
- 基础设施连续出错时退避重试，第 3 次转为 blocked。

**worker**：续接同一个会话，超过 `ORC_LOOP_WORKER_TURNS`（默认 15）轮，或人换了 CLI / 模型时开新会话，并附上交接摘要。提示词要求长作业用 `setsid nohup` 放后台，并在输出里报告 `job{pid, log}`，供监督者接着用 `wait`。

**等待长作业**：`wait` 期间不跑任何轮次、不耗 token。监控触发后结果作为证据写入账本并唤醒任务；期间人发的消息会唤醒一轮，监督者可以 `wait {keep:true}` 继续等。

**人在运行中介入**：

- 人的消息先进 inbox，下一轮交给监督者；`urgent` 会打断正在跑的 worker。
- 监督者在问问题时，人的回复直接作为回答；选了 irreversible 的 `go` 选项才记为批准。
- 换角色、调播报档位立即生效，并作为观察记录告诉监督者。
- 外部写入（人的消息、监控触发、角色调整）只追加到账本的队列里，`commit()` 在事务中合并，不会和正在进行的一轮互相覆盖。

**群里怎么看**：每个任务一张主卡片，原地更新（状态、进展、验收标准、预算、待回答的问题）；每一轮一张卡片发在主卡片的回复串里（见 §6.5）。播报分三档：quiet（只发汇报、提问和结果）/ normal（每轮一张卡片，默认）/ verbose（附指令原文和监督者分析）。

### 6.5 群里的卡片

- **主卡片 = 目录**：提交任务时发在群里，原地更新：组合、阶段、状态、退回次数、已用 token、最近 6 次运行各一行。卡在名额上时写明「排队等 critic：名额被 #3 占着」。
- **每个 agent 一张卡片，发在主卡片的回复串里**（`src/orc/agent-cards.ts`）：
  - 流水线（dev / fix / research / review）：每次运行一张。标题是「角色 · 模型 · 环节第 N 次 · 状态」；运行中显示用时和最近几条进度（5 秒节流）；结束后只留结论——写代码 / 调研的留摘要和提交号，评审留结论、已确认修复、major 问题（文件:行号 + 第一句），次要意见折叠；测试留通过数和失败用例；都附完整输出文件路径。根据上次评审 / 测试重做的，开头写「这一版是根据上次评审的 N 条意见重做的」。
  - 监督循环：每轮一张，列出这一轮监督者、执行者、审查各跑了多久、用了多少 token，结束时补上这一轮的「主 → 子」往来。
- **主聊天区只发要人看的**：结果可用、需要你决定、失败、汇报。
- **播报**：`/orc 播报 安静|正常|详细`（本群）；安静 = 不发 agent 卡片。`ORC_AGENT_CARDS=off` 全局关闭。
- 卡片 id 记在 `~/.orc/agent-cards.json`，重启后接着更新；重启前就已结束的运行不补发。企微没有回复串，不发 agent 卡片，主卡片照常。

### 6.6 产物与恢复

- `~/.orc/orc.db`（`ORC_HOME`）：`tasks` / `attempts` / `effects` / `ledgers` / `loop_steps`。
- `~/.orc/worktrees/`：每个任务的工作区；`~/.orc/tasks/<id>/`：每轮的提示词和输出（监督循环为 `loop-<n>-<role>.prompt.md` / `.output.md`）。
- 启动时把运行中的 effect 重置为待执行（标记 recover），未完成的任务接着推进。

## 7. 状态文件

| 文件 | 内容 |
|---|---|
| `state/state_<N>.json` | 每个 bot 的会话、模型、token 累计 |
| `state/chat-memory/` | 群记忆 |
| `state/recent-turns.json` | 最近对话 |
| `state/watches.json` | 监控 |
| `state/orc-chats.json` | 每群的模式、编排、待确认提议 |
| `~/.orc/` | orc 数据库（`tasks` 里的 `bar` 是这单的评审口径）、worktree、每轮产物、卡片映射（`cards.json`、`agent-cards.json`） |
| `.tasks.json` | 管理群的工作组 ↔ 会话（沿用 feishu-cursor） |

## 8. 主要环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `AGENT_STALL_MS` / `AGENT_MAX_MS` | 45 分钟 / 不限 | CLI 无输出超时 / 总时长上限 |
| `WHISPER_WATCH_HINT` | 开 | 设为 `0` 不注入监控用法 |
| `WHISPER_SEND_ROOTS` | 空 | 额外允许发送附件的目录，冒号分隔 |
| `WATCH_TICK_MS` / `WATCHES_PATH` | 15 秒 / `state/watches.json` | 监控扫描间隔 / 存储位置 |
| `CHAT_MEMORY_DIR` / `RECENT_TURNS_PATH` | `state/…` | 群记忆 / 最近对话位置 |
| `ORC_HOME` / `ORC_CHATS_PATH` | `~/.orc` / `state/orc-chats.json` | orc 数据 / 群编排配置 |
| `ORC_LEAD_MODEL` / `ORC_LEAD_HARD_MS` / `ORC_LEAD_STALE_MS` | codebuddy→claude-sonnet-5.5，cursor→auto / 4 分钟 / 2 分钟 | 主 agent 模型与超时 |
| `WHISPER_TASK_HINT` | 开 | 设为 `0` 不向单 agent 注入 `[[task]]` 用法 |
| `ORC_LOOP_CONCURRENCY` | 3 | 同时进行的监督循环轮次 |
| `ORC_LOOP_ASK_TIMEOUT_MS` | 4 小时 | 非不可逆问题的默认回答时限 |
| `ORC_LOOP_WORKER_TURNS` | 15 | worker 续接多少轮后换新会话 |
| `ORC_CARD_THROTTLE_MS` | 30 秒 | 主卡片更新节流 |
| `ORC_AGENT_CARDS` | on | `off` 关闭回复串里的 agent 卡片 |
| `ORC_AGENT_CARD_THROTTLE_MS` | 5 秒 | agent 卡片更新节流 |
| `WECOM_STREAM_MAX_MS` | 5 分钟 | 企微流式回复多久后主动收尾（结果改为另发） |
| `WECOM_MD_MAX_BYTES` | 20000 | 企微单条 markdown 上限；发送失败自动按 4000 字节重发 |

## 9. 验证脚本（`scripts/`）

| 脚本 | 类型 | 内容 |
|---|---|---|
| `orc_check.ts` / `orc_extras_check.ts` | 离线 | 流水线解析、状态机、假执行器端到端、崩溃恢复 |
| `orc_loop_check.ts` | 离线 | 监督循环：各项把关、完成门禁、引用核对、不可逆批准、换角色、长作业等待、守卫、崩溃恢复 |
| `runner_wiring_check.ts` / `memory_check.ts` / `watch_check.ts` / `outgoing_check.ts` | 离线 | 路由接线、记忆、监控（含自然语言停监控）、附件 |
| `route_check.ts` | 离线 | 消息分派规则（57 条）、`[[task]]` 解析 |
| `im_check.ts` | 离线 | 企微（假 SDK）/ Telegram（假 fetch）适配器、配置解析、分段工具 |
| `orc_lead_check.ts` | 真实模型 | 主 agent 意图识别（22 条，含 auto 模式下交回单 agent、切换模式） |
| `outgoing_agent_check.ts` | 真实模型 | agent 是否按 `[[image]]` / `[[file]]` 协议发图、发文件 |
| `announce_check.ts` / `memory_live_check.ts` / `watch_live_check.ts` / `outgoing_live_check.ts` | 真实飞书 | 临时建群验证后解散 |

运行：`npx tsx scripts/<name>.ts`；类型检查：`npx tsc --noEmit`。

## 10. 现状与后续

已上线（`whisper-feishu.service`，systemd 托管，直接运行工作区代码）：单 agent、群公告、群记忆、监控、附件发送、orc 流水线、监督循环 M1。

未完成：

- **企微 / Telegram 真机验证**：适配器只有离线检查，还没用真实机器人跑过。
- **监督循环在真实群里的端到端使用**：卡片回复串、监控交回任务目前只有离线检查。
- **监督者汇报附图**：report / ask 还不能带 `[[image]]`。
- **后续里程碑**（详见 architecture.html）：M2 小训练脚本模拟长任务 + 中途重启；M3 审查调用流水线、`loop-dev` / `loop-train` 组合、主 agent 自动选形态；M4 断线补拉历史消息；M5 远端作业平台（太极、k8s）的作业句柄与探测适配、GPU 时长预算。
- **成本**：一次 6 轮的真实闭环统计约 112 万 token（可能含缓存读取），账本长度和观察摘要还需要控制。
