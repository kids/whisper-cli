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
import { childStartStage, decideAfterAttempt, decideParent, depsGate, type Decision, type Outcome } from "./core";
import { parseRoleOutput, lastProgressLine } from "./output";
import { buildStagePrompt } from "./prompts";
import type { Executor } from "./runner";
import type { OrcStore } from "./store";
import type { Attempt, Effect, LaunchPayload, NotifyPayload, ResolvedPreset, Task } from "./types";
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
  tickMs?: number;
  progressThrottleMs?: number;
}

const MAX_NOTIFY_TRIES = 5;

export class Orchestrator {
  private running = new Map<number, { attemptId: number; taskId: number; role: string; cli: Attempt["cli"]; sessionKey: string; cancelled: boolean }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private inflight = new Set<Promise<void>>();
  /** role → busy slot indices; reserved synchronously at launch so one tick can't over-commit */
  private busy = new Map<string, Set<number>>();

  constructor(readonly store: OrcStore, private exec: Executor, private opts: OrchestratorOptions) {
    mkdirSync(resolve(opts.orcHome, "notes"), { recursive: true });
    mkdirSync(resolve(opts.orcHome, "tasks"), { recursive: true });
  }

  // ---- public API ---------------------------------------------------------

  submit(input: { goal: string; title?: string; repo: string; preset: ResolvedPreset; chatId?: string | null }): Task {
    const root = wt.repoRoot(input.repo);
    if (!root) throw new Error(`${input.repo} is not inside a git repository (orc needs git worktrees)`);
    const baseRef = wt.headSha(root);
    return this.store.tx(() => {
      const task = this.store.createTask({
        title: input.title || input.goal.split("\n")[0].slice(0, 60), goal: input.goal, repo: root, baseRef,
        preset: input.preset, chatId: input.chatId ?? null,
      });
      this.store.addEffect("launch", { taskId: task.id, stageIdx: 0 } satisfies LaunchPayload);
      return task;
    });
  }

  /** Stop a task: cancel queued launches, kill its running session, mark dropped */
  stop(taskId: number): boolean {
    const task = this.store.getTask(taskId);
    if (!task) return false;
    this.store.tx(() => {
      this.store.cancelPendingLaunches(taskId);
      for (const child of this.store.listTasks({ parentId: taskId })) {
        if (!TERMINAL.includes(child.status)) this.stop(child.id);
      }
      if (!TERMINAL.includes(task.status)) this.store.updateTask(taskId, { status: "dropped", progress: "已被用户终止" });
    });
    for (const r of this.running.values()) {
      if (r.taskId === taskId) { r.cancelled = true; this.exec.stop(r.sessionKey, r.cli); }
    }
    return true;
  }

  /** Resume a blocked/failed task at its current stage with fresh loop budget */
  retry(taskId: number, note?: string): boolean {
    const task = this.store.getTask(taskId);
    if (!task || !["blocked", "failed", "dropped"].includes(task.status)) return false;
    const stage = task.preset.stages[Math.min(task.stageIdx, task.preset.stages.length - 1)];
    const loops = { ...task.loops };
    for (const k of Object.keys(loops)) if (k === stage.id || k.endsWith(`:${stage.id}`)) delete loops[k];
    this.store.tx(() => {
      this.store.updateTask(taskId, { status: "running", loops, stageIdx: task.preset.stages.indexOf(stage), progress: "人工重试" });
      this.store.addEffect("launch", { taskId, stageIdx: task.preset.stages.indexOf(stage), note } satisfies LaunchPayload);
    });
    return true;
  }

  /** Queue human input for the task's next attempt; urgent = interrupt current run and resume */
  attach(taskId: number, text: string, urgent = false): boolean {
    const task = this.store.getTask(taskId);
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
      const gate = depsGate(task.deps.map((id) => this.store.getTask(id)!).filter(Boolean));
      if (gate === "wait") { this.store.markEffect(e.id, "pending", { nextAt: Date.now() + 3000 }); return; }
      if (gate !== "go") {
        this.store.tx(() => {
          this.applyDecision(task, { patch: { status: "blocked", progress: gate }, launches: [], notifies: [{ taskId: task.id, kind: "decision", text: gate }], children: [] });
          this.store.markEffect(e.id, "done", { error: gate });
        });
        return;
      }
    }
    const stage = task.preset.stages[p.stageIdx];
    const role = task.preset.roles[stage.role];
    const used = this.busy.get(role.name) ?? new Set<number>();
    let slot = -1;
    for (let i = 0; i < role.count; i++) if (!used.has(i)) { slot = i; break; }
    if (slot < 0) { this.store.markEffect(e.id, "pending", { nextAt: Date.now() + 2000 }); return; }
    used.add(slot);
    this.busy.set(role.name, used);

    this.store.markEffect(e.id, "running");
    const pr = this.runAttempt(e, task, p, slot)
      .catch((err) => this.failLaunch(e, task, err))
      .finally(() => { used.delete(slot); this.inflight.delete(pr); });
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

  private prepareWorktree(task: Task): Task {
    if (task.worktree && existsSync(task.worktree)) return task;
    const path = wt.worktreePath(this.opts.orcHome, task.repo, task.id);
    const branch = wt.branchName(task.id);
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
    if (role.isolation === "readonly") {
      if (wt.isDirty(task.worktree!)) violation = wt.resetHard(task.worktree!);
    } else {
      wt.commitAll(task.worktree!, `orc(#${task.id}) ${stage.id}: ${role.name} attempt ${n}`);
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

    this.store.tx(() => {
      this.store.updateAttempt(attempt.id, {
        status: interrupted || outcome.kind === "cancelled" ? "cancelled" : outcome.kind === "run_error" ? "failed" : "done",
        output: result.text.slice(0, 200_000), parsed, error: result.error ?? "", sessionId: result.sessionId,
        tokens: result.tokens, endedAt: Date.now(),
      });
      const fresh = this.store.getTask(task.id)!;
      if (interrupted) {
        this.store.addEffect("launch", { taskId: task.id, stageIdx: launch.stageIdx, note: "你被人中途打断，请先阅读「新增输入」再继续。" } satisfies LaunchPayload);
      } else if (fresh.status === "dropped") {
        // stopped while running — nothing more to schedule
      } else {
        const d = decideAfterAttempt(fresh, outcome);
        if (violation) d.notifies.push({ taskId: task.id, kind: "info", text: `${role.name} 是只读角色却修改了文件，已回滚：\n${violation.slice(0, 500)}` });
        this.applyDecision(fresh, d);
      }
      this.store.markEffect(e.id, "done");
    });
    if (parsed?.notes?.length) {
      appendFileSync(this.notesPath(task), parsed.notes.map((x: string) => `- [#${task.id} ${stage.id}/${role.name}] ${x}`).join("\n") + "\n");
    }
    if (role.output === "test" && parsed?.value?.cases?.length) {
      appendFileSync(resolve(artifactDir, "cases.jsonl"), parsed.value.cases.map((c: any) => JSON.stringify({ attempt: attempt.id, ...c })).join("\n") + "\n");
    }
    this.emitProgress(task.id);
  }

  // ---- decisions ----------------------------------------------------------

  /** Persist a core decision (must run inside store.tx) */
  private applyDecision(task: Task, d: Decision): void {
    this.store.updateTask(task.id, d.patch as Partial<Task>);
    for (const l of d.launches) this.store.addEffect("launch", l);
    for (const n of d.notifies) this.store.addEffect("notify", n);

    if (d.children.length) {
      const start = childStartStage(task);
      const ids: number[] = [];
      for (const c of d.children) {
        const child = this.store.createTask({
          parentId: task.id, title: c.title, goal: task.goal, spec: c.spec, repo: task.repo, baseRef: task.baseRef,
          preset: task.preset, stageIdx: start, deps: c.deps.map((i) => ids[i]), chatId: task.chatId,
        });
        ids.push(child.id);
        this.store.addEffect("launch", { taskId: child.id, stageIdx: start } satisfies LaunchPayload);
      }
      this.store.addEffect("notify", {
        taskId: task.id, kind: "info",
        text: `已拆成 ${ids.length} 个子任务：\n` + d.children.map((c, i) => `- #${ids[i]} ${c.title}${c.deps.length ? `（依赖 ${c.deps.map((x) => "#" + ids[x]).join(",")}）` : ""}`).join("\n"),
      } satisfies NotifyPayload);
    }

    // A child reaching a terminal state may settle its parent
    const after = this.store.getTask(task.id)!;
    if (after.parentId && TERMINAL.includes(after.status)) {
      const parent = this.store.getTask(after.parentId);
      if (parent && parent.status === "waiting_children") {
        const pd = decideParent(parent, this.store.listTasks({ parentId: parent.id }));
        if (pd) this.applyDecision(parent, pd);
      }
    }
  }

  private emitProgress(taskId: number): void {
    const t = this.store.getTask(taskId);
    if (t) try { this.opts.onProgress?.(t); } catch { /* sink errors must not break scheduling */ }
  }
}
