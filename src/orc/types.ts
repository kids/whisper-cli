// =============================================================================
// orc — shared types (docs/orc/001, 002)
// =============================================================================

export type CliName = "codebuddy" | "codex" | "claude" | "gemini" | "cursor" | "pi";

/** What a role's final message must contain; drives the pass rule in core */
export type OutputKind = "plan" | "impl" | "verdict" | "test" | "report" | "action" | "brief";

export type Isolation =
  | "worktree"  // writes in the task worktree; changes are committed after the attempt
  | "readonly"  // must not modify the worktree (enforced: dirty tree is reset + flagged)
  | "fresh";    // like worktree, but never resumes a previous session

export interface RoleDef {
  name: string;
  description: string;
  cli: CliName;
  model?: string;
  output: OutputKind;
  isolation: Isolation;
  /** Resume the role's previous session on this task (rework) instead of a fresh one */
  resume: boolean;
  disallowedTools?: string[];
  hardTimeoutMin: number;
  staleTimeoutMin: number;
  /** Role prompt body (markdown below the frontmatter) */
  prompt: string;
}

export interface StageDef {
  id: string;
  role: string;
  /** Stage id to jump back to when this stage does not pass */
  onFail?: string;
  /** Max times this stage may fail before the task is blocked (needs a human) */
  maxLoops?: number;
  /** Optional stages are skipped unless enabled in the preset/patch */
  optional?: boolean;
  /** Verdict is recorded but never gates (review-only presets) */
  advisory?: boolean;
}

export interface PresetRoleSlot {
  count: number;
  cli?: CliName;
  model?: string;
}

export interface PresetDef {
  name: string;
  description: string;
  /** pipeline = linear stages (core.ts); loop = supervisor ReAct loop (loop.ts) */
  kind?: "pipeline" | "loop";
  roles: Record<string, PresetRoleSlot>;
  stages: StageDef[];
  /** Optional stage ids switched on */
  enabled?: string[];
  loop?: LoopConfig;
}

export type Verbosity = "quiet" | "normal" | "verbose";

/** Supervisor-loop settings (preset `loop:` block) */
export interface LoopConfig {
  /** role names (must be declared in the preset's roles) */
  supervisor: string;
  worker: string;
  reviewer?: string;
  /** finish needs a passing review at the current HEAD */
  requireReview: boolean;
  verbosity: Verbosity;
  budget: LoopBudget;
}

export interface LoopBudget {
  /** supervisor decisions (rejected ones count too) */
  maxSteps: number;
  maxWorkerRuns: number;
  /** time spent deciding/executing — waits and open questions do not count */
  maxActiveHours: number;
}

/** Bounded edits a lead agent / user may request (002 §5.3) */
export interface PresetPatch {
  preset?: string;
  roles?: Record<string, Partial<PresetRoleSlot> | null>; // null = remove role (and its stages)
  enable?: string[];
  disable?: string[];
  maxLoops?: Record<string, number>;
}

export type ResolvedRole = RoleDef & { count: number };

/** Fully resolved snapshot frozen into each task at creation */
export interface ResolvedPreset {
  name: string;
  version: number;
  kind: "pipeline" | "loop";
  roles: Record<string, ResolvedRole>;
  /** Only active stages (optional ones not enabled are dropped); empty for loop presets */
  stages: StageDef[];
  loop?: LoopConfig;
  /** Roles whose default CLI was not configured and ran on another one (config.ts resolvePreset) */
  fallbacks?: { role: string; from: string; to: string }[];
}

export type TaskStatus =
  | "queued"            // waiting for deps / a slot
  | "running"
  | "waiting"           // loop task parked on a watch (training, batch job…)
  | "waiting_children"  // planner split it; children are running
  | "ready"             // all stages passed — awaiting human acceptance
  | "blocked"           // needs a human decision
  | "failed"
  | "dropped";

export const TERMINAL: TaskStatus[] = ["ready", "blocked", "failed", "dropped"];

export interface Task {
  id: number;
  kind: "pipeline" | "loop";
  parentId: number | null;
  title: string;
  goal: string;
  spec: string;
  /** 评审口径: how strict review should be for this task, in the lead agent's words (empty → default) */
  bar?: string;
  /** human = a person asked for it; agent = an agent handed the work over on its own */
  origin?: "human" | "agent";
  repo: string;
  baseRef: string;
  branch: string | null;
  worktree: string | null;
  preset: ResolvedPreset;
  stageIdx: number;
  status: TaskStatus;
  loops: Record<string, number>;
  /** 挂起的重新安排（JSON：{stageId, feedback, reason}），当前这一步跑完后生效 */
  replan: string;
  deps: number[];
  /** Latest failing verdict/test report fed back to the next attempt */
  feedback: string;
  /** Human input queued while an attempt was running (002 §3.3) */
  inbox: string[];
  chatId: string | null;
  progress: string;
  createdAt: number;
  updatedAt: number;
}

export type AttemptStatus = "running" | "done" | "failed" | "interrupted" | "cancelled";

export interface Attempt {
  id: number;
  taskId: number;
  stageId: string;
  role: string;
  slot: number;
  cli: CliName;
  model: string | null;
  sessionKey: string;
  sessionId: string | null;
  status: AttemptStatus;
  output: string;
  parsed: any;
  error: string;
  progress: string;
  tokens: number;
  startedAt: number;
  endedAt: number | null;
}

export type EffectKind = "launch" | "notify" | "loop";

/** One supervisor round for a loop task */
export interface LoopPayload {
  taskId: number;
  /** why this round runs: start / next / human / watch / heartbeat / ask_timeout / resume */
  reason: string;
  /** reason-specific reference: ask step (ask_timeout) / watch id (heartbeat) */
  ref?: number;
  recover?: boolean;
}
export type EffectStatus = "pending" | "running" | "done" | "failed";

export interface Effect {
  id: number;
  kind: EffectKind;
  payload: any;
  status: EffectStatus;
  tries: number;
  nextAt: number;
  error: string;
  createdAt: number;
}

export interface LaunchPayload {
  taskId: number;
  stageIdx: number;
  /** Set when re-launched after a crash/restart (001 §4.5 recovery note) */
  recover?: boolean;
  /** Extra one-shot note for this launch (e.g. "last run timed out") */
  note?: string;
  /** Continue the stage's previous session (the role stopped without finishing) */
  resume?: boolean;
}

/** ready/decision/failed/info: pipeline + loop finals; turn/report/ask/constraints: loop rounds (002 IM visibility) */
export type NotifyKind = "ready" | "decision" | "failed" | "info" | "turn" | "report" | "ask" | "constraints";

export interface NotifyPayload {
  taskId: number;
  kind: NotifyKind;
  text: string;
  /** loop "turn": the round it summarises (its thread card gets finalised with the text) */
  round?: number;
}
