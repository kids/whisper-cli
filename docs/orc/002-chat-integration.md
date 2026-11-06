# 002 orc：群模式、进展同步、群公告约束、预制组合

> 日期：2026-11-06　状态：设计定稿，部分已实测　前置文档：[001](001-selection-and-architecture.md)
>
> 本文档覆盖并修订 001 的这几处：流水线不再写死在代码里（改为预制组合）；群级约束不落成文件（改为群公告注入）；`/team` 并入组合体系。

## 0. 需求

1. 群里的 agent 可以随时在**单 agent** 和 **orc 主 agent** 之间切换。
2. 长时间运行的任务要能**同步中间进展**；一轮跑完后，多 agent 场景**继续按编排推进**。
3. **群公告就是这个群的 agent 指令**：每次运行都受公告约束；指令被修改时，也写回公告。
4. orc 可以**根据用户的话调整角色和编排**。

## 1. 结论

| 需求 | 支持情况 | 关键设计 |
|---|---|---|
| 1. 模式切换 | 支持 | 每个群有 `mode`；主 agent 只判断意图、输出结构化动作，由代码执行；orc 有自己独立的调度循环，不占用群消息的串行队列 |
| 2. 进展与续跑 | 支持（有限制） | 每个任务一张原地更新的卡片；状态机通过持久化的副作用记录推进；**CLI 运行中途无法插入消息** |
| 3. 群公告即指令 | 支持，读取已实测 | 公告内容每轮通过 `--append-system-prompt` 注入，**不写成工作区文件**；写回时校验版本号、只改相关的块 |
| 4. 按指令调整 | 支持（受限） | **预制组合 + 人工维护的角色库**，指令只能选择和调整，不能现场造角色（`discuss` 组合除外） |

## 2. 群模式

### 2.1 状态

`.teams.json` 扩展成每个群一份配置，以后迁到 orc 的 SQLite：

```ts
interface ChatProfile {
  chatId: string;
  mode: "single" | "orc";
  preset?: string;            // orc 模式下选用的组合：dev / fix / review / research / discuss
  overrides?: PresetPatch;    // 群级对组合的调整（见 §5.3）
  presetVersion?: number;     // 每次调整加 1
  announcement?: { revisionId: number; text: string; fetchedAt: number }; // 公告缓存
}
```

- 用 `/mode single` / `/mode orc [组合名]` 切换，也可以直接说「切到 dev 编排」，由主 agent 识别成 `config` 动作。
- 原来的 `/team <描述>` 保留成快捷方式，等于 `/mode orc discuss`，并用描述生成讨论角色。

### 2.2 消息分发

```
handleMessage
  ├─ /stop：不进队列，立即执行（现状）。在 orc 群里会停掉该群全部运行中的任务，或者用 /stop <task> 只停一个
  └─ enqueue(chatId) → processMessage → handleCommand
        ├─ mode=single → runAiAndReply（现状）
        └─ mode=orc    → 主 agent 判断意图 → 输出结构化动作 → orc 代码执行 → 立即返回（不等任务跑完）
```

**群消息的串行队列只负责「收到消息并分发」**。orc 任务交给 orc 自己的调度循环和角色名额去跑，否则一个跑几十分钟的任务会把整个群堵住。

### 2.3 主 agent 的职责

- 会话 key 为 `chatId#lead`，用便宜、快的模型，**只能读文件，不能写**。
- 每轮输入包括：群公告、当前组合和角色列表、进行中任务的摘要卡片、用户这条消息。
- 输出（用 JSON schema 约束）只能是以下动作之一，或者直接回复用户：

| 动作 | 含义 |
|---|---|
| `submit {goal, preset?}` | 新建任务 |
| `attach {task, text}` | 把补充信息交给某个进行中的任务（§3.3） |
| `status {task?}` | 查询状态 |
| `stop {task}` / `retry {task}` | 停止或重试 |
| `config {patch}` | 调整组合（§5.3），需要人确认 |
| `announce {patch}` | 修改群公告（§4.3），需要人确认 |
| `reply {text}` | 直接回答，不新建任务 |

- 拿不准是什么意图时，**直接问用户，不要猜**。

### 2.4 来回切换

- 三种模式用不同的会话 key，切换时互不覆盖：
  - 单 agent：`chatId`
  - 主 agent：`chatId#lead`
  - orc worker：`orc:<task>#<role>:<slot>`
- 切回单 agent 时，正在跑的 orc 任务**继续在后台运行**，卡片照常更新。单 agent 的提示词里会带上「后台任务」摘要，最多 5 条，每条一行。
- 从单 agent 切到 orc：如果用户说「把刚才这个交给团队做」，主 agent 会把最近几轮单 agent 对话总结成任务目标，作为 `submit` 的 `goal`。

## 3. 长任务的进展同步与续跑

### 3.1 进展卡片

每个任务**一张卡片，原地更新**。数据来自适配器已有的 `onStreamUpdate`，每 30～60 秒刷新一次：

```
🛠 #12 修复登录超时 · dev · 阶段 impl(2/5) · 运行 14m
implementer-1 [cb/glm-5.3]  最近：运行 pytest tests/auth（3 失败 → 1 失败）
critic 待命 · tester 待命 · 退回 1/3
```

进展分三个来源：
1. **自动提取**：最近一次工具调用或输出的最后一行。来自 stream-json 事件，不额外消耗 token。
2. **agent 主动报告**：提示词里约定输出 `[[progress]] 一句话` 这种行，解析后写进卡片的「最近」一栏。
3. **发新消息提醒人**：只在三种情况下发，可以 @发起人：结果可用 / 需要决策 / 无法继续。其他进展只更新卡片，不刷屏。

### 3.2 一轮结束后自动推进

- 一轮跑完：解析输出 → 把结论写入「尝试」记录 → 状态机算出下一阶段 → **在同一个事务里**写入 `launch` 副作用记录 → 提交后由调度器启动下一个角色。
- 进程重启后，被中断的「尝试」带着恢复说明重新启动（见 001 §4.5），未执行的副作用记录照常执行。
- 单 agent 模式不经过状态机，一轮结束就是结束。

### 3.3 限制：CLI 运行中途无法插入消息

每轮都是一个 `codebuddy -p` 进程，不能在运行中往里塞新消息（dsh 可以，这里做不到）。任务运行期间收到的补充信息这样处理：
- **默认**：`attach` 把信息排到这个任务的队列里，下一次启动这个任务的任何角色时，放进提示词的「新增输入」一节。
- **紧急**：用户明确说「先停下改方向」，主 agent 输出 `attach {urgent:true}`。代码会停掉当前运行，带着这条消息**续接原会话**再跑一轮。被打断的那轮不计入退回次数。

### 3.4 超时按角色配置

适配器现在把超时写死了：cb 和 pi 硬超时 30 分钟、连续无输出 10 分钟超时；codex、claude、gemini 由 `AGENT_STALL_MS` 控制，默认 45 分钟。改成适配器参数，由角色配置传入：

| 角色 | 硬超时 | 无输出超时 |
|---|---|---|
| implementer | 90 分钟 | 15 分钟 |
| critic、tester | 30 分钟 | 10 分钟 |
| 主 agent | 3 分钟 | 1 分钟 |

超时视为「失败」：自动重试一次（续接原会话，附上「上次超时，请拆小步骤」），还失败就标记为 `blocked` 并提醒人。

## 4. 群公告即 agent 指令

### 4.1 为什么不落成工作区里的 agent.md 文件

实测本机 codebuddy 2.179.3：启动时会从 cwd 逐级向上加载 `CODEBUDDY.md` / `AGENTS.md`，同时支持 `--append-system-prompt` / `--system-prompt-file`。群级约束写成文件有三个问题：
- **多个群互相干扰**：`projects.json` 会把多个群路由到同一个仓库，A 群的约束会影响 B 群，还会出现在 git 改动里；
- **只对一家 CLI 有效**：codex 读 `AGENTS.md`，claude 读 `CLAUDE.md`，gemini 读 `GEMINI.md`，文件名各不相同；
- orc 的每个 worktree 都要放一份，而且不能提交。

所以分成两层：
- **仓库级规范**：继续用 `CODEBUDDY.md` / `AGENTS.md`，CLI 自动加载。
- **群级指令**：群公告每轮注入；`state/` 下只保存缓存和版本号，不给 agent 读。

### 4.2 读取并注入（每轮）

```
每轮运行前：docx.chatAnnouncement.get → revision_id
  未变化 → 用缓存
  有变化 → docx.chatAnnouncementBlock.list 取全部块 → 转成 markdown（≤ 4000 字，超出就截断并在卡片提示）→ 更新缓存
注入：cb、claude 用 --append-system-prompt；其他 CLI 放在提示词最前面
  格式：「【本群指令 · 来自群公告 rev N】…」
作用范围：单 agent、主 agent、orc 的所有 worker
```

**已实测**（2026-11-06，AGENT_2 的应用，群 `oc_cbced1cd…`，只读操作）：
- `docx.chatAnnouncement.get` 返回 `code=0`、`announcement_type=docx`、`revision_id=1`；
- `docx.chatAnnouncementBlock.list` 能读到块列表，空公告只有 1 个根块（block_type=1）；
- 旧版接口 `im.chatAnnouncement.get` 返回 `232097 Unable to operate docx type chat announcement`。所以**只用 docx 接口**，旧版公告的群暂时不支持。
- 当前应用的权限读取已经够用；写回还没验证。

**已实测**（cb 续接会话时，追加的系统提示是不是每轮生效）：
- 第 1 轮 `--append-system-prompt "最后一行 TOKEN=ZEBRA"`，第 2 轮 `-r <同一会话>`，追加的内容换成 `TOKEN=KOALA`。两轮的会话 id 相同，第 2 轮输出 `TOKEN=KOALA`。
- 说明公告修改后，**下一轮就能生效**，不会被锁在会话的第一条消息里。（第 2 轮的提示里写了「忽略之前的规则」，严格来说不是完全干净的对照；正式实现时再补一个不带这句的用例。）
- codex、claude 等其他 CLI 续接会话时的表现，留到小验证再测。

### 4.3 写回公告（没有 /rules 命令）

- 用户用自然语言修改约束（比如「以后结论先给中文摘要」）→ 主 agent 输出 `announce {patch}` → 卡片上展示改动，人确认后写入。
- **只改块，不整篇重写**：新增或修改纯文本块（文本、标题、列表、代码），其他块（图片、@人、表格、内嵌文档）原样保留。用 `chatAnnouncementBlockChildren.create` / `chatAnnouncementBlock.batchUpdate`，带上读取时的 `revision_id`。
- 版本号对不上（期间有人手动改过公告）→ 重新拉取、重新生成改动、再让人确认。不自动合并。
- **主 agent 改公告必须经过人确认**，worker 不能改公告。

### 4.4 风险

- **能编辑公告的人就能约束 agent**，相当于一个提示词注入入口。建议群设置成「仅群主/管理员可编辑公告」。bot 自己建的群，群主是 bot。
- 人写的普通通知（比如「周五发版」）也会变成约束。这是有意的，但要在 README 里写清楚。
- 公告转 markdown 会丢信息：表格、图片只保留一行占位说明。
- 待验证：写回需要哪些应用权限；bot 不是群主的老群能不能写；写回后人在客户端看到的效果。

## 5. 编排：预制组合 + 角色库，不现场生成

### 5.1 为什么不让模型现场生成角色

- 模型临时写的角色提示词往往空泛，没有经过验证；`/team` 已经需要兜底角色，产出的也多是泛泛的「视角」。
- 结构化输出约定、退回规则、只读权限这些必须事先测好，不能每次临时生成。
- 同一句话两次可能生成不同的流程，出了问题没法复现，也积累不了经验。

### 5.2 结构

```
orc/roles/<role>.md       人工维护的角色库：frontmatter（默认 cli/model/tools/permission/timeout/输出 schema）+ 提示词正文
orc/presets/<name>.yaml   预制组合：用到的角色及各自的数量、阶段顺序、通过条件、退回目标和上限、可选阶段
```

组合示例（`dev`）：

```yaml
name: dev
roles:
  planner:     { count: 1 }
  implementer: { count: 3, isolation: worktree }
  critic:      { count: 2, isolation: readonly, cli: codex }   # 刻意跟实现者用不同 CLI
  tester:      { count: 1, isolation: fresh }
stages:
  - { id: plan,   role: planner }
  - { id: impl,   role: implementer }
  - { id: review, role: critic,  pass: verdict == "approve", on_fail: impl, max_loops: 3 }
  - { id: test,   role: tester,  pass: pass == true,         on_fail: impl, max_loops: 2 }
optional: [design_review]   # 可以按群或按任务开启：impl 之前先让 critic 审一遍设计
```

首批组合：

| 组合 | 流程 | 适合 |
|---|---|---|
| `dev` | planner → implementer×3 ⇄ critic（换 CLI 或模型）→ tester | 开发新功能 |
| `fix` | reproducer（先写失败用例）→ implementer → tester（回归）→ critic | 修 bug |
| `review` | critic×2（不同模型各审一遍）→ synthesizer | 只审不改：PR、方案、论文 |
| `research` | researcher×N 并行 → critic → synthesizer | 调研、方案对比 |
| `discuss` | 多个视角轮流发言，有轮数上限，最后收口（即现在的 `/team`） | 开放讨论 |

角色提示词从 `/root/.codebuddy/agents/` 下的 `implementer.md`、`mighty.md`、`critic-manual.md` 改写。

v1 的流水线只支持**线性阶段 + 有上限的退回**，不支持任意 DAG。任务之间的依赖由 planner 拆任务时给出。

### 5.3 指令能调整的范围

主 agent 只能输出 `config {patch}`，修改范围限定在：
- 换组合；
- 从角色库里加入或去掉角色（`discuss` 之外不能新建角色）；
- 改某个角色的 `count` / `model` / `cli`；
- 开关组合里定义好的可选阶段；调整 `max_loops`。

这些修改都由**代码校验**：角色和 CLI 必须存在且可用、数量不超上限、模型在可选列表里、退回不能形成没有上限的循环。校验通过后，卡片展示改动，人确认才生效，`presetVersion` 加 1。

- **新配置只对之后的新任务生效**。进行中的任务一直用创建时的配置快照，避免中途改流程导致状态机出错。
- `discuss` 组合允许现场生成角色，沿用 `/team` 的做法，因为讨论出错的代价低。
- 某个临时调整被多次确认、效果也好，就由**人**整理成新的角色或组合，放进角色库。模型不会自动修改角色库。

## 6. 对 001 的修改汇总

| 001 原设计 | 改为 |
|---|---|
| §4.1 流水线写死在代码里 | 流水线由组合定义，代码负责执行；任务创建时保存配置快照 |
| §4.3 只有一个 `roles.yaml` | `orc/roles/*.md` 角色库 + `orc/presets/*.yaml` 组合 + 群级调整 |
| §4.4 共享三层 | 加一层「群公告」：每轮注入，不落成文件 |
| §4.6 只有 CLI 和 `/task` 入口 | 群 `mode` + 主 agent 判断意图 |
| §4.7 `/team` 与 orc 并存 | `/team` = `discuss` 组合 |
| 适配器硬超时 | 超时作为参数，由角色配置传入 |

## 7. 新增的小验证项（追加到 001 §5）

6. **公告写回**：在测试群里按块写入一段文本，确认需要的权限、版本号冲突时的报错，以及人在客户端看到的效果。
7. **其他 CLI 续接会话时，追加内容是否每轮生效**：claude 测 `--append-system-prompt`；codex、gemini 测放在提示词最前面的写法。
8. **主 agent 的意图识别**：拿 20 条真实的群消息，人工标注动作类型，看误判率。重点看 `reply` 和 `submit` 之间的混淆。
