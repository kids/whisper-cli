// =============================================================================
// orc — deterministic scheduler: durable effects + per-role slots
// =============================================================================
// No LLM in here. Each tick drains due effects:
//   notify → sink (retried with backoff)
//   launch → deps gate → role slot → run one attempt (async) → on finish, one
//            transaction records the attempt, applies core's decision and
//            enqueues the next effects.
// Runs independently of the per-chat message queue (002 §2.2).
// =============================================================================
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { knownIssues, renderAutoNote, renderBrief } from "./brief";
import { stageName } from "./core";
import { childStartStage, decideAccept, decideAfterAttempt, decideParent, depsGate, type Decision, type Outcome } from "./core";
import { parseRoleOutput, lastProgressLine } from "./output";
import { buildBriefPrompt, buildStagePrompt } from "./prompts";
import { LoopEngine, type LoopOptions } from "./loop";
import type { Executor } from "./runner";
import type { OrcStore } from "./store";
import type { Attempt, Effect, LaunchPayload, NotifyPayload, ResolvedPreset, ResolvedRole, Task } from "./types";
import { TERMINAL } from "./types";
import * as wt from "./worktree";

export type NotifySink = (task: Task, n: NotifyPayload) => Promise<void>;

export interface OrchestratorOptions {
  orcHome: string;
  notify: NotifySink;
  /** Per-task extra system prompt (e.g. the chat's group announcement) */
  instructionsFor?: (task: Task) => Promise<string | undefined>;
  /** Called (throttled) whenever a task's visible progress changes */
  onProgress?: (task: Task) => void;
  /** the advisor role that writes 决策说明 when a task cannot settle itself (orc/roles/advisor.md) */
  briefRole?: (task: Task) => Promise<ResolvedRole | undefined> | ResolvedRole | undefined;
  tickMs?: number;
  progressThrottleMs?: number;
  /** Supervisor-loop hooks (watch routing etc.) */
  loop?: Pick<LoopOptions, "watchBot" | "onWatchCreated" | "onRun" | "concurrency" | "askTimeoutMs" | "verifyTimeoutMs">;
}

const MAX_NOTIFY_TRIES = 5;

export class Orchestrator {
  private running = new Map<number, { attemptId: number; taskId: number; role: string; cli: Attempt["cli"]; sessionKey: string; cancelled: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private inflight = new Set<Promise<void>>();
  /** role → busy slot indices; reserved synchronously at launch so one tick can't over-commit */
  private busy = new Map<string, Set<number>>();
  /** role → launch effect ids parked because every slot was busy */
  private slotWaiters = new Map<string, Set<number>>();
  /** Supervisor ReAct loop for kind=loop tasks */
  readonly loop: LoopEngine;

  constructor(readonly store: OrcStore, private exec: Executor, private opts: OrchestratorOptions) {
    mkdirSync(resolve(opts.orcHome, "notes"), { recursive: true });
    mkdirSync(resolve(opts.orcHome, "tasks"), { recursive: true });
    this.loop = new LoopEngine(store, exec, {
      ...opts.loop, orcHome: opts.orcHome, instructionsFor: opts.instructionsFor, onProgress: opts.onProgress,
      ensureWorktree: (t) => this.prepareWorktree(t),
    });
  }

  // ---- public API ---------------------------------------------------------

  submit(input: {
    goal: string; title?: string; repo: string; preset: ResolvedPreset; chatId?: string | null;
    /** loop presets: acceptance criteria / constraints known at submit time, and the human's own words */
    criteria?: string[]; constraints?: string[]; sourceText?: string;
    /** how strictly review should judge this task, in the lead's words (see orc/chat.ts lead prompt) */
    bar?: string;
    origin?: "human" | "agent";
  }): Task {
    const root = wt.repoRoot(input.repo);
    if (!root) throw new Error(`${input.repo} is not inside a git repository (orc needs git worktrees)`);
    const baseRef = wt.headSha(root);
    const kind = input.preset.kind === "loop" ? "loop" : "pipeline";
    return this.store.tx(() => {
      const task = this.store.createTask({
        title: input.title || shortTitle(input.goal), goal: input.goal, repo: root, baseRef,
        preset: input.preset, chatId: input.chatId ?? null, kind, bar: input.bar ?? "", origin: input.origin,
      });
      if (kind === "loop") this.loop.init(task, input);
      else this.store.addEffect("launch", { taskId: task.id, stageIdx: 0 } satisfies LaunchPayload);
      return task;
    });
  }

  /** Stop a task: cancel queued launches, kill its running session, mark dropped */
  stop(taskId: number): boolean {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    // blocked awaits a human: 放弃 must work for every kind, not just loop tasks
    const stoppable = !TERMINAL.includes(task.status) || task.status === "blocked";
    this.store.tx(() => {
      this.store.cancelPendingLaunches(taskId);
      for (const child of this.store.listTasks({ parentId: taskId })) {
        if (!TERMINAL.includes(child.status)) this.stop(child.id);
      }
      if (stoppable) this.store.updateTask(taskId, { status: "dropped", progress: "已被用户终止" });
    });
    if (task.kind === "loop") this.loop.stop(taskId);
    for (const r of this.running.values()) {
      if (r.taskId === taskId) { r.cancelled = true; this.exec.stop(r.sessionKey, r.cli); }
    }
    this.emitProgress(taskId);
    return true;
  }

  /** Resume a blocked/failed task at its current stage with fresh loop budget */
  retry(taskId: number, note?: string): boolean {
    const task = this.store.getTask(taskId);
    if (task?.kind === "loop") return this.loop.resume(taskId, note);
    if (!task || !["blocked", "failed", "dropped"].includes(task.status)) return false;
    const stage = task.preset.stages[Math.min(task.stageIdx, task.preset.stages.length - 1)];
    const loops = { ...task.loops };
    for (const k of Object.keys(loops)) if (k === stage.id || k.endsWith(`:${stage.id}`)) delete loops[k];
    this.store.tx(() => {
      if (task.parentId) this.store.updateTask(task.parentId, { progress: `子任务「${task.title}」重试中` });
      this.store.updateTask(taskId, { status: "running", loops, stageIdx: task.preset.stages.indexOf(stage), progress: "人工重试" });
      this.store.addEffect("launch", { taskId, stageIdx: task.preset.stages.indexOf(stage), note } satisfies LaunchPayload);
    });
    return true;
  }

  /** Human 「接受」 on a blocked review / test stage: count it as passed and continue */
  accept(taskId: number, note?: string): boolean {
    const task = this.store.getTask(taskId);
    const d = task && decideAccept(task, note);
    if (!task || !d) return false;
    this.store.tx(() => {
      if (task.parentId) this.store.updateTask(task.parentId, { progress: `子任务「${task.title}」已接受，继续` });
      this.applyDecision(task, d);
    });
    this.emitProgress(taskId);
    return true;
  }

  /** Queue human input for the task's next attempt; urgent = interrupt current run and resume */
  attach(taskId: number, text: string, urgent = false, raw?: string): boolean {
    const task = this.store.getTask(taskId);
    if (task?.kind === "loop") return this.loop.attach(taskId, text, urgent, raw);
    if (!task || TERMINAL.includes(task.status)) return false;
    this.store.updateTask(taskId, { inbox: [...task.inbox, text] });
    if (urgent) {
      for (const r of this.running.values()) {
        if (r.taskId === taskId) { (r as any).interrupt = true; this.exec.stop(r.sessionKey, r.cli); }
      }
    }
    return true;
  }

  start(): void {
    const rec = this.store.recover();
    if (rec.attempts || rec.effects) console.log(`[orc] recovered: ${rec.attempts} interrupted attempts, ${rec.effects} effects re-queued`);
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs ?? 1000);
  }

  async stopLoop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.inflight]);
  }

  /** True when nothing is running and no effect is pending */
  idle(): boolean {
    return this.running.size === 0 && this.inflight.size === 0 && this.store.pendingEffects().length === 0;
  }

  /** Drive until idle (CLI `orc run`); returns when all work settled */
  async runUntilIdle(pollMs = 1000): Promise<void> {
    this.store.recover();
    for (;;) {
      await this.tick();
      if (this.idle()) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  runningCount(role?: string): number {
    if (role) return this.busy.get(role)?.size ?? 0;
    let n = 0;
    for (const s of this.busy.values()) n += s.size;
    return n;
  }

  // ---- tick ---------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const e of this.store.dueEffects()) {
        if (e.kind === "notify") await this.runNotify(e);
        else if (e.kind === "launch") this.tryLaunch(e);
        else if (e.kind === "loop") {
          const pr = this.loop.handle(e);
          if (pr) { this.inflight.add(pr); void pr.finally(() => this.inflight.delete(pr)); }
        }
      }
    } catch (err) {
      console.error("[orc] tick error:", err);
    } finally {
      this.ticking = false;
    }
  }

  private async runNotify(e: Effect): Promise<void> {
    const p = e.payload as NotifyPayload;
    const task = this.store.getTask(p.taskId);
    if (!task) { this.store.markEffect(e.id, "done", { error: "task gone" }); return; }
    try {
      await this.opts.notify(task, p);
      this.store.markEffect(e.id, "done");
    } catch (err) {
      const tries = e.tries + 1;
      const msg = (err as Error).message;
      if (tries >= MAX_NOTIFY_TRIES) this.store.markEffect(e.id, "failed", { tries, error: msg });
      else this.store.markEffect(e.id, "pending", { tries, error: msg, nextAt: Date.now() + 2 ** tries * 1000 });
    }
  }

  private tryLaunch(e: Effect): void {
    const p = e.payload as LaunchPayload;
    const task = this.store.getTask(p.taskId);
    if (!task || TERMINAL.includes(task.status) || task.status === "waiting_children") {
      this.store.markEffect(e.id, "done", { error: `skipped: task ${task?.status ?? "missing"}` });
      return;
    }
    // Dependency gate (planner-split children)
    if (task.deps.length) {
      const deps = task.deps.map((id) => this.store.getTask(id)!).filter(Boolean);
      const gate = depsGate(deps);
      if (gate === "wait") {
        // a blocked dependency waits for a human: poll slowly
        const slow = deps.some((t) => t.status === "blocked");
        this.store.markEffect(e.id, "pending", { nextAt: Date.now() + (slow ? 15_000 : 3000) });
        return;
      }
      if (gate !== "go") {
        // dependency gave up → skip quietly; the parent sends one summary when all children settle
        this.store.tx(() => {
          this.applyDecision(task, { patch: { status: "dropped", progress: gate }, launches: [], notifies: [], children: [] });
          this.store.markEffect(e.id, "done", { error: gate });
        });
        this.emitProgress(task.id);
        return;
      }
    }
    const stage = task.preset.stages[p.stageIdx];
    const role = task.preset.roles[stage.role];
    const used = this.busy.get(role.name) ?? new Set<number>();
    let slot = -1;
    for (let i = 0; i < role.count; i++) if (!used.has(i)) { slot = i; break; }
    if (slot < 0) {
      // slots full: park it; a freed slot wakes it at once (the 2s retry is only a fallback)
      this.store.markEffect(e.id, "pending", { nextAt: Date.now() + 2000 });
      (this.slotWaiters.get(role.name) ?? this.slotWaiters.set(role.name, new Set()).get(role.name)!).add(e.id);
      return;
    }
    used.add(slot);
    this.busy.set(role.name, used);
    this.slotWaiters.get(role.name)?.delete(e.id);

    this.store.markEffect(e.id, "running");
    const pr = this.runAttempt(e, task, p, slot)
      .catch((err) => this.failLaunch(e, task, err))
      .finally(() => {
        used.delete(slot);
        this.inflight.delete(pr);
        const waiting = this.slotWaiters.get(role.name);
        if (waiting?.size) { this.store.wakeEffects([...waiting]); waiting.clear(); }
      });
    this.inflight.add(pr);
  }

  /** Infra failure before/around the agent run (git, prompt build…) */
  private failLaunch(e: Effect, task: Task, err: unknown): void {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[orc] task #${task.id} launch failed:`, msg);
    this.store.tx(() => {
      const fresh = this.store.getTask(task.id)!;
      this.applyDecision(fresh, decideAfterAttempt(fresh, { kind: "run_error", error: msg, timedOut: false }));
      this.store.markEffect(e.id, "done", { error: msg });
    });
  }

  // ---- one attempt --------------------------------------------------------

  private notesPath(task: Task): string {
    const key = `${basename(task.repo)}-${createHash("sha1").update(task.repo).digest("hex").slice(0, 8)}`;
    return resolve(this.opts.orcHome, "notes", `${key}.md`);
  }

  /** Create the task worktree on first use (shared with the loop engine) */
  prepareWorktree(task: Task): Task {
    if (task.worktree && existsSync(task.worktree)) return task;
    const path = wt.worktreePath(this.opts.orcHome, task.repo, task.title, task.id);
    const branch = wt.branchName(task.title, task.id);
    const depBranches = task.deps.map((id) => this.store.getTask(id)?.branch).filter((b): b is string => !!b);
    const base = depBranches[0] ? wt.headSha(task.repo, depBranches[0]) : task.baseRef;
    wt.ensureWorktree(task.repo, path, branch, base);
    const conflict = wt.mergeBranches(path, depBranches.slice(1));
    if (conflict) throw new Error(conflict);
    this.store.updateTask(task.id, { worktree: path, branch, baseRef: depBranches.length ? base : task.baseRef });
    return this.store.getTask(task.id)!;
  }

  private async runAttempt(e: Effect, task0: Task, launch: LaunchPayload, slot: number): Promise<void> {
    const task = this.prepareWorktree(task0);
    const stage = task.preset.stages[launch.stageIdx];
    const role = task.preset.roles[stage.role];
    const prior = this.store.listAttempts(task.id);
    const n = prior.filter((a) => a.stageId === stage.id).length + 1;
    const sessionKey = role.resume ? `orc:${task.id}#${role.name}` : `orc:${task.id}#${role.name}:${stage.id}:${n}`;
    const resumeSessionId = role.resume ? this.store.lastSessionId(sessionKey) : undefined;

    // Latest passing attempt of each earlier stage → history
    const history: Attempt[] = [];
    for (const s of task.preset.stages.slice(0, launch.stageIdx)) {
      const a = [...prior].reverse().find((x) => x.stageId === s.id && x.status === "done" && x.parsed);
      if (a) history.push(a);
    }
    const needsDiff = role.output === "verdict" || role.output === "test" || role.output === "report";
    const diff = needsDiff
      ? { ...wt.diffSince(task.worktree!, task.baseRef), log: wt.logSince(task.worktree!, task.baseRef) }
      : undefined;
    const notesPath = this.notesPath(task);
    const notesTail = existsSync(notesPath) ? readFileSync(notesPath, "utf8").split("\n").slice(-40).join("\n").trim() : "";
    const inbox = task.inbox;
    const prompt = buildStagePrompt({ task, stage, role, launch, history, diff, notesPath, notesTail, inbox });
    const instructions = await this.opts.instructionsFor?.(task);

    const attempt = this.store.tx(() => {
      if (inbox.length) this.store.updateTask(task.id, { inbox: [] });
      this.store.updateTask(task.id, { status: "running", stageIdx: launch.stageIdx, progress: `${stage.id} · ${role.name}#${slot + 1} 运行中` });
      return this.store.createAttempt({
        taskId: task.id, stageId: stage.id, role: role.name, slot, cli: role.cli, model: role.model ?? null,
        sessionKey, sessionId: resumeSessionId ?? null,
      });
    });
    const handle = { attemptId: attempt.id, taskId: task.id, role: role.name, cli: role.cli, sessionKey, cancelled: false, slot };
    this.running.set(attempt.id, handle);
    this.emitProgress(task.id);

    const artifactDir = resolve(this.opts.orcHome, "tasks", String(task.id));
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(resolve(artifactDir, `${attempt.id}-${stage.id}.prompt.md`), prompt);

    let lastWrite = 0;
    const throttle = this.opts.progressThrottleMs ?? 5000;
    const setProgress = (line: string) => {
      const now = Date.now();
      if (now - lastWrite < throttle) return;
      lastWrite = now;
      const text = `${stage.id} · ${role.name}#${slot + 1}：${line}`;
      this.store.updateAttempt(attempt.id, { progress: line });
      this.store.updateTask(task.id, { progress: text });
      this.emitProgress(task.id);
    };

    let result;
    try {
      result = await this.exec.run({
        cli: role.cli, model: role.model, prompt, sessionKey, resumeSessionId, cwd: task.worktree!,
        appendSystemPrompt: instructions, readOnly: role.isolation === "readonly", disallowedTools: role.disallowedTools,
        hardTimeoutMs: role.hardTimeoutMin * 60_000, staleTimeoutMs: role.staleTimeoutMin * 60_000,
        onProgress: setProgress,
        onText: (t) => { const p = lastProgressLine(t); if (p) setProgress(p); },
      });
    } catch (err) {
      result = { text: "", tokens: 0, timedOut: false, cancelled: false, error: (err as Error).message };
    } finally {
      this.running.delete(attempt.id);
    }
    writeFileSync(resolve(artifactDir, `${attempt.id}-${stage.id}.output.md`), result.text || result.error || "");

    // Enforce isolation on the worktree, then commit writers' work
    let violation = "";
    let sha: string | undefined;
    if (role.isolation === "readonly") {
      if (wt.isDirty(task.worktree!)) violation = wt.resetHard(task.worktree!);
    } else {
      sha = wt.commitAll(task.worktree!, `orc(#${task.id}) ${stage.id}: ${role.name} attempt ${n}`);
    }

    const interrupted = (handle as any).interrupt && !handle.cancelled;
    let outcome: Outcome;
    let parsed: any = null;
    if (handle.cancelled || (result.cancelled && !interrupted)) outcome = { kind: "cancelled" };
    else if (result.timedOut || result.error) outcome = { kind: "run_error", error: result.error || "timeout", timedOut: result.timedOut };
    else {
      const p = parseRoleOutput(role.output, result.text);
      if ("error" in p) outcome = { kind: "unparseable", error: p.error };
      else { parsed = p; outcome = { kind: "parsed", parsed: p }; }
    }

    let brief: Decision["brief"];
    this.store.tx(() => {
      this.store.updateAttempt(attempt.id, {
        status: interrupted || outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "run_error" ? "failed" : "done",
        output: result.text.slice(0, 200_000), parsed, error: result.error ?? "", sessionId: result.sessionId,
        tokens: result.tokens, endedAt: Date.now(),
        // finished attempts keep only the commit as their progress line (agent card / task card show it)
        progress: sha ? `提交 ${sha.slice(0, 7)}` : "",
      });
      const fresh = this.store.getTask(task.id)!;
      if (interrupted) {
        this.store.addEffect("launch", { taskId: task.id, stageIdx: launch.stageIdx, note: "你被人中途打断，请先阅读「新增输入」再继续。" } satisfies LaunchPayload);
      } else if (fresh.status === "dropped") {
        // stopped while running — nothing more to schedule
      } else {
        const prevParsed = [...prior].reverse().find((a) => a.stageId === stage.id && a.parsed && a.id !== attempt.id)?.parsed ?? undefined;
        const d = decideAfterAttempt(fresh, outcome, { prev: prevParsed });
        if (violation) d.notifies.push({ taskId: task.id, kind: "info", text: `${role.name} 是只读角色却修改了文件，已回滚：\n${violation.slice(0, 500)}` });
        this.applyDecision(fresh, d);
        brief = d.brief;
      }
      this.store.markEffect(e.id, "done");
    });
    if (parsed?.notes?.length) {
      appendFileSync(this.notesPath(task), parsed.notes.map((x: string) => `- [#${task.id} ${stage.id}/${role.name}] ${x}`).join("\n") + "\n");
    }
    this.emitProgress(task.id);
    if (brief) await this.writeBrief(task.id, brief);
  }

  /**
   * A stage used up its rework budget. Ask the advisor to write the decision brief (it sees every
   * attempt), then either keep going on its recommendation or block and post the brief.
   * No advisor configured → block with the reviewer's own summary + issues.
   */
  private async writeBrief(taskId: number, req: { stageIdx: number; mode?: "arbitrate" | "escalate"; rounds?: number }): Promise<void> {
    const stageIdx = req.stageIdx;
    const task = this.store.getTask(taskId);
    if (!task) return;
    const stage = task.preset.stages[stageIdx];
    const last = [...this.store.listAttempts(taskId)].reverse().find((a) => a.stageId === stage?.id && a.parsed);
    const role = await this.opts.briefRole?.(task);
    if (!role || !stage || task.status === "dropped") {
      const text = last ? `${stageName(stage.id)}连续没过：${last.parsed?.summary ?? ""}` : "任务卡住了，需要人看";
      this.store.tx(() => this.applyDecision(task, {
        patch: { status: "blocked", progress: text.slice(0, 120) }, launches: [], notifies: [{ taskId, kind: "decision", text }], children: [],
      }));
      this.emitProgress(taskId);
      return;
    }
    const n = this.store.listAttempts(taskId).filter((a) => a.stageId === "brief").length + 1;
    const sessionKey = `orc:${taskId}#advisor:${n}`;
    const attempt = this.store.tx(() => this.store.createAttempt({
      taskId, stageId: "brief", role: role.name, slot: 0, cli: role.cli, model: role.model ?? null, sessionKey, sessionId: null,
    }));
    const notesPath = this.notesPath(task);
    const prompt = buildBriefPrompt({
      task, role, stageName: stageName(stage.id), attempts: this.store.listAttempts(taskId), mode: req.mode, rounds: req.rounds,
      diff: task.worktree ? { ...wt.diffSince(task.worktree, task.baseRef, 60_000), log: wt.logSince(task.worktree, task.baseRef) } : undefined,
      notesPath, notesTail: existsSync(notesPath) ? readFileSync(notesPath, "utf8").split("\n").slice(-40).join("\n").trim() : "",
    });
    const res = await this.exec.run({
      cli: role.cli, model: role.model, prompt, sessionKey, cwd: task.worktree!,
      appendSystemPrompt: await this.opts.instructionsFor?.(task), readOnly: true,
      hardTimeoutMs: role.hardTimeoutMin * 60_000, staleTimeoutMs: role.staleTimeoutMin * 60_000,
      onProgress: (line) => { this.store.updateTask(taskId, { progress: `整理决策说明：${line}` }); this.emitProgress(taskId); },
    }).catch((err) => ({ text: "", tokens: 0, timedOut: false, cancelled: false, error: (err as Error).message }));

    const parsed = res.error || res.timedOut ? undefined : parseRoleOutput("brief", res.text);
    const bad = !parsed || "error" in parsed;
    this.store.tx(() => this.store.updateAttempt(attempt.id, {
      status: bad ? "failed" : "done", output: res.text.slice(0, 200_000), parsed: bad ? null : parsed,
      error: bad ? (res.error || (parsed as { error: string })?.error || "超时") : "", tokens: res.tokens, endedAt: Date.now(),
    }));
    if (bad) {
      const why = last?.parsed?.summary || "评审连续没过";
      this.store.tx(() => this.applyDecision(this.store.getTask(taskId)!, {
        patch: { status: "blocked", progress: `决策说明没写成：${why.slice(0, 100)}` }, launches: [], children: [],
        notifies: [{ taskId, kind: "decision", text: `**${task.title}：${stageName(stage.id)}反复没过，需要你定**\n\n${why}\n\n（决策说明没能生成：${res.error || "输出不合约定"}）` }],
      }));
      this.emitProgress(taskId);
      return;
    }
    const kept = knownIssues(parsed);
    const fresh = this.store.getTask(taskId)!;
    if (kept.length && fresh.status !== "dropped") {
      // advisor judged the leftovers acceptable to defer → framework continues, and says so
      const next = task.preset.stages[stageIdx + 1];
      const feedback = `【已知问题（人已被告知，可以以后再处理）】\n${kept.map((k) => `- ${k}`).join("\n")}`;
      this.store.tx(() => {
        this.store.updateTask(taskId, next
          ? { stageIdx: stageIdx + 1, status: "running", feedback, progress: "按决策说明的建议继续（带已知问题）" }
          : { stageIdx: stageIdx + 1, status: "ready", feedback, progress: "完成（带已知问题）" });
        if (next) this.store.addEffect("launch", { taskId, stageIdx: stageIdx + 1 } satisfies LaunchPayload);
        this.applyDecision(fresh, { patch: {}, launches: [], children: [], notifies: [{ taskId, kind: "info", text: renderAutoNote(task, parsed, kept) }] });
      });
    } else {
      this.store.tx(() => this.applyDecision(fresh, {
        patch: { status: "blocked", progress: `${stageName(stage.id)}反复没过，等你决定（决策说明见回复）` },
        launches: [], children: [], notifies: [{ taskId, kind: "decision", text: renderBrief(task, parsed, stageName(stage.id)) }],
      }));
    }
    this.emitProgress(taskId);
  }

  // ---- decisions ----------------------------------------------------------

  /** Persist a core decision (must run inside store.tx) */
  private applyDecision(task: Task, d: Decision): void {
    this.store.updateTask(task.id, d.patch as Partial<Task>);
    for (const l of d.launches) this.store.addEffect("launch", l);
    for (const n of d.notifies) {
      // a child waiting on a human: say what else is held up by it
      if (n.kind === "decision" && task.parentId) {
        const parent = this.store.getTask(task.parentId);
        const sibs = this.store.listTasks({ parentId: task.parentId }).filter((c) => c.id !== task.id && c.status !== "ready" && !["failed", "dropped"].includes(c.status));
        const held = sibs.filter((c) => dependsOn(c, task.id, sibs));
        if (parent) n.text += `\n\n这是「${parent.title}」的子任务${held.length ? `；${held.map((c) => c.title).join("、")} 要等它定下来才会开始` : ""}。`;
      }
      this.store.addEffect("notify", n);
    }

    if (d.children.length) {
      const start = childStartStage(task);
      const ids: number[] = [];
      for (const c of d.children) {
        const child = this.store.createTask({
          parentId: task.id, title: c.title, goal: task.goal, spec: c.spec, repo: task.repo, baseRef: task.baseRef,
          preset: task.preset, stageIdx: start, deps: c.deps.map((i) => ids[i]), chatId: task.chatId, bar: task.bar,
        });
        ids.push(child.id);
        this.store.addEffect("launch", { taskId: child.id, stageIdx: start } satisfies LaunchPayload);
      }
      this.store.addEffect("notify", {
        taskId: task.id, kind: "info",
        text: `已拆成 ${ids.length} 个子任务：\n` + d.children.map((c) => `- ${c.title}${c.deps.length ? `（依赖 ${c.deps.map((x) => d.children[x].title).join("、")}）` : ""}`).join("\n"),
      } satisfies NotifyPayload);
    }

    // A child reaching a terminal state may settle its parent
    const after = this.store.getTask(task.id)!;
    if (after.parentId && TERMINAL.includes(after.status)) {
      const parent = this.store.getTask(after.parentId);
      if (parent && parent.status === "waiting_children") {
        const pd = decideParent(parent, this.store.listTasks({ parentId: parent.id }));
        if (pd) this.applyDecision(parent, pd);
        else if (after.status === "blocked") this.store.updateTask(parent.id, { progress: `等你决定 ${after.title}` });
        if (pd || after.status === "blocked") this.emitProgress(parent.id);
      }
    }
  }

  private emitProgress(taskId: number): void {
    const t = this.store.getTask(taskId);
    if (t) try { this.opts.onProgress?.(t); } catch { /* sink errors must not break scheduling */ }
  }
}

/** A readable name when nobody supplied one: first clause, without the "在 … 工作区内" preamble */
export function shortTitle(goal: string): string {
  const line = (goal || "").split("\n").find((l) => l.trim()) ?? "";
  const t = line
    .replace(/^在\s*\S*\s*工作区(内|里)?[，,]?/, "")
    .replace(/^(请|麻烦|帮我|先)?(做|跑|写|改|查|看)(一下|一个|一份)?/, "")
    .split(/[。；;！!？?\n]/)[0]
    .split(/[，,、]/)[0]
    .trim();
  return (t || line.trim() || "任务").slice(0, 24);
}

/** `c` waits (directly or through other siblings) on task `id` */
function dependsOn(c: Task, id: number, sibs: Task[], seen = new Set<number>()): boolean {
  if (c.deps.includes(id)) return true;
  if (seen.has(c.id)) return false;
  seen.add(c.id);
  return c.deps.some((d) => { const s = sibs.find((x) => x.id === d); return !!s && dependsOn(s, id, sibs, seen); });
}
