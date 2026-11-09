// =============================================================================
// orc — SQLite store (node:sqlite, no extra dependency)
// =============================================================================
// tasks / attempts / effects. Effects are the durable outbox: written in the
// same transaction as the state change that caused them, executed after commit,
// retried with backoff, and re-queued on restart (001 §4.5).
// =============================================================================
import { DatabaseSync } from "node:sqlite";
import type { Attempt, Effect, EffectKind, LaunchPayload, NotifyPayload, ResolvedPreset, Task } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id INTEGER, title TEXT NOT NULL, goal TEXT NOT NULL, spec TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL, base_ref TEXT NOT NULL, branch TEXT, worktree TEXT,
  preset TEXT NOT NULL, stage_idx INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
  loops TEXT NOT NULL DEFAULT '{}', deps TEXT NOT NULL DEFAULT '[]',
  feedback TEXT NOT NULL DEFAULT '', inbox TEXT NOT NULL DEFAULT '[]',
  chat_id TEXT, progress TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL, stage_id TEXT NOT NULL, role TEXT NOT NULL, slot INTEGER NOT NULL,
  cli TEXT NOT NULL, model TEXT, session_key TEXT NOT NULL, session_id TEXT,
  status TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', parsed TEXT, error TEXT NOT NULL DEFAULT '',
  progress TEXT NOT NULL DEFAULT '', tokens INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_task ON attempts(task_id);
CREATE TABLE IF NOT EXISTS effects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS effects_due ON effects(status, next_at);
`;

const j = (s: string | null | undefined, d: any) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

function rowToTask(r: any): Task {
  return {
    id: r.id, parentId: r.parent_id ?? null, title: r.title, goal: r.goal, spec: r.spec,
    repo: r.repo, baseRef: r.base_ref, branch: r.branch ?? null, worktree: r.worktree ?? null,
    preset: j(r.preset, null) as ResolvedPreset, stageIdx: r.stage_idx, status: r.status,
    loops: j(r.loops, {}), deps: j(r.deps, []), feedback: r.feedback, inbox: j(r.inbox, []),
    chatId: r.chat_id ?? null, progress: r.progress, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function rowToAttempt(r: any): Attempt {
  return {
    id: r.id, taskId: r.task_id, stageId: r.stage_id, role: r.role, slot: r.slot, cli: r.cli,
    model: r.model ?? null, sessionKey: r.session_key, sessionId: r.session_id ?? null, status: r.status,
    output: r.output, parsed: j(r.parsed, null), error: r.error, progress: r.progress, tokens: r.tokens,
    startedAt: r.started_at, endedAt: r.ended_at ?? null,
  };
}

function rowToEffect(r: any): Effect {
  return {
    id: r.id, kind: r.kind, payload: j(r.payload, {}), status: r.status, tries: r.tries,
    nextAt: r.next_at, error: r.error, createdAt: r.created_at,
  };
}

const TASK_COLS: Record<string, string> = {
  title: "title", spec: "spec", branch: "branch", worktree: "worktree", stageIdx: "stage_idx",
  status: "status", loops: "loops", deps: "deps", feedback: "feedback", inbox: "inbox",
  chatId: "chat_id", progress: "progress", baseRef: "base_ref",
};
const ATTEMPT_COLS: Record<string, string> = {
  sessionId: "session_id", status: "status", output: "output", parsed: "parsed", error: "error",
  progress: "progress", tokens: "tokens", endedAt: "ended_at",
};
const enc = (v: any) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v);

export class OrcStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
  }

  /** Run fn in one transaction (nested calls join the outer one) */
  private depth = 0;
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  // ---- tasks ---------------------------------------------------------------

  createTask(t: {
    parentId?: number | null; title: string; goal: string; spec?: string; repo: string; baseRef: string;
    preset: ResolvedPreset; stageIdx?: number; deps?: number[]; chatId?: string | null; status?: Task["status"];
  }): Task {
    const now = Date.now();
    const r = this.db.prepare(
      `INSERT INTO tasks (parent_id,title,goal,spec,repo,base_ref,preset,stage_idx,status,deps,chat_id,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      t.parentId ?? null, t.title, t.goal, t.spec ?? "", t.repo, t.baseRef, JSON.stringify(t.preset),
      t.stageIdx ?? 0, t.status ?? "queued", JSON.stringify(t.deps ?? []), t.chatId ?? null, now, now,
    );
    return this.getTask(Number(r.lastInsertRowid))!;
  }

  getTask(id: number): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    return r ? rowToTask(r) : undefined;
  }

  listTasks(filter: { status?: string[]; parentId?: number; chatId?: string; limit?: number } = {}): Task[] {
    const where: string[] = [];
    const args: any[] = [];
    if (filter.status?.length) { where.push(`status IN (${filter.status.map(() => "?").join(",")})`); args.push(...filter.status); }
    if (filter.parentId != null) { where.push("parent_id=?"); args.push(filter.parentId); }
    if (filter.chatId != null) { where.push("chat_id=?"); args.push(filter.chatId); }
    const sql = `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${filter.limit ?? 200}`;
    return this.db.prepare(sql).all(...args).map(rowToTask);
  }

  updateTask(id: number, patch: Partial<Task>): void {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = TASK_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col}=?`);
      args.push(enc(v));
    }
    if (!sets.length) return;
    sets.push("updated_at=?");
    args.push(Date.now(), id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=?`).run(...args);
  }

  // ---- attempts ------------------------------------------------------------

  createAttempt(a: Omit<Attempt, "id" | "status" | "output" | "parsed" | "error" | "progress" | "tokens" | "startedAt" | "endedAt">): Attempt {
    const r = this.db.prepare(
      `INSERT INTO attempts (task_id,stage_id,role,slot,cli,model,session_key,session_id,status,started_at)
       VALUES (?,?,?,?,?,?,?,?,'running',?)`,
    ).run(a.taskId, a.stageId, a.role, a.slot, a.cli, a.model, a.sessionKey, a.sessionId, Date.now());
    return this.getAttempt(Number(r.lastInsertRowid))!;
  }

  getAttempt(id: number): Attempt | undefined {
    const r = this.db.prepare("SELECT * FROM attempts WHERE id=?").get(id);
    return r ? rowToAttempt(r) : undefined;
  }

  listAttempts(taskId: number): Attempt[] {
    return this.db.prepare("SELECT * FROM attempts WHERE task_id=? ORDER BY id").all(taskId).map(rowToAttempt);
  }

  runningAttempts(): Attempt[] {
    return this.db.prepare("SELECT * FROM attempts WHERE status='running' ORDER BY id").all().map(rowToAttempt);
  }

  /** Latest session id this task's role produced under a session key (for resume) */
  lastSessionId(sessionKey: string): string | undefined {
    const r: any = this.db.prepare(
      "SELECT session_id FROM attempts WHERE session_key=? AND session_id IS NOT NULL ORDER BY id DESC LIMIT 1",
    ).get(sessionKey);
    return r?.session_id ?? undefined;
  }

  updateAttempt(id: number, patch: Partial<Attempt>): void {
    const sets: string[] = [];
    const args: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = ATTEMPT_COLS[k];
      if (!col || v === undefined) continue;
      sets.push(`${col}=?`);
      args.push(enc(v));
    }
    if (!sets.length) return;
    args.push(id);
    this.db.prepare(`UPDATE attempts SET ${sets.join(",")} WHERE id=?`).run(...args);
  }

  // ---- effects (durable outbox) -------------------------------------------

  addEffect(kind: EffectKind, payload: LaunchPayload | NotifyPayload, delayMs = 0): number {
    const now = Date.now();
    const r = this.db.prepare("INSERT INTO effects (kind,payload,next_at,created_at) VALUES (?,?,?,?)")
      .run(kind, JSON.stringify(payload), now + delayMs, now);
    return Number(r.lastInsertRowid);
  }

  /** Make still-pending effects due now (e.g. launches parked on a full role) */
  wakeEffects(ids: number[]): void {
    const now = Date.now();
    const st = this.db.prepare("UPDATE effects SET next_at=? WHERE id=? AND status='pending' AND next_at>?");
    for (const id of ids) st.run(now, id, now);
  }

  dueEffects(limit = 100): Effect[] {
    return this.db.prepare("SELECT * FROM effects WHERE status='pending' AND next_at<=? ORDER BY id LIMIT ?")
      .all(Date.now(), limit).map(rowToEffect);
  }

  pendingEffects(): Effect[] {
    return this.db.prepare("SELECT * FROM effects WHERE status IN ('pending','running') ORDER BY id").all().map(rowToEffect);
  }

  markEffect(id: number, status: Effect["status"], extra: { error?: string; nextAt?: number; tries?: number; payload?: any } = {}): void {
    const cur: any = this.db.prepare("SELECT * FROM effects WHERE id=?").get(id);
    if (!cur) return;
    this.db.prepare("UPDATE effects SET status=?, error=?, next_at=?, tries=?, payload=? WHERE id=?").run(
      status, extra.error ?? cur.error, extra.nextAt ?? cur.next_at, extra.tries ?? cur.tries,
      extra.payload ? JSON.stringify(extra.payload) : cur.payload, id,
    );
  }

  /** Drop not-yet-started launches of a task (stop / drop) */
  cancelPendingLaunches(taskId: number): number {
    let n = 0;
    for (const e of this.pendingEffects()) {
      if (e.kind === "launch" && e.status === "pending" && e.payload.taskId === taskId) {
        this.markEffect(e.id, "done", { error: "cancelled" });
        n++;
      }
    }
    return n;
  }

  /**
   * Crash recovery: attempts left "running" by a dead process become
   * "interrupted", and their launch effects go back to pending with recover=true.
   */
  recover(): { attempts: number; effects: number } {
    return this.tx(() => {
      const a = this.db.prepare("UPDATE attempts SET status='interrupted', ended_at=? WHERE status='running'").run(Date.now());
      let effects = 0;
      for (const e of this.db.prepare("SELECT * FROM effects WHERE status='running'").all().map(rowToEffect)) {
        this.markEffect(e.id, "pending", { payload: { ...e.payload, recover: true }, nextAt: Date.now() });
        effects++;
      }
      return { attempts: Number(a.changes), effects };
    });
  }

  close(): void { this.db.close(); }
}
