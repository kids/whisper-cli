// =============================================================================
// orc — role library + preset loading, patch application and validation
// =============================================================================
// Roles:   orc/roles/<name>.md      YAML frontmatter + prompt body (human-maintained)
// Presets: orc/presets/<name>.yaml  roles x count + linear stages with bounded loops
// A lead agent may only *select and adjust* (PresetPatch); it never invents roles
// (002 §5). Everything goes through resolvePreset() before it can run.
// =============================================================================
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  CliName, LoopConfig, OutputKind, Isolation, PresetDef, PresetPatch, ResolvedPreset, RoleDef, StageDef, Verbosity,
} from "./types";

export const ORC_CONFIG_DIR = resolve(import.meta.dirname, "../../orc");

const CLIS: CliName[] = ["codebuddy", "codex", "claude", "gemini", "cursor", "pi"];
const OUTPUTS: OutputKind[] = ["plan", "impl", "verdict", "test", "report", "action", "brief"];
const ISOLATIONS: Isolation[] = ["worktree", "readonly", "fresh"];
export const MAX_ROLE_COUNT = 8;
export const MAX_LOOPS_CAP = 500;

export function parseRoleMarkdown(name: string, src: string): RoleDef {
  const m = src.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) throw new Error(`role ${name}: missing YAML frontmatter`);
  const fm = (parseYaml(m[1]) ?? {}) as Record<string, any>;
  const role: RoleDef = {
    name,
    description: String(fm.description ?? ""),
    cli: (fm.cli ?? "codebuddy") as CliName,
    model: fm.model ? String(fm.model) : undefined,
    output: fm.output as OutputKind,
    isolation: (fm.isolation ?? "worktree") as Isolation,
    resume: Boolean(fm.resume ?? false),
    disallowedTools: Array.isArray(fm.disallowed_tools) ? fm.disallowed_tools.map(String) : undefined,
    hardTimeoutMin: Number(fm.hard_timeout_min ?? 30),
    staleTimeoutMin: Number(fm.stale_timeout_min ?? 10),
    prompt: m[2].trim(),
  };
  if (!CLIS.includes(role.cli)) throw new Error(`role ${name}: unknown cli "${role.cli}"`);
  if (!OUTPUTS.includes(role.output)) throw new Error(`role ${name}: output must be one of ${OUTPUTS.join("/")}`);
  if (!ISOLATIONS.includes(role.isolation)) throw new Error(`role ${name}: isolation must be one of ${ISOLATIONS.join("/")}`);
  if (!(role.hardTimeoutMin > 0 && role.staleTimeoutMin > 0)) throw new Error(`role ${name}: timeouts must be > 0`);
  if (!role.prompt) throw new Error(`role ${name}: empty prompt body`);
  return role;
}

export function loadRoles(dir = resolve(ORC_CONFIG_DIR, "roles")): Map<string, RoleDef> {
  const roles = new Map<string, RoleDef>();
  if (!existsSync(dir)) return roles;
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const name = basename(f, ".md");
    roles.set(name, parseRoleMarkdown(name, readFileSync(resolve(dir, f), "utf8")));
  }
  return roles;
}

export function parsePresetYaml(src: string): PresetDef {
  const y = (parseYaml(src) ?? {}) as Record<string, any>;
  const stages: StageDef[] = (y.stages ?? []).map((s: any) => ({
    id: String(s.id),
    role: String(s.role),
    onFail: s.on_fail != null ? String(s.on_fail) : undefined,
    maxLoops: s.max_loops != null ? Number(s.max_loops) : undefined,
    optional: Boolean(s.optional ?? false),
    advisory: Boolean(s.advisory ?? false),
  }));
  const roles: PresetDef["roles"] = {};
  for (const [k, v] of Object.entries<any>(y.roles ?? {})) {
    roles[k] = { count: Number(v?.count ?? 1), cli: v?.cli, model: v?.model };
  }
  const kind = y.kind === "loop" ? "loop" : "pipeline";
  let loop: LoopConfig | undefined;
  if (kind === "loop") {
    const l = y.loop ?? {};
    const b = l.budget ?? {};
    loop = {
      supervisor: String(l.supervisor ?? "supervisor"),
      worker: String(l.worker ?? "implementer"),
      reviewer: l.reviewer ? String(l.reviewer) : undefined,
      requireReview: Boolean(l.require_review ?? false),
      verbosity: (["quiet", "normal", "verbose"].includes(l.verbosity) ? l.verbosity : "normal") as Verbosity,
      budget: {
        maxSteps: Number(b.max_steps ?? 60),
        maxWorkerRuns: Number(b.max_worker_runs ?? 25),
        maxActiveHours: Number(b.max_active_hours ?? 8),
      },
    };
  }
  return {
    name: String(y.name ?? ""),
    description: String(y.description ?? ""),
    kind,
    roles,
    stages,
    enabled: Array.isArray(y.enabled) ? y.enabled.map(String) : [],
    loop,
  };
}

export function loadPresets(dir = resolve(ORC_CONFIG_DIR, "presets")): Map<string, PresetDef> {
  const presets = new Map<string, PresetDef>();
  if (!existsSync(dir)) return presets;
  for (const f of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const p = parsePresetYaml(readFileSync(resolve(dir, f), "utf8"));
    if (!p.name) p.name = basename(f).replace(/\.ya?ml$/, "");
    presets.set(p.name, p);
  }
  return presets;
}

/** Apply a bounded patch. Pure; throws on anything outside the allowed edit surface. */
export function applyPatch(base: PresetDef, patch: PresetPatch, presets: Map<string, PresetDef>): PresetDef {
  let src = base;
  if (patch.preset && patch.preset !== base.name) {
    const p = presets.get(patch.preset);
    if (!p) throw new Error(`unknown preset "${patch.preset}"`);
    src = p;
  }
  const out: PresetDef = structuredClone(src);
  out.enabled = [...(out.enabled ?? [])];

  for (const [role, edit] of Object.entries(patch.roles ?? {})) {
    if (edit === null) {
      delete out.roles[role];
      out.stages = out.stages.filter((s) => s.role !== role);
      continue;
    }
    const cur = out.roles[role] ?? { count: 1 };
    const next = { ...cur, ...edit, count: Number(edit.count ?? cur.count) };
    if (edit.cli && edit.cli !== cur.cli && edit.model === undefined) delete next.model; // model ids are per-CLI
    out.roles[role] = next;
  }
  for (const id of patch.enable ?? []) {
    if (!out.stages.some((s) => s.id === id && s.optional)) throw new Error(`"${id}" is not an optional stage of ${out.name}`);
    if (!out.enabled.includes(id)) out.enabled.push(id);
  }
  for (const id of patch.disable ?? []) out.enabled = out.enabled.filter((x) => x !== id);
  for (const [id, n] of Object.entries(patch.maxLoops ?? {})) {
    const st = out.stages.find((s) => s.id === id);
    if (!st) throw new Error(`unknown stage "${id}"`);
    st.maxLoops = n;
  }
  return out;
}

/**
 * Validate and freeze a preset into a task snapshot. Throws listing every problem found.
 * `availableClis` is also the fallback order: a role whose *default* CLI (from orc/roles) is
 * not configured here runs on the first available one instead, with that CLI's default model
 * (see `fallbacks`). A CLI chosen explicitly (preset slot / patch) is never swapped — that errors.
 */
export function resolvePreset(
  def: PresetDef,
  roles: Map<string, RoleDef>,
  opts: { version?: number; availableClis?: CliName[] } = {},
): ResolvedPreset {
  const errs: string[] = [];
  const resolvedRoles: ResolvedPreset["roles"] = {};
  const fallbacks: NonNullable<ResolvedPreset["fallbacks"]> = [];
  const avail = opts.availableClis;
  for (const [name, slot] of Object.entries(def.roles)) {
    const role = roles.get(name);
    if (!role) { errs.push(`role "${name}" is not in the role library (orc/roles)`); continue; }
    let cli = (slot.cli ?? role.cli) as CliName;
    if (!CLIS.includes(cli)) errs.push(`role "${name}": unknown cli "${cli}"`);
    if (avail && !avail.includes(cli)) {
      if (!slot.cli && avail.length) {
        fallbacks.push({ role: name, from: cli, to: avail[0] });
        cli = avail[0];
      } else {
        errs.push(`role "${name}": cli "${cli}" is not configured${avail.length ? ` (available: ${avail.join(", ")})` : " (no CLI is configured)"}`);
      }
    }
    if (!(Number.isInteger(slot.count) && slot.count >= 1 && slot.count <= MAX_ROLE_COUNT)) {
      errs.push(`role "${name}": count must be 1..${MAX_ROLE_COUNT}`);
    }
    // A role's default model belongs to its default CLI: switching CLI without naming a
    // model means "that CLI's default" (cursor → auto), not e.g. a codebuddy model id.
    // Cursor always defaults to "auto" (Cursor picks the model).
    const model = slot.model ?? (cli === role.cli ? role.model : undefined) ?? (cli === "cursor" ? "auto" : undefined);
    resolvedRoles[name] = { ...role, cli, model, count: slot.count };
  }
  const enabled = new Set(def.enabled ?? []);
  if (def.kind === "loop") {
    const l = def.loop;
    if (!l) errs.push("loop preset needs a loop: block");
    else {
      for (const [k, r] of [["supervisor", l.supervisor], ["worker", l.worker], ["reviewer", l.reviewer]] as const) {
        if (r && !resolvedRoles[r] && !errs.some((e) => e.includes(`"${r}"`))) errs.push(`loop.${k}: role "${r}" not declared in preset roles`);
      }
      const b = l.budget;
      if (!(b.maxSteps >= 1 && b.maxSteps <= 500)) errs.push("loop.budget.max_steps must be 1..500");
      if (!(b.maxWorkerRuns >= 1 && b.maxWorkerRuns <= 200)) errs.push("loop.budget.max_worker_runs must be 1..200");
      if (!(b.maxActiveHours > 0 && b.maxActiveHours <= 72)) errs.push("loop.budget.max_active_hours must be (0, 72]");
      if (l.requireReview && !l.reviewer) errs.push("loop.require_review needs loop.reviewer");
    }
    if (errs.length) throw new Error(`invalid preset "${def.name}":\n- ${errs.join("\n- ")}`);
    return {
      name: def.name, version: opts.version ?? 1, kind: "loop", roles: resolvedRoles, stages: [], loop: structuredClone(l),
      ...(fallbacks.length ? { fallbacks } : {}),
    };
  }
  const stages = def.stages.filter((s) => !s.optional || enabled.has(s.id));
  if (!stages.length) errs.push("preset has no active stages");
  const ids = stages.map((s) => s.id);
  if (new Set(ids).size !== ids.length) errs.push("duplicate stage ids");
  stages.forEach((s, i) => {
    if (!resolvedRoles[s.role] && roles.has(s.role)) errs.push(`stage "${s.id}": role "${s.role}" not declared in preset roles`);
    if (!roles.has(s.role)) errs.push(`stage "${s.id}": role "${s.role}" is not in the role library`);
    if (s.onFail != null) {
      const j = ids.indexOf(s.onFail);
      if (j < 0) errs.push(`stage "${s.id}": on_fail "${s.onFail}" is not an active stage`);
      else if (j > i) errs.push(`stage "${s.id}": on_fail must point backwards`);
      // max_loops is optional: absent means the engine default (500)
      if (s.maxLoops != null && !(Number.isInteger(s.maxLoops) && s.maxLoops >= 1 && s.maxLoops <= MAX_LOOPS_CAP)) {
        errs.push(`stage "${s.id}": max_loops must be 1..${MAX_LOOPS_CAP}`);
      }
    }
  });
  if (errs.length) throw new Error(`invalid preset "${def.name}":\n- ${errs.join("\n- ")}`);
  return { name: def.name, version: opts.version ?? 1, kind: "pipeline", roles: resolvedRoles, stages, ...(fallbacks.length ? { fallbacks } : {}) };
}

/** 「本机没有 codebuddy：critic、implementer 改用 codex（默认模型）」; "" when nothing fell back */
export function fallbackNote(p: ResolvedPreset): string {
  if (!p.fallbacks?.length) return "";
  const groups = new Map<string, string[]>();
  for (const f of p.fallbacks) {
    const k = `${f.from}→${f.to}`;
    groups.set(k, [...(groups.get(k) ?? []), f.role]);
  }
  return [...groups].map(([k, rs]) => {
    const [from, to] = k.split("→");
    return `本机没有配置 ${from}：${rs.join("、")} 改用 ${to}（${to === "cursor" ? "auto" : "默认模型"}）`;
  }).join("；");
}

/** One-line summary for cards / announcement, e.g. "dev: plan[planner/codebuddy] → impl[implementer/codebuddy]×3 → …" */
export function presetSummary(p: ResolvedPreset): string {
  const rl = (name?: string) => {
    const r = name ? p.roles[name] : undefined;
    return r ? `${r.name}/${r.cli}${r.model ? ":" + r.model : ""}` : "-";
  };
  if (p.kind === "loop" && p.loop) {
    return `${p.name}: 监督[${rl(p.loop.supervisor)}] ⇄ 执行[${rl(p.loop.worker)}]${p.loop.reviewer ? ` · 审查[${rl(p.loop.reviewer)}]` : ""}`;
  }
  const parts = p.stages.map((s) => {
    const r = p.roles[s.role];
    const n = r.count > 1 ? `×${r.count}` : "";
    return `${s.id}[${r.name}/${r.cli}${r.model ? ":" + r.model : ""}]${n}`;
  });
  return `${p.name}: ${parts.join(" → ")}`;
}
