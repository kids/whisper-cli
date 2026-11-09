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
import { addWatch, cancelWatch, describeSpec, getWatch, parseDuration, parseWatchSpec, type CheckResult, type Watch } from "../watch";
import * as L from "./ledger";
import { parseRoleOutput } from "./output";
import { CONTRACT } from "./prompts";
import type { Executor, RunResult } from "./runner";
import type { OrcStore } from "./store";
import type { CliName, Effect, LoopPayload, NotifyPayload, ResolvedRole, Task, TaskStatus, Verbosity } from "./types";
import * as wt from "./worktree";

export interface LoopOptions {
  orcHome: string;
  ensureWorktree: (task: Task) => Task;
  instructionsFor?: (task: Task) => Promise<string | undefined>;
  onProgress?: (task: Task) => void;
  /** bot whose watch host serves this task's chat (undefined → wait unavailable) */
  watchBot?: (task: Task) => string | undefined;
  /** a watch was registered for a loop task (post its card) */
  onWatchCreated?: (task: Task, w: Watch) => void;
  /** max loop tasks running a round at the same time */
  concurrency?: number;
  /** high-cost / ambiguous questions fall back to their default after this long */
  askTimeoutMs?: number;
  verifyTimeoutMs?: number;
}

const FINAL: TaskStatus[] = ["ready", "failed", "dropped"];
const DONE_KINDS = ["done", "metrics", "file", "cmd"];
const IDLE_ACTIONS: L.ActionName[] = ["instruct", "verify", "review", "report", "update_constraints"];
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

/** Run a read-only check command in the worktree */
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
  private readonly askTimeoutMs: number;
  private readonly verifyTimeoutMs: number;

  constructor(private store: OrcStore, private exec: Executor, private opts: LoopOptions) {
    this.concurrency = opts.concurrency ?? Number(process.env.ORC_LOOP_CONCURRENCY || 3);
    this.askTimeoutMs = opts.askTimeoutMs ?? Number(process.env.ORC_LOOP_ASK_TIMEOUT_MS || 4 * 3_600_000);
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
    return this.store.getLedger<L.Ledger>(taskId);
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
    if (task.status === "blocked") {
      const a = l.pendingAsk;
      if (p.reason !== "ask_timeout" || !a || a.step !== p.ref || (a.timeoutAt ?? Infinity) > Date.now() + 1000) return skip("blocked");
    } else if (p.reason === "ask_timeout") return skip("question already answered");
    if (task.status === "waiting" && !["watch", "heartbeat", "human", "resume", "retry"].includes(p.reason)) return skip("waiting");
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
  attach(taskId: number, text: string, urgent = false, raw?: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop" || FINAL.includes(task.status)) return false;
    const l = this.ledger(taskId)!;
    if (task.status === "blocked" && l.pendingAsk) { this.answer(taskId, undefined, text, raw); return true; }
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

  /** Answer the open question (option id and/or free text) */
  answer(taskId: number, option?: string, text?: string, raw?: string): string {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop") return `#${taskId} 不是监督循环任务`;
    const l = this.ledger(taskId)!;
    const ask = l.pendingAsk;
    if (task.status !== "blocked" || !ask) return `#${taskId} 现在没有待回答的问题`;
    if (option && !ask.options.some((o) => o.id === option)) return `没有选项「${option}」，可选：${ask.options.map((o) => `${o.id}) ${o.label}`).join("；")}`;
    if (!option && !text && !raw) return "请给出选项或你的想法";
    if (raw || text) L.noteHuman(l, (raw || text)!);
    const r = this.resolveAsk(task, l, option, text ? withRaw(text, raw) : raw, "human");
    this.commit(task, l, { status: r.status, progress: r.progress, notifies: r.notifies, next: r.status === "running" ? [{ reason: "human" }] : [] });
    const opt = ask.options.find((o) => o.id === option);
    return r.status === "running" ? `✅ #${taskId} 收到${opt ? `「${opt.label}」` : "你的回复"}，继续推进` : `🛑 #${taskId} 已按你的选择停下`;
  }

  /** Human retry of a blocked / failed / dropped loop task */
  resume(taskId: number, note?: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task || task.kind !== "loop" || !["blocked", "failed", "dropped"].includes(task.status)) return false;
    const l = this.ledger(taskId)!;
    if (task.status === "blocked" && l.pendingAsk) { this.answer(taskId, l.pendingAsk.code ? l.pendingAsk.options[0].id : undefined, note || "继续"); return true; }
    L.resetGuards(l);
    if (L.budgetState(l).exhausted) L.extendBudget(l);
    l.pendingAsk = undefined;
    if (note) L.noteHuman(l, note);
    L.observe(l, l.step + 1, "human", `人工重试${note ? "：" + note : ""}`);
    this.commit(task, l, { status: "running", progress: "人工重试", next: [{ reason: "resume" }] });
    return true;
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
    if (!task || task.kind !== "loop" || FINAL.includes(task.status)) throw new Error(`#${taskId} 不是进行中的监督循环任务`);
    const preset = structuredClone(task.preset);
    const lines: string[] = [];
    let workerChanged = false;
    for (const [name, e] of Object.entries(edits)) {
      const role = preset.roles[name];
      if (!role || !e) throw new Error(`任务 #${taskId} 没有角色 "${name}"（有：${Object.keys(preset.roles).join(", ")}）`);
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
    const task = this.opts.ensureWorktree(task0);
    const wtp = task.worktree!;
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

    if (p.reason === "ask_timeout" && l.pendingAsk) {
      const r = this.resolveAsk(task, l, undefined, undefined, "timeout");
      if (r.status !== "running") { this.commit(task, l, { status: r.status, progress: r.progress, notifies: r.notifies }); return; }
      notifies.push(...r.notifies);
    }

    const b = L.budgetState(l);
    if (b.exhausted) {
      l.pendingAsk = L.guardAsk(l, "budget", b.exhausted, this.askTimeoutMs);
      this.commit(task, l, { status: "blocked", progress: `预算用完：${b.exhausted}`, notifies: [...notifies, this.askNotify(task, l.pendingAsk)], next: [{ reason: "ask_timeout", delayMs: this.askTimeoutMs, ref: l.pendingAsk.step }] });
      return;
    }
    if (b.ratio >= 0.8 && !l.budget.warned) {
      l.budget.warned = true;
      notifies.push({ taskId: task.id, kind: "info", text: `预算已用 80% 以上（${b.line}）。需要的话直接说“追加预算”。` });
    }

    this.commit(task, l, { status: task.status === "waiting" ? "waiting" : "running", progress: `第 ${n} 轮 · 监督者思考中`, consumeInbox: true, noWake: true });
    // still parked on a watch? (it may have fired just now — then it's already in the observations)
    const wasWaiting = !!l.waitWatch;

    // ---- Supervisor proposes ----
    const sup = task.preset.roles[loop.supervisor];
    const worker = task.preset.roles[loop.worker];
    const reviewer = loop.reviewer ? task.preset.roles[loop.reviewer] : undefined;
    const canWait = !!(task.chatId && this.opts.watchBot?.(task));
    const waiting = wasWaiting && l.waitWatch ? (() => { const w = getWatch(l.waitWatch!); return w ? `监控 #${w.id} ${w.spec.title}（${describeSpec(w.spec)}）；最新：${w.summary}` : undefined; })() : undefined;
    const reasonText = ({
      start: "任务刚开始", next: "上一个动作已完成", human: "人发来了消息", watch: "等待的监控触发了", heartbeat: "等待期间的定时心跳（看看趋势，需要继续等就 wait keep）",
      ask_timeout: "问题超时未答，已按默认处理", resume: "人要求继续 / 重试", retry: "上一轮出错后重试",
    } as Record<string, string>)[p.reason] ?? p.reason;
    const prompt = L.buildSupervisorPrompt(l, {
      taskId: task.id, title: task.title, worktree: wtp, branch: task.branch ?? "", diffStat: wt.diffSince(wtp, task.baseRef, 0).stat,
      worker: roleName(worker), reviewer: reviewer ? roleName(reviewer) : undefined, reason: reasonText, waiting, canWait,
    });
    const res = await this.run(task, sup, prompt, { key: `orc-loop:${task.id}#supervisor`, readOnly: true, n, label: "监督者" });
    if (res.cancelled || this.dropped(task.id)) return;
    l.budget.steps++;
    l.budget.tokens += res.tokens;
    if (wt.isDirty(wtp)) { const files = wt.resetHard(wtp); L.observe(l, n, "system", `监督者是只读的，却改了文件，已回滚：${clip(files, 300)}`); }

    const parsed = res.error && !res.text ? { error: `监督者运行失败：${res.error}` } : L.parseLoopAction(res.text);
    const rejection = "error" in parsed ? parsed.error : L.validateAction(l, parsed, {
      hasReviewer: !!reviewer, requireReview: loop.requireReview, canWait,
      checkWatch: (raw) => parseWatchSpec(raw, wtp),
    });
    if (rejection) {
      l.guard.invalidStreak++;
      l.rejection = rejection;
      l.step = n;
      L.observe(l, n, "rejected", `动作被驳回：${rejection}`);
      l.budget.activeMs += Date.now() - t0;
      this.store.addStep({ taskId: task.id, n, reason: p.reason, action: "error" in parsed ? null : parsed, accepted: false, verdict: rejection, observation: "", raw: res.text, tokens: res.tokens, startedAt: t0 });
      if (l.guard.invalidStreak >= L.INVALID_LIMIT) {
        l.pendingAsk = L.guardAsk(l, "invalid", rejection, this.askTimeoutMs);
        this.commit(task, l, { status: "blocked", progress: "监督者连续给出无效动作", notifies: [...notifies, this.askNotify(task, l.pendingAsk)], next: [{ reason: "ask_timeout", delayMs: this.askTimeoutMs, ref: n }] });
      } else {
        this.commit(task, l, { status: wasWaiting ? "waiting" : "running", progress: `第 ${n} 轮动作被驳回，重新决策`, notifies, next: [{ reason: "retry" }] });
      }
      return;
    }
    const a = parsed as L.LoopAction;
    l.rejection = undefined;
    l.guard.invalidStreak = 0;
    l.guard.infraErrors = 0;
    if (a.plan) l.plan = a.plan;
    if (a.decision) { l.decisions.push({ step: n, at: Date.now(), text: a.decision }); if (l.decisions.length > 30) l.decisions.shift(); }

    // anything but "keep waiting" during a wait = stop waiting for that job
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
    l.guard.lastAction = a.action;
    if (out.obs) L.observe(l, n, a.action, out.obs);

    // ---- guards after the action ----
    let status = out.status ?? "running";
    let next = out.next ?? [];
    const extra: NotifyPayload[] = [];
    if (IDLE_ACTIONS.includes(a.action)) {
      const sig = L.progressSig(l);
      l.guard.idleStreak = sig === l.guard.lastSig ? l.guard.idleStreak + 1 : 0;
      l.guard.lastSig = sig;
    }
    const worst = Object.entries(l.guard.errorCounts).sort((x, y) => y[1] - x[1])[0];
    const guard = status === "running"
      ? (worst && worst[1] >= L.ERROR_ASK_AT ? ["errors", worst[0]] as const
        : l.guard.idleStreak >= L.IDLE_LIMIT ? ["idle", "看起来在原地打转。"] as const : undefined)
      : undefined;
    if (guard) {
      l.pendingAsk = L.guardAsk(l, guard[0], clip(guard[1], 200), this.askTimeoutMs);
      status = "blocked";
      next = [{ reason: "ask_timeout", delayMs: this.askTimeoutMs, ref: n }];
      extra.push(this.askNotify(task, l.pendingAsk));
    }

    l.budget.activeMs += Date.now() - t0;
    this.store.addStep({ taskId: task.id, n, reason: p.reason, action: a, accepted: true, verdict: "", observation: out.obs, raw: res.text, tokens: res.tokens, startedAt: t0 });
    const turn: NotifyPayload[] = [];
    if (l.verbosity !== "quiet" && out.turn) {
      const think = l.verbosity === "verbose" ? thinking(res.text) : "";
      turn.push({ taskId: task.id, kind: "turn", text: `**第 ${n} 轮 · ${L.ACTION_LABEL[a.action]}**\n${out.turn}${think ? `\n\n> 监督者的分析：${clip(think, 1200).replace(/\n/g, "\n> ")}` : ""}` });
    }
    this.commit(task, l, { status, progress: out.progress, notifies: [...notifies, ...turn, ...out.notifies, ...extra], next, wakeIfInbox: status !== "blocked" });
  }

  // ---- actions ------------------------------------------------------------

  private async execute(task: Task, l: L.Ledger, a: L.LoopAction, n: number, r: { worker: ResolvedRole; reviewer?: ResolvedRole }): Promise<Outcome> {
    const wtp = task.worktree!;
    const id = task.id;
    switch (a.action) {
      case "instruct": {
        if (L.irreversibleHit(a.text)) { const ap = l.approvals.find((x) => !x.used); if (ap) ap.used = true; }
        const fresh = a.fresh || !l.worker.sessionId || l.worker.turns >= L.MAX_WORKER_TURNS || l.worker.epoch !== l.workerEpoch;
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
        const job = ok && p.value?.job && typeof p.value.job === "object" ? JSON.stringify(p.value.job) : "";
        const status = ok ? String(p.value.status) : "未按约定输出 JSON";
        const head = res.interrupted ? "worker 被人打断（到目前为止的改动已提交）" : res.timedOut ? `worker 超时（${r.worker.hardTimeoutMin} 分钟内没完成；已提交部分改动）` : res.error ? `worker 运行出错：${clip(res.error, 300)}` : `worker 回报（${status}）`;
        const notes = ok && p.notes.length ? `\n笔记：${p.notes.map((x) => "- " + x).join("\n")}` : "";
        return {
          progress: `第 ${n} 轮 · worker：${clip(summary.replace(/\n+/g, " "), 80)}`,
          obs: `指令：${clip(a.text, 400)}\n${head}：${summary}\n改动：${stat || "无"}${job ? `\n后台作业：${job}` : ""}${notes}`,
          notifies: [],
          next: [{ reason: "next" }],
          turn: `主 → 子：${clip(a.text, l.verbosity === "verbose" ? 2000 : 300)}\n子 → 主：${res.interrupted ? "（被打断）" : ""}${clip(summary, l.verbosity === "verbose" ? 2000 : 400)}${stat ? `\n改动：${stat}` : ""}${job ? `\n后台作业：\`${clip(job, 200)}\`` : ""}`,
        };
      }
      case "verify": {
        const lines: string[] = [];
        const turn: string[] = [];
        for (const c of a.checks) {
          const r0 = await sh(c.cmd, wtp, Math.min((c.timeoutS ?? this.verifyTimeoutMs / 1000) * 1000, 30 * 60_000));
          let violation = "";
          if (wt.isDirty(wtp)) violation = wt.resetHard(wtp);
          let pass = r0.code === 0 && !r0.timedOut;
          if (pass && c.expect) pass = new RegExp(c.expect, "i").test(r0.out);
          const tail = r0.out.split("\n").slice(-25).join("\n");
          const label = c.label && !/^E\d+$/i.test(c.label) ? `${c.label}（${c.cmd}）` : c.cmd;
          const ev = L.addEvidence(l, {
            kind: "verify", label, pass,
            detail: `${r0.timedOut ? "超时；" : ""}exit ${r0.code}${c.expect ? `；expect /${c.expect}/ ${pass ? "命中" : "未命中"}` : ""}\n${tail}`, sha: l.lastChangeSha, step: n,
          });
          if (!pass) {
            const last = (r0.out.split("\n").filter((x) => x.trim()).pop() ?? "").replace(/\d+(\.\d+)?/g, "#").slice(0, 120);
            const sig = `${c.cmd} → exit ${r0.code}：${last}`;
            l.guard.errorCounts[sig] = (l.guard.errorCounts[sig] ?? 0) + 1;
            if (l.guard.errorCounts[sig] === L.ERROR_HINT_AT) lines.push(`⚠️ 同一个失败已经出现 ${L.ERROR_HINT_AT} 次，考虑换个策略`);
          }
          lines.push(`${ev.id} ${pass ? "✓" : "✗"} \`${c.cmd}\` exit ${r0.code}${r0.timedOut ? "（超时）" : ""}\n${clip(tail, 1500)}${violation ? `\n（检查命令改了文件，已回滚：${clip(violation, 200)}）` : ""}`);
          turn.push(`${ev.id} ${pass ? "✓" : "✗"} \`${clip(c.cmd, 80)}\`${pass ? "" : `：${clip(tail.split("\n").filter(Boolean).pop() ?? "", 120)}`}`);
        }
        return { progress: `第 ${n} 轮 · 验证：${turn.map((t) => t.split(" ")[1]).join("")}`, obs: lines.join("\n\n"), notifies: [], next: [{ reason: "next" }], turn: turn.join("\n") };
      }
      case "report": {
        const md = [a.progress, a.findings?.length ? `**发现**\n${a.findings.map((f) => "- " + f).join("\n")}` : "", a.suggestion ? `**建议**：${a.suggestion}` : ""].filter(Boolean).join("\n\n");
        return { progress: `第 ${n} 轮 · 已汇报`, obs: `已向群里汇报：${clip(a.progress, 300)}`, notifies: [{ taskId: id, kind: "report", text: md }], next: [{ reason: "next" }], turn: "" };
      }
      case "update_constraints": {
        const lines = L.applyChanges(l, a, n);
        const src = a.source === "human" ? `（依据人的话：“${clip(a.quote ?? "", 120)}”）` : "";
        return {
          progress: `第 ${n} 轮 · 约束更新到 v${l.constraintsVersion}`,
          obs: `约束 / 验收标准已更新到 v${l.constraintsVersion}：\n${lines.join("\n")}`,
          notifies: [{ taskId: id, kind: "constraints", text: `**约束 v${l.constraintsVersion}**：${a.reason}${src}\n${lines.join("\n")}` }],
          next: [{ reason: "next" }], turn: "",
        };
      }
      case "review": {
        const rv = r.reviewer!;
        const diff = { ...wt.diffSince(wtp, task.baseRef), log: wt.logSince(wtp, task.baseRef) };
        const prompt = L.buildReviewPrompt(l, { taskId: id, rolePrompt: rv.prompt, contract: CONTRACT.verdict, diff, focus: a.focus });
        const res = await this.run(task, rv, prompt, { key: `orc-loop:${id}#reviewer`, readOnly: true, n, label: "审查" });
        if (res.cancelled) return { progress: "", obs: "", notifies: [], turn: "", stopped: true };
        l.budget.tokens += res.tokens;
        let violation = "";
        if (wt.isDirty(wtp)) violation = wt.resetHard(wtp);
        const p = parseRoleOutput("verdict", res.text);
        const ok = !("error" in p);
        const issues = ok ? (p.value.issues as any[]).slice(0, 12).map((it) => typeof it === "string" ? `- ${it}` : `- [${it.severity ?? "issue"}] ${it.file ? it.file + (it.line ? ":" + it.line : "") + " " : ""}${it.desc ?? it.description ?? JSON.stringify(it)}`).join("\n") : "";
        const summary = ok ? p.summary : `审查没有按约定输出：${clip(res.error || res.text.slice(-500), 500)}`;
        const ev = L.addEvidence(l, { kind: "review", label: `review ${roleName(rv)}：${ok ? p.value.verdict : "无结论"}`, pass: ok && p.pass, detail: `${summary}\n${issues}`, sha: l.lastChangeSha, step: n });
        return {
          progress: `第 ${n} 轮 · 审查：${ok ? p.value.verdict : "无结论"}`,
          obs: `审查 ${ev.id}（${roleName(rv)}）${ok ? p.value.verdict : "无结论"}：${summary}${issues ? "\n" + issues : ""}${violation ? `\n（审查者改了文件，已回滚）` : ""}`,
          notifies: [], next: [{ reason: "next" }],
          turn: `${ev.id} ${ev.pass ? "✓ approve" : "✗ " + (ok ? "revise" : "无结论")}（${roleName(rv)}）：${clip(summary, 300)}`,
        };
      }
      case "wait": {
        if (a.keep) {
          const hb = l.heartbeatS;
          return { status: "waiting", progress: `第 ${n} 轮 · 继续等待监控 #${l.waitWatch}`, obs: `继续等待监控 #${l.waitWatch}。`, notifies: [], next: hb ? [{ reason: "heartbeat", delayMs: hb * 1000, ref: l.waitWatch }] : [], turn: `继续等待监控 #${l.waitWatch}` };
        }
        const spec = parseWatchSpec(a.watch, wtp);
        spec.onWake ||= a.reason || "叫醒监督者";
        const w = addWatch({ chatId: task.chatId!, bot: this.opts.watchBot!(task)!, sessionKey: `orc-loop:${id}`, cwd: wtp, spec });
        l.waitWatch = w.id;
        l.heartbeatS = a.heartbeat ? Math.max(600, parseDuration(a.heartbeat)) : undefined;
        try { this.opts.onWatchCreated?.(task, w); } catch { /* card is best-effort */ }
        return {
          status: "waiting", progress: `等待监控 #${w.id}：${spec.title}`,
          obs: `已挂起，等待监控 #${w.id}（${describeSpec(spec)}）${a.reason ? "：" + a.reason : ""}`,
          notifies: [], next: l.heartbeatS ? [{ reason: "heartbeat", delayMs: l.heartbeatS * 1000, ref: w.id }] : [],
          turn: `⏳ 监控 #${w.id} ${spec.title}：${describeSpec(spec)}${l.heartbeatS ? `；每 ${Math.round(l.heartbeatS / 60)} 分钟心跳` : ""}`,
        };
      }
      case "ask": {
        l.pendingAsk = {
          step: n, question: a.question, why: a.why, options: a.options, default: a.default, askedAt: Date.now(),
          timeoutAt: a.why === "irreversible" ? undefined : Date.now() + this.askTimeoutMs,
        };
        return {
          status: "blocked", progress: `等你决定：${clip(a.question, 80)}`, obs: `已向人提问：${a.question}`,
          notifies: [this.askNotify(task, l.pendingAsk)],
          next: l.pendingAsk.timeoutAt ? [{ reason: "ask_timeout", delayMs: this.askTimeoutMs, ref: n }] : [], turn: "",
        };
      }
      case "finish": {
        const evs = new Map(l.evidence.map((e) => [e.id, e]));
        const rows = l.criteria.map((c) => {
          const ref = a.acceptance.find((x) => x.criterion === c.id && evs.get(x.evidence)?.pass) ?? a.acceptance.find((x) => x.criterion === c.id);
          const e = ref ? evs.get(ref.evidence) : undefined;
          return `- ${c.id} ${c.text} ← ${e ? `${e.id} ✓ ${clip(e.label, 80)}` : "?"}`;
        });
        if (l.waitWatch) { cancelWatch(l.waitWatch); l.waitWatch = undefined; }
        return {
          status: "ready", progress: "完成，等待验收", obs: `完成：${a.summary}`,
          notifies: [{ taskId: id, kind: "ready", text: `${a.summary}\n\n**验收**\n${rows.join("\n")}\n\n分支 \`${task.branch}\`（${shortStat(wt.diffSince(wtp, task.baseRef, 0).stat) || "无改动"}）` }],
          turn: "",
        };
      }
      case "abort": {
        if (l.waitWatch) { cancelWatch(l.waitWatch); l.waitWatch = undefined; }
        const text = [
          a.reason,
          `**试过**\n${a.tried.map((x) => "- " + x).join("\n")}`,
          `**卡在**\n${a.blockers.map((x) => "- " + x).join("\n")}`,
          a.unmet.length ? `**没达成的验收标准**\n${a.unmet.map((u) => `- ${u} ${l.criteria.find((c) => c.id === u)?.text ?? ""}`).join("\n")}` : "",
          a.resume_hint ? `**以后怎么接着做**：${a.resume_hint}` : "",
          `分支 \`${task.branch}\` 保留；说“重试 #${id} …”可以带着新思路继续。`,
        ].filter(Boolean).join("\n\n");
        return { status: "failed", progress: `放弃：${clip(a.reason, 80)}`, obs: `放弃：${a.reason}`, notifies: [{ taskId: id, kind: "failed", text }], turn: "" };
      }
    }
  }

  // ---- helpers ------------------------------------------------------------

  private resolveAsk(task: Task, l: L.Ledger, option: string | undefined, text: string | undefined, via: "human" | "timeout"): { status: TaskStatus; progress: string; notifies: NotifyPayload[] } {
    const ask = l.pendingAsk!;
    l.pendingAsk = undefined;
    const n = l.step + 1;
    const opt = ask.options.find((o) => o.id === (option ?? (via === "timeout" ? ask.default : undefined)));
    if (ask.code) {
      if (opt?.id === "stop") {
        const why = via === "timeout" ? "问题超时没人回答，按默认停下" : "按人的选择停下";
        return { status: "dropped", progress: why, notifies: [{ taskId: task.id, kind: "info", text: `${why}。分支 \`${task.branch}\` 和进展都保留，说“重试 #${task.id}”可以继续。` }] };
      }
      if (ask.code === "budget") L.extendBudget(l);
      L.resetGuards(l);
      L.observe(l, n, "human", `对「${ask.question}」人选择继续${text ? "：" + text : ""}`);
      return { status: "running", progress: "人选择继续", notifies: [] };
    }
    const label = opt ? `「${opt.id}) ${opt.label}」` : "";
    if (via === "timeout") L.observe(l, n, "system", `问题「${ask.question}」超时没人回答，按默认选项${label}继续。`);
    else L.observe(l, n, "human", `人对「${ask.question}」的回答：${label}${text ? (label ? "；" : "") + text : ""}`);
    if (ask.why === "irreversible" && via === "human" && opt?.go) {
      l.approvals.push({ step: ask.step, question: ask.question, answer: `${opt.label}${text ? "；" + text : ""}`, at: Date.now() });
    }
    return { status: "running", progress: via === "timeout" ? "问题超时，按默认继续" : "收到回答，继续", notifies: [] };
  }

  private askNotify(task: Task, a: L.PendingAsk): NotifyPayload {
    const opts = a.options.map((o) => `**${o.id})** ${o.label}${o.consequence ? ` —— ${o.consequence}` : ""}${o.id === a.default ? "（默认）" : ""}`).join("\n");
    const tail = a.timeoutAt
      ? `${fmtWhen(a.timeoutAt)} 前没回复就按默认继续。`
      : "这是不可逆操作，不会自动执行，等你明确回复。";
    return { taskId: task.id, kind: "ask", text: `${a.question}\n\n${opts}\n\n直接在群里回复选项或你的想法。${tail}` };
  }

  private enqueue(taskId: number, reason: string, delayMs = 0, ref?: number): void {
    const now = Date.now();
    if (!delayMs && this.store.pendingLoopEffects(taskId).some((e) => e.nextAt <= now + 1000 && !["ask_timeout", "heartbeat"].includes(e.payload.reason))) return;
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
  }

  private async run(task: Task, role: ResolvedRole, prompt: string, o: { key: string; readOnly: boolean; resumeSessionId?: string; n: number; label: string }): Promise<RunResult & { interrupted: boolean }> {
    const instructions = await this.opts.instructionsFor?.(task);
    const h: Running = { key: o.key, cli: role.cli, interrupted: false, cancelled: false };
    this.running.set(task.id, h);
    const dir = resolve(this.opts.orcHome, "tasks", String(task.id));
    mkdirSync(dir, { recursive: true });
    const base = `loop-${o.n}-${o.key.split("#")[1] ?? "run"}`;
    writeFileSync(resolve(dir, `${base}.prompt.md`), prompt);
    let last = 0;
    const progress = (line: string) => {
      const now = Date.now();
      if (now - last < 5000) return;
      last = now;
      this.store.updateTask(task.id, { progress: `第 ${o.n} 轮 · ${o.label}：${line}` });
      this.emit(task.id);
    };
    let res: RunResult;
    try {
      res = await this.exec.run({
        cli: role.cli, model: role.model, prompt, sessionKey: o.key, resumeSessionId: o.resumeSessionId, cwd: task.worktree!,
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
    const cancelled = h.cancelled || (res.cancelled && !h.interrupted);
    return { ...res, cancelled, interrupted: h.interrupted };
  }

  private infraFail(taskId: number, err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[orc loop] task #${taskId} round failed:`, msg);
    const task = this.store.getTask(taskId);
    const l = this.ledger(taskId);
    if (!task || !l || FINAL.includes(task.status)) return;
    l.guard.infraErrors++;
    L.observe(l, l.step + 1, "system", `本轮基础设施出错：${clip(msg, 500)}`);
    if (l.guard.infraErrors >= 3) {
      this.commit(task, l, { status: "blocked", progress: `连续出错：${clip(msg, 80)}`, notifies: [{ taskId, kind: "decision", text: `连续 ${l.guard.infraErrors} 轮出错：${clip(msg, 500)}\n\n修好环境后说“重试 #${taskId}”继续。` }] });
    } else {
      this.commit(task, l, { next: [{ reason: "retry", delayMs: 10_000 * 2 ** (l.guard.infraErrors - 1) }] });
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

/** The Supervisor's analysis = its reply minus the final JSON */
function thinking(text: string): string {
  const i = text.lastIndexOf('{"action"');
  const j = i >= 0 ? i : text.lastIndexOf("```");
  return (j > 0 ? text.slice(0, j) : "").replace(/```(json)?\s*$/i, "").trim();
}
