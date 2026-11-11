// =============================================================================
// Message routing — single agent or the orc lead agent? (auto mode)
// =============================================================================
// Cheap, code-only first pass on every chat message (no LLM call, no latency):
//   - clear team signals / mode switches / talking about an existing task → lead
//   - everything else → the chat's single agent
// Both sides can hand over when the guess was wrong, so the rules only need to
// be right in the common case:
//   - lead → single: the `chat` action (plain Q&A, one-shot work)
//   - single → team: a `[[task]] {...}` line in its reply (formatTaskHint)
// Modes: auto (default, rules below) · single (only card threads and pending
// questions reach the lead) · orc (everything goes to the lead).
// The keyword lists are a reference, not the whole story — see ARCHITECTURE.md §6.1.
// =============================================================================
import type { TaskStatus } from "./types";

export type ChatMode = "auto" | "single" | "orc";
export const MODE_LABEL: Record<ChatMode, string> = { auto: "自动", single: "单 agent", orc: "编排" };

export interface RouteTask {
  id: number;
  title: string;
  status: TaskStatus;
  /** A supervisor-loop task waiting for the human's answer */
  asking?: boolean;
  updatedAt: number;
}
export interface RouteCtx {
  mode: ChatMode;
  /** Reply inside an orc task card's thread */
  inThread?: boolean;
  /** Message carries images / files (the lead can't see them; the single agent can) */
  hasAttachments?: boolean;
  /** This chat's recent tasks (open ones + failed / blocked in the last day) */
  tasks: RouteTask[];
  /** The lead proposed a config / announcement change that awaits 确认 / 算了 */
  pendingProposal?: boolean;
}
export interface Route { to: "single" | "lead"; why: string }

const OPEN: TaskStatus[] = ["queued", "running", "waiting", "waiting_children", "blocked"];
const RECENT_MS = 24 * 3600_000;
const SHORT = 40;

/** New work that should go to a team rather than one agent turn */
export const TEAM_PATTERNS: [RegExp, string][] = [
  [/交给团队|让团队|团队\s*[，,：:]?\s*(来|去|做|处理|跑|负责|干|搞|弄|帮|执行|完成|一起)|派(个|一个)?团队|组(个|一个)?团队/, "交给团队"],
  // 「启动团队，做一下…」「用团队查一下」「叫团队来」; not 「开团队会」「我们团队的论文」
  [/(启动|开启|拉起|召集|开|拉|叫|喊|用|找|上)(个|一个|起)?\s*(多\s*agent\s*)?团队(?!会|成员|的|里|内|名单|建设|周报|目标)/i, "交给团队"],
  [/多(个)?\s*(agent|智能体|模型)\s*(来|去|一起|协作|分工|配合)|多智能体|多\s*agent/i, "多 agent"],
  [/编排|监督循环|监督者|分工(合作|协作)?/, "编排 / 监督"],
  [/(开|建|起|提交)(个|一个)?(编排|后台|团队)?任务/, "开任务"],
  [/交叉(评审|审查|验证|review)|换(个|一个)?(别的)?模型(再)?(审|评审|复核|看看|review)|(两|几|多)个模型(分别|各自)?(审|评审|看)/i, "换模型评审"],
  [/(一直|反复|持续|循环|自动)(迭代|改|调|优化|试|修)[^。！？\n]{0,20}(直到|到)[^。！？\n]{0,15}(通过|全过|全绿|达标|收敛|满意|为止|低于|高于|小于|大于|超过|[<>≤≥])/, "迭代到达标"],
  [/直到[^。！？\n]{0,15}(全部)?(通过|全过|全绿|达标)为止|闭环(做|跑|迭代)|自动迭代|帮我盯着(做|改|调|跑)/, "迭代到达标"],
];

/** Switching the chat's mode in plain words */
export const MODE_PATTERN = /((切|换|改|调)(到|成|回)?|进入|回到|退出|打开|开启|关闭|关掉)[^。！？\n]{0,4}(单聊|单\s*agent|普通|编排|团队|orc|自动)模式|(编排|团队|orc)模式(关|退出|别用)/i;

/** Steering / asking about work that is already in progress */
export const STEER_PATTERN = new RegExp([
  "进展", "进度", "到哪(了|一步)", "怎么样了", "(做|跑|弄)完了(吗|没)", "完成了(吗|没)", "结果(呢|如何|怎么样)",
  "先别", "停(下|掉|一下)", "别(做|跑|弄)了", "放弃", "不要了", "继续", "再试", "重试", "再跑", "再来一次",
  "接受", "就用(这|现在|当前)(一)?版", "不用(再)?改了",
  "换成", "改用", "换(个|一个)?模型", "刷屏", "安静(点|些)?", "少发", "详细(点|些)", "多汇报",
  "推(吧|送)", "可以推", "发布", "补充(一下|一点|一条)?",
].join("|"));
const STEER_LEAD = /^(再试|重试|继续|放弃|停|先别|算了|不用了|别做了|接受|就用)/;

/** Bare yes / no to a pending proposal (words can be chained: 「好，就这么改」「算了，不改了」) */
const YES_NO = "好|好的|好啊|可以|行|没问题|确认|同意|就这么(改|办|定)吧?|改吧|ok|okay|yes|嗯|算了|不用了?|取消|不要了?|放弃|别改了?|先不改?|不改了";
export const CONFIRM_PATTERN = new RegExp(`^((${YES_NO})[\\s,，。.!！~～]*)+$`, "i");

const WATCH_TALK = /监控|(别|不要|不用|继续|接着)(再)?盯/;
const TASK_WORDS = /(这个|那个|刚才的?|上一个|之前的?)?(任务|团队|监督者|执行者|审查者|worker|supervisor|critic)/i;

function mentionsTask(text: string, tasks: RouteTask[]): RouteTask | undefined {
  for (const m of text.matchAll(/#\s?(\d+)|任务\s?#?(\d+)|(?<![\d.\w])(\d{1,5})\s?(?=号|那个|这个)|^(\d{1,5})(?=[\s,，的])/g)) {
    const id = Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
    const t = tasks.find((x) => x.id === id);
    if (t) return t;
  }
  // a 4+ char run of a task's title (e.g. 「调优训练超参」→「训练超参」)
  const t = text.replace(/\s+/g, "");
  return tasks.find((x) => {
    const title = x.title.replace(/\s+/g, "");
    for (let i = 0; i + 4 <= title.length; i++) if (t.includes(title.slice(i, i + 4))) return true;
    return false;
  });
}

export function routeMessage(text: string, c: RouteCtx): Route {
  const s = (text || "").trim();
  if (c.mode === "orc") return { to: "lead", why: "编排模式" };
  if (c.inThread) return { to: "lead", why: "任务卡片回复串" };
  const now = Date.now();
  const live = c.tasks.filter((t) => OPEN.includes(t.status) || ((t.status === "failed" || t.status === "blocked") && now - t.updatedAt < RECENT_MS));
  const asking = live.filter((t) => t.asking);
  const ref = mentionsTask(s, live);
  // things the human must answer reach the lead in every mode
  if (asking.length && (s.length <= SHORT || STEER_PATTERN.test(s) || ref || TASK_WORDS.test(s))) {
    return { to: "lead", why: `#${asking[0].id} 在等你回答` };
  }
  if (c.pendingProposal && CONFIRM_PATTERN.test(s)) return { to: "lead", why: "回应待确认的提议" };
  if (c.mode === "single") return { to: "single", why: "单 agent 模式" };

  if (MODE_PATTERN.test(s)) return { to: "lead", why: "切换模式" };
  if (c.hasAttachments) return { to: "single", why: "带附件" };
  for (const [re, why] of TEAM_PATTERNS) if (re.test(s)) return { to: "lead", why };
  // long-job monitors belong to the single agent (it registered them and has [[unwatch]])
  if (WATCH_TALK.test(s) && !ref && !TASK_WORDS.test(s)) return { to: "single", why: "说的是监控" };
  if (live.length) {
    if (ref) return { to: "lead", why: `提到 #${ref.id}` };
    if (STEER_LEAD.test(s) || (STEER_PATTERN.test(s) && (s.length <= SHORT || TASK_WORDS.test(s)))) {
      return { to: "lead", why: "调整进行中的任务" };
    }
  }
  return { to: "single", why: "普通对话" };
}

// ---- single agent → team -------------------------------------------------------

export interface TaskOp { goal?: string; preset?: string; criteria?: string[]; constraints?: string[]; error?: string }

/** Pull `[[task]] {...}` lines out of a single-agent reply */
export function extractTaskOps(text: string): { text: string; ops: TaskOp[] } {
  const ops: TaskOp[] = [];
  const keep: string[] = [];
  let fence = false;
  for (const line of (text || "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^[ \t>*-]*`?\[\[(task|团队|任务)\]\]\s*(.*?)`?\s*$/i.exec(line);
    if (!m) { keep.push(line); continue; }
    const body = m[2].trim();
    let o: any;
    try { o = body.startsWith("{") ? JSON.parse(body) : { goal: body }; }
    catch { ops.push({ error: "[[task]] 后面的 JSON 解析失败" }); continue; }
    const strs = (v: any) => (Array.isArray(v) ? v.map(String).map((x: string) => x.trim()).filter(Boolean).slice(0, 12) : undefined);
    const goal = typeof o.goal === "string" ? o.goal.trim() : "";
    ops.push(goal
      ? { goal, preset: typeof o.preset === "string" && o.preset.trim() ? o.preset.trim() : undefined, criteria: strs(o.criteria), constraints: strs(o.constraints) }
      : { error: "[[task]] 缺少 goal" });
  }
  return { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), ops: ops.slice(0, 3) };
}

/** System-prompt hint for the single agent: when and how to hand work to a team */
export function formatTaskHint(): string {
  return [
    "【交给多 agent 团队】",
    "这些情况不要自己做，交给团队：用户明确要求交给团队 / 多 agent；需要反复迭代直到满足可检查的验收标准（测试全过、指标达标等），一轮做不完；需要换别的模型交叉评审；需要长时间实验并根据结果调整方向。",
    "做法：回复里**单独占一行**写（这一行不会显示给人，代码会提交任务并在群里发进展卡片）：",
    '[[task]] {"goal":"完整、可独立理解的目标（把对话里的上下文、已有结论写进去）","preset":"loop","criteria":["可检查的验收标准"],"constraints":["必须遵守的约束"]}',
    "preset：loop（反复试错 / 长实验，目标可能随讨论调整，默认）、dev（新功能：规划→实现→评审→测试）、fix（修 bug：复现→修复→回归→评审）、research（调研对比）、review（只审不改）。然后用一句话告诉用户已转交团队。",
    "用户提到「团队」（启动 / 用 / 交给团队等）时，指的就是这个 [[task]]：直接写这一行，不要自己动手做，也不要用你自带的子 agent、Task 工具或待办列表来代替。",
    "一轮能做完的事自己做，不要转交；只是后台跑个训练等结果，用 [[watch]] 即可。团队需要当前工作区是 git 仓库。",
  ].join("\n");
}
