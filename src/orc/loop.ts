// =============================================================================
// orc loop — Supervisor ReAct loop engine (docs/orc architecture page §监督循环)
// =============================================================================
// One durable `loop` effect = one round:
//   observe (ledger + last results) → Supervisor proposes ONE action (fresh,
//   read-only session) → code validates (ledger.ts guards) → execute (worker /
//   verify / review / watch / IM) → write results back → enqueue next round.
// Rounds of one task never overlap; a crash re-runs the round (recover=true).
// Long external jobs park the task on a watch (zero-token probes) instead of
// keeping any agent alive. Humans steer at any time through the lead agent:
// messages land in the ledger inbox, answer open questions, or interrupt.
// =============================================================================
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { addWatch, cancelWatch, checkWatch, describeSpec, getWatch, parseDuration, parseWatchNote, parseWatchSpec, setWatchNote, PATROL, type CheckResult, type Watch } from "../watch";

/** While parked on a watch the supervisor patrols this often by default (min 10m) */
const DEFAULT_HEARTBEAT_S = 30 * 60;
/** 要人拍板的指令：附全文的上限（平台会按 4000 字分段），超过就截断并注明 */
const ASK_DETAIL_MAX = 12000;
/** 对不可逆确认的拒绝（开头就是否定）；「不是，继续」= 误报放行，不算拒绝 */
const REFUSAL = /^\s*(不要|不做|不行|不用|不同意|不可以|不允许|别|算了|停|取消|拒绝|先别|no\b|don'?t\b)/i;
import * as L from "./ledger";
import { parseRoleOutput } from "./output";
import { CONTRACT } from "./prompts";
import type { Executor, RunResult } from "./runner";
import type { OrcStore } from "./store";
import type { CliName, Effect, LoopPayload, NotifyPayload, ResolvedRole, Task, TaskStatus, Verbosity } from "./types";
import * as wt from "./gitops";

export interface LoopOptions {
  orcHome: string;
  prepareWorkspace: (task: Task) => Task;
  instructionsFor?: (task: Task) => Promise<string | undefined>;
  onProgress?: (task: Task) => void;
  /** bot whose watch host serves this task's chat (undefined → wait unavailable) */
  watchBot?: (task: Task) => string | undefined;
  /** a watch was registered for a loop task (post its card) */
  onWatchCreated?: (task: Task, w: Watch) => void;
  /** watch note / card body changed — refresh the existing IM card */
  onWatchNote?: (task: Task, w: Watch) => void;
  /** an agent run inside round n started / progressed / ended (per-round thread card, agent-cards.ts) */
  onRun?: (task: Task, ev: LoopRunEvent) => void;
  /** max loop tasks running a round at the same time */
  concurrency?: number;
  /** how long a verify command may run */
  verifyTimeoutMs?: number;
  /** the task reached ready / failed (finish / abort): clean up what it left running */
  onEnded?: (taskId: number) => void;
}

export interface LoopRunEvent {
  taskId: number;
  n: number;
  phase: "start" | "progress" | "end";
  label: string;
  model: string;
  line?: string;
  tokens?: number;
  error?: string;
  /** wall time of this round, so the human can see which ones dragged */
  durationMs?: number;
}

const FINAL: TaskStatus[] = ["ready", "failed", "dropped"];

/**
 * A task freezes its roles at submit time. If the CLI a role was pinned to is no
 * longer configured (bot migrated to another CLI, key removed, binary gone),
 * re-bind those roles to the first available CLI before a retry/answer — otherwise
 * every retry fails on an adapter that cannot run and the task is stuck forever.
 * Sessions belong to the old CLI, so they are dropped (worker starts fresh).
 * Returns the change lines, empty when nothing had to move.
 */
export function rebindUnavailableRoles(store: OrcStore, task: Task, available: CliName[], prefer?: CliName): string[] {
  if (!available.length) return [];
  // The orc engine is a singleton shared by every bot, so the executor's list
  // order says nothing about which bot serves this chat — callers pass `prefer`.
  const to = prefer && available.includes(prefer) ? prefer : available[0];
  const preset = structuredClone(task.preset);
  const lines: string[] = [];
  for (const [name, role] of Object.entries(preset.roles)) {
    if (available.includes(role.cli)) continue;
    lines.push(`${name}：${role.cli}${role.model ? ":" + role.model : ""} → ${to}`);
    role.cli = to;
    delete role.model; // model ids are per-CLI; dsh/cursor pick their own
  }
  if (!lines.length) return [];
  store.updateTask(task.id, { preset });
  const l = store.getLedger<L.Ledger>(task.id);
  if (l) {
    if (l.worker?.sessionId) {
      l.worker.sessionId = undefined;
      l.worker.turns = 0;
      l.worker.rotations++;
    }
    if (l.sup?.sessionId) l.sup.sessionId = undefined;
    l.workerEpoch = (l.workerEpoch ?? 0) + 1;
    L.observe(l, l.step, "system", `原 CLI 不可用，角色已改到 ${to}：${lines.join("；")}`);
    store.saveLedger(task.id, l);
  }
  task.preset = preset;
  return lines;
}
const DONE_KINDS = ["done", "metrics", "file", "cmd"];
const clip = L.clip;
const shortStat = (stat: string) => stat.trim().split("\n").pop()?.trim() ?? "";
const fmtWhen = (t: number) => new Date(t).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

interface Running { key: string; cli: CliName; interrupted: boolean; cancelled: boolean }

interface Outcome {
  status?: TaskStatus;
  progress: string;
  obs: string;
  notifies: NotifyPayload[];
  next?: { reason: string; delayMs?: number; ref?: number }[];
  /** text for the round's thread post */
  turn: string;
  stopped?: boolean;
}

/** Run a read-only check command in the workspace */
function sh(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise((res) => {
    const child = spawn("bash", ["-c", cmd], { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "";
    let timedOut = false;
    const add = (b: Buffer) => { out += b.toString(); if (out.length > 64_000) out = out.slice(-32_000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const t = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} } }, timeoutMs);
    child.on("close", (code) => { clearTimeout(t); res({ code, out: out.trim(), timedOut }); });
    child.on("error", (e) => { clearTimeout(t); res({ code: null, out: e.message, timedOut }); });
  });
}

export class LoopEngine {
  private busy = new Set<number>();
  private running = new Map<number, Running>();
  private readonly concurrency: number;
  private readonly verifyTimeoutMs: number;

  constructor(private store: OrcStore, private exec: Executor, private opts: LoopOptions) {
    this.concurrency = opts.concurrency ?? Number(process.env.ORC_LOOP_CONCURRENCY || 3);

    this.verifyTimeoutMs = opts.verifyTimeoutMs ?? 10 * 60_000;
  }

  // ---- lifecycle ----------------------------------------------------------

  /** Create the ledger for a new loop task (inside the submit transaction) and queue round 1 */
  init(task: Task, input: { criteria?: string[]; constraints?: string[]; sourceText?: string }): void {
    const loop = task.preset.loop!;
    const l = L.createLedger({
      goal: task.goal, criteria: input.criteria, constraints: input.constraints, sourceText: input.sourceText,
      head: task.baseRef, limits: loop.budget, verbosity: loop.verbosity,
    });
    this.store.saveLedger(task.id, l);
    this.store.addEffect("loop", { taskId: task.id, reason: "start" } satisfies LoopPayload);
  }

  ledger(taskId: number): L.Ledger | undefined {
    const l = this.store.getLedger<L.Ledger>(taskId);
    return l ? L.ensureLedgerShape(l) : undefined;
  }

  isBusy(taskId: number): boolean {
    return this.busy.has(taskId);
  }

  /** Called by the scheduler tick for a due `loop` effect; returns the in-flight round, if started */
  handle(e: Effect): Promise<void> | undefined {
    const p = e.payload as LoopPayload;
    const task = this.store.getTask(p.taskId);
    const skip = (why: string) => { this.store.markEffect(e.id, "done", { error: `skipped: ${why}` }); return undefined; };
    if (!task || task.kind !== "loop") return skip("not a loop task");
    if (FINAL.includes(task.status)) return skip(task.status);
    const l = this.ledger(task.id);
    if (!l) return skip("no ledger");
    // a blocked task waits for a human: only their answer / retry wakes it, nothing times out
    if (task.status === "blocked" && !["human", "resume", "retry"].includes(p.reason)) return skip("blocked");
    // waiting 但没有 waitWatch = 坏停车（例如 keep 写出 #undefined）；放行以便本轮自愈，不要永久 skip
    if (task.status === "waiting" && l.waitWatch != null && !["watch", "heartbeat", "human", "resume", "retry"].includes(p.reason)) {
      return skip("waiting");
    }
    if (p.reason === "heartbeat" && (task.status !== "waiting" || l.waitWatch !== p.ref)) return skip("stale heartbeat");
    if (this.busy.has(task.id)) { this.store.markEffect(e.id, "pending", { nextAt: Date.now() + 2000 }); return undefined; }
    if (this.busy.size >= this.concurrency) { this.store.markEffect(e.id, "pending", { nextAt: Date.now() + 3000 }); return undefined; }
    this.busy.add(task.id);
    this.store.markEffect(e.id, "running");
    return this.round(task, p)
      .catch((err) => this.infraFail(task.id, err))
      .finally(() => { this.busy.delete(task.id); this.store.markEffect(e.id, "done"); });
  }

  // ---- human steering -----------------------------------------------------

  /** A human message for the task: answers an open question, or lands in the inbox (urgent = interrupt the worker) */
  attach(taskId: number, text: string, urgent = false, raw?: string, prefer?: CliName): boolean {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop" || FINAL.includes(task.status)) return false;
    const l = this.ledger(taskId)!;
    if (task.status === "blocked" && l.pendingAsk) { this.answer(taskId, undefined, text, raw, prefer); return true; }
    L.noteHuman(l, raw || text);
    l.inbox.push({ at: Date.now(), text: withRaw(text, raw) });
    this.store.tx(() => {
      this.store.saveLedger(taskId, l);
      if (task.status === "blocked") this.store.updateTask(taskId, { status: "running", progress: "人补充了信息，继续" });
      if (!this.busy.has(taskId)) this.enqueue(taskId, "human");
    });
    const h = this.running.get(taskId);
    if (urgent && h) { h.interrupted = true; this.exec.stop(h.key, h.cli); }
    this.emit(taskId);
    return true;
  }

  /** 回答监督者的问题：人直接说，不用选项（只有预算确认还认「继续/停」） */
  answer(taskId: number, option?: string, text?: string, raw?: string, prefer?: CliName): string {
    const task = this.store.getTask(taskId);
    const name = task?.title ?? "这个任务";
    if (!task || task.kind !== "loop") return `「${name}」不是监督循环任务`;
    // 「继续」/回答也可能把停住的任务带回来：先确认角色 CLI 还在
    rebindUnavailableRoles(this.store, task, this.exec.available(), prefer);
    const l = this.ledger(taskId)!;
    const ask = l.pendingAsk;
    if (task.status !== "blocked" || !ask) return `「${name}」现在没有待回答的问题`;
    const said = (raw || text || "").trim();
    if (ask.code === "budget") {
      const stop = option === "stop" || /^(停|停吧|停了|不继续|算了|stop)$/i.test(said);
      if (stop) {
        const r = this.resolveAsk(task, l, said || "停", "stop");
        this.commit(task, l, { status: r.status, progress: r.progress, notifies: r.notifies, next: [] });
        return `🛑 「${name}」已停下，分支和进展都保留`;
      }
      const r = this.resolveAsk(task, l, said || "继续", "more");
      this.commit(task, l, { status: r.status, progress: r.progress, notifies: r.notifies, next: [{ reason: "human" }] });
      return `✅ 「${name}」预算已追加，继续推进`;
    }
    if (!said) return "直接说你的想法就行（不用选项）";
    L.noteHuman(l, said);
    const r = this.resolveAsk(task, l, said);
    this.commit(task, l, { status: r.status, progress: r.progress, notifies: r.notifies, next: r.status === "running" ? [{ reason: "human" }] : [] });
    return `✅ 「${name}」收到你的回复，继续推进`;
  }

  /** Human retry of a blocked / failed / dropped loop task */
  resume(taskId: number, note?: string, prefer?: CliName): boolean {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop" || !["blocked", "failed", "dropped"].includes(task.status)) return false;
    rebindUnavailableRoles(this.store, task, this.exec.available(), prefer);
    const l = this.ledger(taskId)!;
    if (task.status === "blocked" && l.pendingAsk) { this.answer(taskId, l.pendingAsk.code === "budget" ? "more" : undefined, note || "继续", undefined, prefer); return true; }
    L.resetGuards(l);
    if (L.budgetState(l).exhausted) L.extendBudget(l);
    l.pendingAsk = undefined;
    if (note) L.noteHuman(l, note);
    L.observe(l, l.step + 1, "human", `人工重试${note ? "：" + note : ""}`);
    // commit() ignores dropped tasks (a late run must not revive a stopped one): lift it first, or retry is a silent no-op
    if (task.status === "dropped") this.store.updateTask(taskId, { status: "running" });
    this.commit(task, l, { status: "running", progress: "人工重试", next: [{ reason: "resume" }] });
    return true;
  }

  /**
   * 老版本把"监督者没给出动作"挂成要人回答的问题（`pendingAsk.code = "invalid"`）。
   * 这种问题不该问人：启动时清掉、重置守卫、接着跑。
   */
  clearLegacyFormatAsks(): number {
    let n = 0;
    for (const t of this.store.listTasks({ status: ["blocked"], limit: 500 })) {
      if (t.kind !== "loop") continue;
      const l = this.ledger(t.id);
      if (!l?.pendingAsk) continue;
      if ((l.pendingAsk as { code?: string }).code !== "invalid") continue;
      L.resetGuards(l);
      l.pendingAsk = undefined;
      L.observe(l, l.step + 1, "system", "「监督者没给出动作」这类问题不再问人，直接接着跑。");
      this.commit(t, l, { status: "running", progress: "旧版遗留的格式问题已自动放行，接着跑", next: [{ reason: "retry" }] });
      n++;
    }
    return n;
  }

  /** Kill whatever runs for the task and cancel its watch (status is set by the caller) */
  stop(taskId: number): void {
    const h = this.running.get(taskId);
    if (h) { h.cancelled = true; this.exec.stop(h.key, h.cli); }
    const l = this.ledger(taskId);
    if (l?.waitWatch) { cancelWatch(l.waitWatch); l.waitWatch = undefined; this.store.saveLedger(taskId, l); }
  }

  /** Switch a running task's roles (CLI / model); the worker starts a fresh session next instruct */
  setRoles(taskId: number, edits: Record<string, { cli?: CliName; model?: string | null } | null>, available?: string[]): string {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop" || FINAL.includes(task.status)) throw new Error(`「${task?.title ?? "这个任务"}」不是进行中的监督循环任务`);
    const preset = structuredClone(task.preset);
    const lines: string[] = [];
    let workerChanged = false;
    for (const [name, e] of Object.entries(edits)) {
      const role = preset.roles[name];
      if (!role || !e) throw new Error(`「${task.title}」没有角色 "${name}"（有：${Object.keys(preset.roles).join(", ")}）`);
      const before = `${role.cli}${role.model ? ":" + role.model : ""}`;
      if (e.cli) {
        if (available && !available.includes(e.cli)) throw new Error(`cli "${e.cli}" 没有配置`);
        if (e.cli !== role.cli && e.model === undefined) role.model = undefined;
        role.cli = e.cli;
      }
      if (e.model !== undefined) role.model = e.model || undefined;
      const after = `${role.cli}${role.model ? ":" + role.model : ""}`;
      if (before !== after) {
        lines.push(`${name}：${before} → ${after}`);
        if (name === preset.loop!.worker) workerChanged = true;
      }
    }
    if (!lines.length) return "没有变化";
    const l = this.ledger(taskId)!;
    if (workerChanged) l.workerEpoch++;
    l.events.push({ at: Date.now(), kind: "note", text: `人调整了角色：${lines.join("；")}（下一次运行起生效${workerChanged ? "；worker 开新会话，带交接摘要" : ""}）` });
    this.store.tx(() => {
      this.store.updateTask(taskId, { preset });
      this.store.saveLedger(taskId, l);
    });
    this.emit(taskId);
    return lines.join("；");
  }

  setVerbosity(taskId: number, v: Verbosity): boolean {
    const l = this.ledger(taskId);
    if (!l) return false;
    l.verbosity = v;
    this.store.saveLedger(taskId, l);
    return true;
  }

  /** A watch registered by this task fired (routed here by the chat host) */
  onWatchFired(taskId: number, w: Watch, r: CheckResult): void {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop" || FINAL.includes(task.status)) return;
    const l = this.ledger(taskId)!;
    l.events.push({
      at: Date.now(), kind: "watch", watchId: w.id, title: w.spec.title, fireKind: r.fire?.kind ?? "timeout",
      reason: r.fire?.reason ?? w.fired?.reason ?? "", evidence: r.evidence,
    });
    // mid-round: the round's next commit drains it; otherwise drain (and wake) now
    if (this.busy.has(taskId)) this.store.saveLedger(taskId, l);
    else this.commit(task, l, {});
  }

  // ---- one round ----------------------------------------------------------

  private async round(task0: Task, p: LoopPayload): Promise<void> {
    const t0 = Date.now();
    const task = this.opts.prepareWorkspace(task0);
    const wtp = task.workspace!;
    const loop = task.preset.loop!;
    const l = this.ledger(task.id)!;
    const n = l.step + 1;
    const notifies: NotifyPayload[] = [];

    // the code may have moved under us (crash leftovers, a human commit)
    if (wt.isDirty(wtp)) {
      const sha = wt.commitAll(wtp, `orc(#${task.id}) loop ${n}: leftovers`);
      if (sha) { L.codeChanged(l, sha); L.observe(l, n, "system", "发现上一轮中断时留下的未提交改动，已提交。"); }
    }
    const head = wt.headSha(wtp);
    if (head !== l.head) { L.codeChanged(l, head); L.observe(l, n, "system", `检测到工作区有新提交 ${head.slice(0, 7)}。`); }
    if (p.recover) L.observe(l, n, "system", "进程重启，上一轮被中断；在重复任何对外操作前先核实现状。");

    const b = L.budgetState(l);
    if (b.exhausted) {
      l.pendingAsk = L.budgetAsk(l, b.exhausted);
      this.commit(task, l, { status: "blocked", progress: `预算用完：${b.exhausted}`, notifies: [...notifies, this.askNotify(task, l.pendingAsk)] });
      return;
    }
    if (b.ratio >= 0.8 && !l.budget.warned) {
      l.budget.warned = true;
      notifies.push({ taskId: task.id, kind: "info", text: `预算已用 80% 以上（${b.line}）。需要的话直接说“追加预算”。` });
    }

    this.commit(task, l, { status: task.status === "waiting" ? "waiting" : "running", progress: `第 ${n} 轮 · 监督者思考中`, consumeInbox: true, noWake: true });
    // still parked on a watch? (it may have fired just now — then it's already in the observations)
    const wasWaiting = !!l.waitWatch;

    // ---- 监督者：一个长会话，接着上一轮想 ----
    const sup = task.preset.roles[loop.supervisor];
    const worker = task.preset.roles[loop.worker];
    const reviewer = loop.reviewer ? task.preset.roles[loop.reviewer] : undefined;
    const canWait = !!(task.chatId && this.opts.watchBot?.(task));
    const waitW = wasWaiting && l.waitWatch ? getWatch(l.waitWatch) : undefined;
    // a fresh look at the job (read-only probe), so a patrol round sees the log / metrics, not just "进程运行中"
    const snap = waitW ? await checkWatch(waitW).catch(() => undefined) : undefined;
    const waiting = waitW
      ? `监控 #${waitW.id} ${waitW.spec.title}（${describeSpec(waitW.spec)}）；已运行 ${Math.round((Date.now() - waitW.createdAt) / 60_000)} 分钟；最新：${snap?.summary ?? waitW.summary}${snap?.evidence ? `\n${clip(snap.evidence, 2500)}` : ""}`
      : undefined;
    const reasonText = ({
      start: "任务刚开始", next: "上一个动作已完成", human: "人发来了消息", watch: "等待的监控触发了",
      heartbeat: `定时巡检（作业还在跑）。${PATROL}正常就：单独一行写 [[wait]]，下一行 keep=1，再一行 reason=阶段/步数/收益%/笔数/判断（reason 会写到群里监控卡片；[[wait]] 必须独占一行否则解析失败会停心跳）。`,
      resume: "人要求继续 / 重试", retry: "上一轮出错后重试",
    } as Record<string, string>)[p.reason] ?? p.reason;
    // 首轮或会话用满就重建上下文；其余轮次续接同一个监督者会话（它有前几轮的记忆）。
    // 上限跟任务预算同一个寿命（默认 maxSteps=500 轮）：预算用完本来就要停下来问人，
    // 所以在预算之内不再另设一个轮数；ORC_LOOP_SUP_TURNS 可以单独收紧（0 = 不限）。
    const supTurns = Number(process.env.ORC_LOOP_SUP_TURNS || 0) || l.limits.maxSteps;
    const fresh = !l.sup.sessionId || l.sup.turns >= supTurns;
    const prompt = L.buildSupervisorPrompt(l, {
      taskId: task.id, title: task.title, workspace: wtp, branch: task.branch ?? "", diffStat: wt.diffSince(wtp, task.baseRef, 0).stat,
      worker: roleName(worker), reviewer: reviewer ? roleName(reviewer) : undefined, reason: reasonText, waiting, canWait, fresh,
    });
    // Snapshot before supervisor: if WIP already exists (or appears from a concurrent
    // writer), enforceReadonly will commit it — never resetHard over worker edits.
    const beforeSup = wt.statusPorcelain(wtp);
    const res = await this.run(task, sup, prompt, {
      key: `orc-loop:${task.id}#supervisor`, readOnly: true, n, label: "监督者",
      resumeSessionId: fresh ? undefined : l.sup.sessionId,
    });
    if (res.cancelled || this.dropped(task.id)) return;
    l.budget.steps++;
    l.budget.tokens += res.tokens;
    {
      const r0 = wt.enforceReadonly(wtp, beforeSup, `orc(#${task.id}) loop ${n}: preserve WIP during supervisor`);
      if (r0.note) {
        if (r0.sha) L.codeChanged(l, r0.sha);
        L.observe(l, n, "system", clip(r0.note, 500));
      }
    }

    // 这一轮根本没跑成（CLI 报错 / 超时 / 空回复）：算运行故障重试，不找人
    if (res.error || res.timedOut) { this.roundFailed(task, l, n, p.reason, res, t0); return; }

    l.sup = { sessionId: res.sessionId ?? (fresh ? undefined : l.sup.sessionId), turns: fresh ? 1 : l.sup.turns + 1 };
    l.guard.infraErrors = 0;
    l.budget.activeMs += Date.now() - t0;
    const markers = L.listActionMarkers(res.text);
    const parsed = L.parseSignalDetailed(res.text);
    const a = parsed.action;

    // 同一轮多个标记：仍拒绝没有 instruct 的组合；只有一个 instruct + 取证/等待时先派工
    if (markers.length > 1 && !a) {
      const names = markers.join("+");
      L.observe(l, n, "system", `本轮写了 ${markers.length} 个标记（${names}），协议只允许一个，已全部忽略。下一轮只留一个：要派工只写 [[instruct]]，取证留到下一轮再 [[verify]]。不要据此认定「平台未派工」。`);
      l.step = n;
      this.store.addStep({ taskId: task.id, n, reason: p.reason, action: null, accepted: false, verdict: `多标记忽略：${names}`, observation: "", raw: res.text, tokens: res.tokens, startedAt: t0 });
      this.commit(task, l, { status: wasWaiting ? "waiting" : "running", progress: `第 ${n} 轮 · 多标记已忽略，请只留一个`, notifies, next: [{ reason: "next" }] });
      return;
    }
    if (parsed.ignored?.length) {
      L.observe(l, n, "system", `本轮同时写了 ${markers.join("+")}；已先执行 [[instruct]] 派工，${parsed.ignored.map((x) => `[[${x}]]`).join("、")} 下一轮再单独写（等 worker 回报后再取证/等待）。`);
    }

    // 没有可执行动作：说清楚原因；连续多轮强制换做法，不再静默重问
    if (!a) {
      const problem = parsed.problem;
      l.guard.noAction = (l.guard.noAction ?? 0) + 1;
      const count = l.guard.noAction;
      const nudge = count === 1
        ? `本轮没有可执行动作：${problem ?? "没有写任何动作标记"}。下一轮只写一个能执行的标记（instruct / verify / wait / finish / abort）。`
        : count === 2
          ? `连续 2 轮没有可执行动作：${problem ?? "没有写任何动作标记"}。下一轮必须从 instruct / verify / wait / finish / abort 里选一个；目标已完成就 finish，卡住就 abort 并写原因，不要再只写分析。`
          : `连续 ${count} 轮没有可执行动作，已换新会话重新判断。`;
      if (!problem) L.observe(l, n, "thought", clip(stripSignals(res.text), 1500) || nudge);
      L.observe(l, n, "system", nudge);
      if (count >= 3) {
        l.sup = { sessionId: undefined, turns: 0 };
        l.guard.noAction = 0;
      }
      l.step = n;
      this.store.addStep({ taskId: task.id, n, reason: p.reason, action: null, accepted: !problem, verdict: problem ? `没有动作：${clip(problem, 120)}` : "没有动作，继续", observation: "", raw: res.text, tokens: res.tokens, startedAt: t0 });
      // 仍挂在监控上时绝不能只排 next——waiting 会 skip next，心跳就此断档（卡片停更）
      const next = wasWaiting && l.waitWatch && l.heartbeatS
        ? [{ reason: "heartbeat", delayMs: l.heartbeatS * 1000, ref: l.waitWatch }]
        : [{ reason: "next" }];
      this.commit(task, l, { status: wasWaiting ? "waiting" : "running", progress: `第 ${n} 轮 · 没有可执行动作（${count}/3）`, notifies, next });
      return;
    }
    l.guard.noAction = 0;

    // 监督者因"自己写不进去"想放弃：它本来就只读，写活该交给 worker。驳回并提醒，连续超过上限才放行
    if (a.action === "abort" && L.readonlyAbort(a.reason) && (l.guard.readonlyAborts ?? 0) < L.MAX_READONLY_ABORTS) {
      l.guard.readonlyAborts = (l.guard.readonlyAborts ?? 0) + 1;
      L.observe(l, n, "system", L.READONLY_ABORT_NOTE);
      l.step = n;
      // 续接的会话会带着"我写不进去"的思路，换新会话让它按提醒重新判断
      l.sup = { sessionId: undefined, turns: 0 };
      this.store.addStep({ taskId: task.id, n, reason: p.reason, action: a, accepted: false, verdict: `只读放弃已驳回（${l.guard.readonlyAborts}/${L.MAX_READONLY_ABORTS}）：写操作应交给 worker`, observation: "", raw: res.text, tokens: res.tokens, startedAt: t0 });
      const next = wasWaiting && l.waitWatch && l.heartbeatS
        ? [{ reason: "heartbeat", delayMs: l.heartbeatS * 1000, ref: l.waitWatch }]
        : [{ reason: "next" }];
      this.commit(task, l, { status: wasWaiting ? "waiting" : "running", progress: `第 ${n} 轮 · 监督者因只读想放弃，已驳回，改派 worker`, notifies, next });
      return;
    }
    if (a.action !== "abort") l.guard.readonlyAborts = 0;

    // 巡检正常（keep）不消耗这一轮
    if (a.action === "wait" && a.keep) l.budget.steps--;

    // 除了"继续等"以外，任何动作都结束这次等待
    if (wasWaiting && l.waitWatch && !(a.action === "wait" && a.keep)) {
      cancelWatch(l.waitWatch);
      L.observe(l, n, "system", `不再等待监控 #${l.waitWatch}。`);
      l.waitWatch = undefined;
      l.heartbeatS = undefined;
    }

    l.step = n;
    let out: Outcome;
    try {
      out = await this.execute(task, l, a, n, { worker, reviewer });
    } catch (err) {
      const msg = (err as Error).message;
      out = { progress: `第 ${n} 轮执行出错`, obs: `执行 ${a.action} 出错：${msg}`, notifies: [], next: [{ reason: "next" }], turn: `执行出错：${clip(msg, 300)}` };
    }
    if (out.stopped || this.dropped(task.id)) return;
    if (out.obs) L.observe(l, n, a.action, out.obs);

    const status = out.status ?? "running";
    const next = out.next ?? [];
    this.store.addStep({ taskId: task.id, n, reason: p.reason, action: a, accepted: true, verdict: "", observation: out.obs, raw: res.text, tokens: res.tokens, startedAt: t0 });
    const turn: NotifyPayload[] = [];
    if (l.verbosity !== "quiet" && out.turn) {
      const think = l.verbosity === "verbose" ? stripSignals(res.text) : "";
      turn.push({ taskId: task.id, kind: "turn", round: n, text: `**第 ${n} 轮 · ${L.ACTION_LABEL[a.action]}**\n${out.turn}${think ? `\n\n> 监督者的判断：${clip(think, 1200).replace(/\n/g, "\n> ")}` : ""}` });
    }
    this.commit(task, l, { status, progress: out.progress, notifies: [...notifies, ...turn, ...out.notifies], next, wakeIfInbox: status !== "blocked" });
  }

  // ---- actions ------------------------------------------------------------

  private async execute(task: Task, l: L.Ledger, a: L.LoopAction, n: number, r: { worker: ResolvedRole; reviewer?: ResolvedRole }): Promise<Outcome> {
    const wtp = task.workspace!;
    const id = task.id;
    switch (a.action) {
      case "instruct": {
        const hit = L.irreversibleHit(a.text);
        const approval = l.approvals.find((x) => !x.used);
        if (hit && !approval) {
          l.pendingAsk = {
            step: n,
            question: [
              `团队下一步要**${hit.label}**，这一步做了收不回，所以先停下来等你确认。`,
              ``,
              `是这一句：`,
              `> ${hit.excerpt}`,
              ``,
              `怎么回：`,
              `- 同意：回「可以」，只放行这一次`,
              `- 不同意：回「不要」，顺便说改成怎么做`,
              `- 误会了，这句不是这个意思：回「不是，继续」`,
            ].join("\n"),
            // 指令比引用的那句长出不少时才附全文（短指令附了就是重复）；只给人看，不进 prompt
            detail: a.text.length <= hit.excerpt.length + 40 ? undefined
              : a.text.length > ASK_DETAIL_MAX ? `${a.text.slice(0, ASK_DETAIL_MAX)}\n\n…（后面还有 ${a.text.length - ASK_DETAIL_MAX} 字没贴）`
              : a.text,
            why: "irreversible", code: "guard", askedAt: Date.now(),
          };
          return {
            status: "blocked", progress: `等你确认：${hit.label}`, obs: `指令里有「${hit.phrase}」，按不可逆操作（${hit.label}）先停下等确认；确认后下一轮放行一次`,
            notifies: [this.askNotify(task, l.pendingAsk)], next: [], turn: "",
          };
        }
        if (approval) approval.used = true;
        const fresh = !l.worker.sessionId || l.worker.turns >= L.MAX_WORKER_TURNS || l.worker.epoch !== l.workerEpoch;
        if (fresh && l.worker.sessionId) l.worker.rotations++;
        const prompt = L.buildWorkerPrompt(l, a.text, { taskId: id, fresh, rolePrompt: r.worker.prompt, branch: task.branch ?? "" });
        const prev = l.head;
        const res = await this.run(task, r.worker, prompt, { key: `orc-loop:${id}#worker`, readOnly: false, resumeSessionId: fresh ? undefined : l.worker.sessionId, n, label: "worker" });
        if (res.cancelled) return { progress: "", obs: "", notifies: [], turn: "", stopped: true };
        l.budget.workerRuns++;
        l.budget.tokens += res.tokens;
        const sha = wt.commitAll(wtp, `orc(#${id}) loop ${n}: worker`);
        if (sha) L.codeChanged(l, sha);
        const stat = sha ? shortStat(wt.diffSince(wtp, prev, 0).stat) : "";
        l.worker = { ...l.worker, sessionId: res.sessionId ?? (fresh ? undefined : l.worker.sessionId), turns: fresh ? 1 : l.worker.turns + 1, epoch: l.workerEpoch };
        const p = parseRoleOutput("impl", res.text);
        const ok = !("error" in p);
        const summary = ok ? p.summary : clip(res.text.trim().slice(-1500), 1500) || "(无输出)";
        const status = ok ? (p.pass ? "done" : "blocked") : "未按约定给结论";
        const head = res.interrupted ? "worker 被人打断（到目前为止的改动已提交）" : res.timedOut ? `worker 超时（${r.worker.hardTimeoutMin} 分钟内没完成；已提交部分改动）` : res.error ? `worker 运行出错：${clip(res.error, 300)}` : `worker 回报（${status}）`;
        const notes = ok && p.notes.length ? `\n笔记：${p.notes.map((x) => "- " + x).join("\n")}` : "";
        return {
          progress: `第 ${n} 轮 · worker：${clip(summary.replace(/\n+/g, " "), 80)}`,
          obs: `指令：${clip(a.text, 400)}\n${head}：${summary}\n改动：${stat || "无"}${notes}`,
          notifies: [],
          next: [{ reason: "next" }],
          turn: `主 → 子：${clip(a.text, l.verbosity === "verbose" ? 2000 : 300)}\n子 → 主：${res.interrupted ? "（被打断）" : ""}${clip(summary, l.verbosity === "verbose" ? 2000 : 400)}${stat ? `\n改动：${stat}` : ""}`,
        };
      }
      case "replan": {
        if (l.waitWatch) { cancelWatch(l.waitWatch); l.waitWatch = undefined; l.heartbeatS = undefined; }
        const lines = L.applyChange(l, a.change, n);
        const text = `**「${task.title}」按新的安排继续**\n${a.change.reason || "(没写原因)"}${lines.length ? "\n\n" + lines.map((x) => `- ${x}`).join("\n") : ""}\n\n有不同意见直接说。`;
        return {
          status: "running", progress: `第 ${n} 轮 · 重新安排：${clip(a.change.reason, 60)}`,
          obs: `重新安排：${a.change.reason}${lines.length ? "\n" + lines.join("；") : ""}`,
          notifies: [{ taskId: id, kind: "info", text }],
          next: [{ reason: "next" }], turn: "",
        };
      }
      case "verify": {
        const lines: string[] = [];
        const turn: string[] = [];
        for (const c of a.checks) {
          const before = wt.statusPorcelain(wtp);
          const r0 = await sh(c.cmd, wtp, Math.min((c.timeoutS ?? this.verifyTimeoutMs / 1000) * 1000, 30 * 60_000));
          const en = wt.enforceReadonly(wtp, before, `orc(#${id}) loop ${n}: preserve WIP during verify`);
          if (en.sha) L.codeChanged(l, en.sha);
          let pass = r0.code === 0 && !r0.timedOut;
          if (pass && c.expect) pass = new RegExp(c.expect, "i").test(r0.out);
          const tail = r0.out.split("\n").slice(-25).join("\n");
          const label = c.label && !/^E\d+$/i.test(c.label) ? `${c.label}（${c.cmd}）` : c.cmd;
          const ev = L.addEvidence(l, {
            kind: "verify", label, pass,
            detail: `${r0.timedOut ? "超时；" : ""}exit ${r0.code}${c.expect ? `；expect /${c.expect}/ ${pass ? "命中" : "未命中"}` : ""}\n${tail}`, sha: l.lastChangeSha, step: n,
          });
          const side = en.note ? `\n（${clip(en.note, 200)}）` : "";
          lines.push(`${ev.id} ${pass ? "✓" : "✗"} \`${c.cmd}\` exit ${r0.code}${r0.timedOut ? "（超时）" : ""}\n${clip(tail, 1500)}${side}`);
          turn.push(`${ev.id} ${pass ? "✓" : "✗"} \`${clip(c.cmd, 80)}\`${pass ? "" : `：${clip(tail.split("\n").filter(Boolean).pop() ?? "", 120)}`}`);
        }
        return { progress: `第 ${n} 轮 · 验证：${turn.map((t) => t.split(" ")[1]).join("")}`, obs: lines.join("\n\n"), notifies: [], next: [{ reason: "next" }], turn: turn.join("\n") };
      }
      case "review": {
        const rv = r.reviewer!;
        const diff = { ...wt.diffSince(wtp, task.baseRef), log: wt.logSince(wtp, task.baseRef) };
        const prompt = L.buildReviewPrompt(l, { taskId: id, rolePrompt: rv.prompt, contract: CONTRACT.verdict, diff, focus: a.focus });
        const beforeRv = wt.statusPorcelain(wtp);
        const res = await this.run(task, rv, prompt, { key: `orc-loop:${id}#reviewer`, readOnly: true, n, label: "审查" });
        if (res.cancelled) return { progress: "", obs: "", notifies: [], turn: "", stopped: true };
        l.budget.tokens += res.tokens;
        const en = wt.enforceReadonly(wtp, beforeRv, `orc(#${id}) loop ${n}: preserve WIP during review`);
        if (en.sha) L.codeChanged(l, en.sha);
        const p = parseRoleOutput("verdict", res.text);
        const ok = !("error" in p);
        const issues = ok ? (p.issues ?? []).slice(0, 12).map((it) => `- [${it.severity}] ${it.file ? it.file + (it.line ? ":" + it.line : "") + " " : ""}${it.desc}`).join("\n") : "";
        const summary = ok ? p.summary : `审查没有按约定输出：${clip(res.error || res.text.slice(-500), 500)}`;
        const ev = L.addEvidence(l, { kind: "review", label: `review ${roleName(rv)}：${ok ? (p.pass ? "approve" : "revise") : "无结论"}`, pass: ok && p.pass, detail: `${summary}\n${issues}`, sha: l.lastChangeSha, step: n });
        const side = en.note ? `\n（${clip(en.note, 200)}）` : "";
        return {
          progress: `第 ${n} 轮 · 审查：${ok ? (p.pass ? "approve" : "revise") : "无结论"}`,
          obs: `审查 ${ev.id}（${roleName(rv)}）${ok ? (p.pass ? "approve" : "revise") : "无结论"}：${summary}${issues ? "\n" + issues : ""}${side}`,
          notifies: [], next: [{ reason: "next" }],
          turn: `${ev.id} ${ev.pass ? "✓ approve" : "✗ " + (ok ? "revise" : "无结论")}（${roleName(rv)}）：${clip(summary, 300)}`,
        };
      }
      case "wait": {
        if (a.keep) {
          // keep 必须挂在仍有效的 waitWatch 上；否则会写出「监控 #undefined」并永远 waiting
          const wid = l.waitWatch;
          const live = wid != null ? getWatch(wid) : undefined;
          if (wid == null || !live || live.status !== "active") {
            l.waitWatch = undefined;
            l.heartbeatS = undefined;
            return {
              status: "running",
              progress: `第 ${n} 轮 · 等待的监控已失效，继续推进`,
              obs: `巡检想 keep，但 waitWatch=${wid ?? "无"} 已不存在或非 active（可能已触发/取消）。改为继续下一轮，避免卡在「监控 #undefined」。`,
              notifies: [],
              next: [{ reason: "next" }],
              turn: "等待监控已失效，不再 keep。",
            };
          }
          const hb = l.heartbeatS;
          const why = a.reason ? `：${clip(a.reason, 200)}` : "";
          // 巡检带了判断依据 → 写入监控 note，并刷新群卡片（避免一直只显示 log 文件名）
          if (a.reason?.trim()) {
            const updated = setWatchNote(wid, clip(a.reason.trim(), 500));
            if (updated) try { (this.opts.onWatchNote ?? this.opts.onWatchCreated)?.(task, updated); } catch { /* card best-effort */ }
          }
          // healthy patrol: card progress only, no group message
          return { status: "waiting", progress: `第 ${n} 轮 · 巡检正常，继续等待监控 #${wid}${why}`, obs: `巡检后继续等待监控 #${wid}${why}`, notifies: [], next: hb ? [{ reason: "heartbeat", delayMs: hb * 1000, ref: wid }] : [], turn: "" };
        }
        // 只有 every= 的纯定时等待：没有监控目标，但至少按约定时间叫醒一次，不再静默空转
        if (a.timerS) {
          const sec = Math.max(60, a.timerS);
          const why = a.reason ? `：${clip(a.reason, 120)}` : "";
          return {
            status: "waiting",
            progress: `第 ${n} 轮 · 定时重查（${Math.round(sec / 60)} 分钟后）${why}`,
            obs: `没有监控目标，按纯定时重查挂起 ${Math.round(sec / 60)} 分钟${why}。下一轮如果还要等，优先写 pid= / log= / done= 让监控代替轮询，省 token。`,
            notifies: [],
            next: [{ reason: "next", delayMs: sec * 1000 }],
            turn: "",
          };
        }
        const watchRaw: Record<string, unknown> = { ...(a.watch ?? {}) };
        const noteFromWatch = typeof watchRaw.note === "string" ? String(watchRaw.note).trim() : "";
        delete watchRaw.note;
        // title 常被填成 log 文件名；有 reason 时用它当标题，卡片才不像「只有一个 log」
        if (!watchRaw.title && a.reason) watchRaw.title = clip(a.reason, 40);
        const spec = parseWatchSpec(watchRaw, wtp);
        spec.onWake ||= a.reason || "叫醒监督者";
        const note = [a.reason && clip(a.reason, 500), noteFromWatch || parseWatchNote(a.watch)].filter(Boolean).join("\n") || undefined;
        const w = addWatch({ chatId: task.chatId!, bot: this.opts.watchBot!(task)!, sessionKey: `orc-loop:${id}`, cwd: wtp, spec, note });
        l.waitWatch = w.id;
        l.heartbeatS = Math.max(600, a.heartbeat ? parseDuration(a.heartbeat) : DEFAULT_HEARTBEAT_S);
        try { this.opts.onWatchCreated?.(task, w); } catch { /* card is best-effort */ }
        return {
          status: "waiting", progress: `等待监控 #${w.id}：${spec.title}`,
          obs: `已挂起，等待监控 #${w.id}（${describeSpec(spec)}）${a.reason ? "：" + a.reason : ""}${w.note ? `\n卡片 note：${clip(w.note, 200)}` : ""}`,
          notifies: [], next: l.heartbeatS ? [{ reason: "heartbeat", delayMs: l.heartbeatS * 1000, ref: w.id }] : [],
          turn: `⏳ 监控 #${w.id} ${spec.title}：${describeSpec(spec)}${l.heartbeatS ? `；每 ${Math.round(l.heartbeatS / 60)} 分钟心跳` : ""}`,
        };
      }
      case "ask": {
        l.pendingAsk = { step: n, question: a.question, why: a.why, askedAt: Date.now() };
        return {
          status: "blocked", progress: `等你决定：${clip(a.question, 80)}`, obs: `已向人提问：${a.question}`,
          notifies: [this.askNotify(task, l.pendingAsk)], next: [], turn: "",
        };
      }
      case "finish": {
        if (l.waitWatch) { cancelWatch(l.waitWatch); l.waitWatch = undefined; }
        const ev = l.evidence.slice(-6);
        const rows = l.criteria.map((c) => `- ${c.id} ${c.text}`).join("\n") || "（没有列验收标准）";
        const evs = ev.length ? ev.map((e) => L.evidenceLine(e, l)).join("\n") : "（这一轮没有记录验证结果）";
        const stale = l.evidence.length && l.lastChangeSha !== l.evidence[l.evidence.length - 1]?.sha;
        l.outcome = a.outcome;
        const said = a.outcome === "negative" ? "完成（结论是否定的）" : a.outcome === "mixed" ? "完成（部分成立）" : "完成";
        return {
          status: "ready", progress: said, obs: `完成：${a.summary}`,
          notifies: [{
            taskId: id, kind: "ready", outcome: a.outcome,
            text: `${a.summary}\n\n**验收标准**\n${rows}\n\n**最近的验证**\n${evs}${stale ? "\n\n（注意：最后一次改动之后没有再记录验证结果）" : ""}\n\n分支 \`${task.branch}\`（${shortStat(wt.diffSince(wtp, task.baseRef, 0).stat) || "无改动"}）`,
          }],
          turn: "",
        };
      }
      case "abort": {
        if (l.waitWatch) { cancelWatch(l.waitWatch); l.waitWatch = undefined; }
        const text = `${a.reason}\n\n分支 \`${task.branch}\` 和已提交的改动都保留着。`;
        return { status: "failed", progress: `放弃：${clip(a.reason, 80)}`, obs: `放弃：${a.reason}`, notifies: [{ taskId: id, kind: "failed", text }], turn: "" };
      }
    }
  }

  // ---- helpers ------------------------------------------------------------

  private resolveAsk(task: Task, l: L.Ledger, said: string, option?: string): { status: TaskStatus; progress: string; notifies: NotifyPayload[] } {
    const ask = l.pendingAsk!;
    l.pendingAsk = undefined;
    const n = l.step + 1;
    if (ask.code === "budget") {
      if (option === "stop") {
        const why = "按人的选择停下";
        return { status: "dropped", progress: why, notifies: [{ taskId: task.id, kind: "info", text: `${why}。分支 \`${task.branch}\` 和进展都保留。` }] };
      }
      L.extendBudget(l);
      L.resetGuards(l);
      L.observe(l, n, "human", `预算确认：继续${said && said !== "more" ? "；" + said : ""}`);
      return { status: "running", progress: "预算已追加，继续", notifies: [] };
    }
    const headline = ask.question.split("\n")[0].replace(/\*\*/g, "");
    // 不可逆的问题：回「不要」这类拒绝不算批准；其余回答（可以 / 不是，继续）记一次批准，下次 instruct 放行一次
    const refused = ask.why === "irreversible" && REFUSAL.test(said);
    L.observe(l, n, "human", `人对「${headline}」的回答：${said}${refused ? "（拒绝，不放行）" : ""}`);
    if (ask.why === "irreversible" && !refused) l.approvals.push({ step: ask.step, question: headline, answer: said, at: Date.now() });
    return { status: "running", progress: refused ? "你没同意，按你的意思调整" : "收到回答，继续", notifies: [] };
  }

  private askNotify(task: Task, a: L.PendingAsk): NotifyPayload {
    // 代码拦下的不可逆操作：问话里已经写了怎么回，不再加通用尾巴
    const tail = a.code === "budget" ? "\n\n要接着花就回一句「继续」（追加 50% 预算），要停就回「停」。"
      : a.code === "guard" ? ""
      : "\n\n直接在群里回一句你的想法就行，你回复之前不会往下走。";
    // 决策需要的放前面；全文放最后（平台按 4000 字分段）
    const detail = a.detail ? `\n\n---\n\n**完整指令**\n\n${a.detail}` : "";
    return { taskId: task.id, kind: "ask", text: `${a.question}${tail}${detail}` };
  }

  private enqueue(taskId: number, reason: string, delayMs = 0, ref?: number): void {
    const now = Date.now();
    if (!delayMs && this.store.pendingLoopEffects(taskId).some((e) => e.nextAt <= now + 1000 && e.payload.reason !== "heartbeat")) return;
    this.store.addEffect("loop", { taskId, reason, ...(ref != null ? { ref } : {}) } satisfies LoopPayload, delayMs);
  }

  /**
   * Persist ledger + task status + effects in one transaction. Code outside a round only
   * appends to inbox / events / humanLog (or flips verbosity / workerEpoch), so those are
   * re-read here and merged; queued events are folded in (a fired awaited watch wakes the task).
   */
  private commit(task: Task, l: L.Ledger, o: {
    status?: TaskStatus; progress?: string; notifies?: NotifyPayload[]; next?: { reason: string; delayMs?: number; ref?: number }[];
    /** move inbox messages into this round's observations */
    consumeInbox?: boolean;
    /** a round is about to read the ledger: don't schedule another round for a fired watch */
    noWake?: boolean;
    /** schedule a round if humans wrote meanwhile and nothing immediate is queued */
    wakeIfInbox?: boolean;
  }): void {
    this.store.tx(() => {
      const fresh = this.ledger(task.id);
      if (fresh) {
        // append-only queues: union by identity, so neither side's additions are lost
        l.inbox = union(l.inbox, fresh.inbox, (x) => `${x.at}|${x.text}`);
        l.events = union(l.events, fresh.events, (x) => `${x.at}|${x.kind}|${x.kind === "watch" ? x.watchId : x.text}`);
        l.humanLog = union(l.humanLog, fresh.humanLog, (x) => `${x.at}|${x.text}`).slice(-30);
        l.verbosity = fresh.verbosity;
        l.workerEpoch = Math.max(l.workerEpoch, fresh.workerEpoch);
      }
      if (o.consumeInbox) {
        for (const m of l.inbox) L.observe(l, l.step + 1, "human", m.text);
        l.inbox = [];
      }
      let status = o.status;
      const next = [...(o.next ?? [])];
      if (L.drainEvents(l) && !(status && FINAL.includes(status)) && status !== "blocked") {
        status = "running";
        if (!o.noWake) next.push({ reason: "watch" });
      }
      this.store.saveLedger(task.id, l);
      const cur = this.store.getTask(task.id)!;
      if (cur.status === "dropped") return;
      this.store.updateTask(task.id, { status, progress: o.progress });
      for (const x of o.notifies ?? []) this.store.addEffect("notify", x);
      for (const x of next) this.enqueue(task.id, x.reason, x.delayMs, x.ref);
      if (o.wakeIfInbox && l.inbox.length && !next.some((x) => !x.delayMs)) this.enqueue(task.id, "human");
    });
    this.emit(task.id);
    if (o.status && FINAL.includes(o.status) && this.store.getTask(task.id)?.status === o.status) {
      try { this.opts.onEnded?.(task.id); } catch { /* cleanup must not break the loop */ }
    }
  }

  private async run(task: Task, role: ResolvedRole, prompt: string, o: { key: string; readOnly: boolean; resumeSessionId?: string; n: number; label: string; tag?: string }): Promise<RunResult & { interrupted: boolean }> {
    const instructions = await this.opts.instructionsFor?.(task);
    const h: Running = { key: o.key, cli: role.cli, interrupted: false, cancelled: false };
    this.running.set(task.id, h);
    const dir = resolve(this.opts.orcHome, "tasks", String(task.id));
    mkdirSync(dir, { recursive: true });
    const base = `loop-${o.n}-${o.key.split("#")[1] ?? "run"}${o.tag ? `-${o.tag}` : ""}`;
    writeFileSync(resolve(dir, `${base}.prompt.md`), prompt);
    const model = role.model || role.cli;
    const onRun = (ev: Omit<LoopRunEvent, "taskId" | "n" | "label" | "model">) => {
      try { this.opts.onRun?.(task, { taskId: task.id, n: o.n, label: o.label, model, ...ev }); } catch { /* cards are best-effort */ }
    };
    onRun({ phase: "start" });
    const roundStart = Date.now();
    let last = 0;
    const progress = (line: string) => {
      const now = Date.now();
      if (now - last < 5000) return;
      last = now;
      this.store.updateTask(task.id, { progress: `第 ${o.n} 轮 · ${o.label}：${line}` });
      this.emit(task.id);
      onRun({ phase: "progress", line });
    };
    let res: RunResult;
    try {
      res = await this.exec.run({
        cli: role.cli, model: role.model, prompt, sessionKey: o.key, resumeSessionId: o.resumeSessionId, cwd: task.workspace!,
        appendSystemPrompt: instructions, readOnly: o.readOnly, disallowedTools: role.disallowedTools,
        hardTimeoutMs: role.hardTimeoutMin * 60_000, staleTimeoutMs: role.staleTimeoutMin * 60_000,
        onProgress: progress,
        onText: (t) => { const m = [...t.matchAll(/\[\[progress\]\]\s*(.+)/g)].pop(); if (m) progress(m[1].trim().slice(0, 200)); },
      });
    } catch (err) {
      res = { text: "", tokens: 0, timedOut: false, cancelled: false, error: (err as Error).message };
    } finally {
      this.running.delete(task.id);
    }
    writeFileSync(resolve(dir, `${base}.output.md`), res.text || res.error || "");
    onRun({ phase: "end", tokens: res.tokens, error: res.error || (res.timedOut ? "超时" : undefined), durationMs: Date.now() - roundStart });
    const cancelled = h.cancelled || (res.cancelled && !h.interrupted);
    return { ...res, cancelled, interrupted: h.interrupted };
  }

  /** 监督者这一轮没跑成：退避重试，到上限判故障（failed），不把它变成要人回答的问题 */
  private roundFailed(task: Task, l: L.Ledger, n: number, reason: string, res: RunResult, startedAt: number): void {
    const why = res.error || (res.timedOut ? "超时" : "没有回复");
    l.guard.infraErrors++;
    l.step = n;
    l.budget.activeMs += Date.now() - startedAt;
    L.observe(l, n, "system", `监督者这一轮没跑成：${clip(why, 400)}`);
    this.store.addStep({ taskId: task.id, n, reason, action: null, accepted: false, verdict: `运行失败：${clip(why, 200)}`, observation: "", raw: res.text || "", tokens: res.tokens, startedAt });
    if (l.guard.infraErrors >= L.INFRA_LIMIT) {
      this.commit(task, l, {
        status: "failed", progress: `监督者连续 ${L.INFRA_LIMIT} 轮没跑成：${clip(why, 60)}`,
        notifies: [{ taskId: task.id, kind: "failed", text: `**${task.title}：监督者连续 ${L.INFRA_LIMIT} 轮没跑成**\n${clip(why, 500)}\n\n这是运行故障，不是要你选；改动和分支都在，说「重试」就接着来。` }],
      });
    } else {
      this.commit(task, l, {
        status: task.status === "waiting" ? "waiting" : "running",
        progress: `监督者这一轮没跑成（${clip(why, 60)}），重试`,
        next: [{ reason: "retry", delayMs: L.RETRY_BASE_MS * 2 ** (l.guard.infraErrors - 1) }],
      });
    }
  }

  private infraFail(taskId: number, err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[orc loop] task #${taskId} round failed:`, msg);
    const task = this.store.getTask(taskId);
    const l = this.ledger(taskId);
    if (!task || !l || FINAL.includes(task.status)) return;
    l.guard.infraErrors++;
    L.observe(l, l.step + 1, "system", `本轮基础设施出错：${clip(msg, 500)}`);
    if (l.guard.infraErrors >= L.INFRA_LIMIT) {
      this.commit(task, l, {
        status: "failed", progress: `连续出错：${clip(msg, 80)}`,
        notifies: [{ taskId, kind: "failed", text: `**${task.title}：连续 ${l.guard.infraErrors} 轮出错**\n${clip(msg, 500)}\n\n这是运行故障，不是要你选；说「重试」就接着来。` }],
      });
    } else {
      this.commit(task, l, { next: [{ reason: "retry", delayMs: L.RETRY_BASE_MS * 2 ** (l.guard.infraErrors - 1) }] });
    }
  }

  private dropped(taskId: number): boolean {
    return this.store.getTask(taskId)?.status === "dropped";
  }

  private emit(taskId: number): void {
    const t = this.store.getTask(taskId);
    if (t) try { this.opts.onProgress?.(t); } catch { /* sink errors must not break the loop */ }
  }
}

function roleName(r: ResolvedRole): string {
  return `${r.name}/${r.cli}${r.model ? ":" + r.model : ""}`;
}

/** Lead's paraphrase + the human's own words when they differ (quotes are checked against the latter) */
function withRaw(text: string, raw?: string): string {
  const t = text.trim();
  const r = raw?.trim();
  return r && r !== t && !t.includes(r) ? `${t}\n（原话：${clip(r, 600)}）` : t;
}

function union<T extends { at: number }>(a: T[] = [], b: T[] = [], key: (x: T) => string): T[] {
  const seen = new Set(a.map(key));
  return [...a, ...b.filter((x) => !seen.has(key(x)))].sort((x, y) => x.at - y.at);
}

/** 监督者的正文：去掉 [[标记]] 块，只留它自己写的判断 */
function stripSignals(text: string): string {
  return (text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\[\s*(instruct|replan|verify|review|wait|ask|finish|abort)\s*\]\]/i.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
