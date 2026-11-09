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
  CliName, OutputKind, Isolation, PresetDef, PresetPatch, ResolvedPreset, RoleDef, StageDef,
} from "./types";

export const ORC_CONFIG_DIR = resolve(import.meta.dirname, "../../orc");

const CLIS: CliName[] = ["codebuddy", "codex", "claude", "gemini", "cursor", "pi"];
const OUTPUTS: OutputKind[] = ["plan", "impl", "verdict", "test", "report"];
const ISOLATIONS: Isolation[] = ["worktree", "readonly", "fresh"];
export const MAX_ROLE_COUNT = 8;
export const MAX_LOOPS_CAP = 10;

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
  return {
    name: String(y.name ?? ""),
    description: String(y.description ?? ""),
    roles,
    stages,
    enabled: Array.isArray(y.enabled) ? y.enabled.map(String) : [],
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

/** Validate and freeze a preset into a task snapshot. Throws listing every problem found. */
export function resolvePreset(
  def: PresetDef,
  roles: Map<string, RoleDef>,
  opts: { version?: number; availableClis?: CliName[] } = {},
): ResolvedPreset {
  const errs: string[] = [];
  const resolvedRoles: ResolvedPreset["roles"] = {};
  for (const [name, slot] of Object.entries(def.roles)) {
    const role = roles.get(name);
    if (!role) { errs.push(`role "${name}" is not in the role library (orc/roles)`); continue; }
    const cli = (slot.cli ?? role.cli) as CliName;
    if (!CLIS.includes(cli)) errs.push(`role "${name}": unknown cli "${cli}"`);
    if (opts.availableClis && !opts.availableClis.includes(cli)) errs.push(`role "${name}": cli "${cli}" is not configured`);
    if (!(Number.isInteger(slot.count) && slot.count >= 1 && slot.count <= MAX_ROLE_COUNT)) {
      errs.push(`role "${name}": count must be 1..${MAX_ROLE_COUNT}`);
    }
    // A role's default model belongs to its default CLI: switching CLI without naming a
    // model means "that CLI's default" (cursor → auto), not e.g. a codebuddy model id.
    const model = slot.model ?? (cli === role.cli ? role.model : undefined);
    resolvedRoles[name] = { ...role, cli, model, count: slot.count };
  }
  const enabled = new Set(def.enabled ?? []);
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
      if (!(Number.isInteger(s.maxLoops) && s.maxLoops! >= 1 && s.maxLoops! <= MAX_LOOPS_CAP)) {
        errs.push(`stage "${s.id}": on_fail requires max_loops 1..${MAX_LOOPS_CAP} (no unbounded loops)`);
      }
    }
  });
  if (errs.length) throw new Error(`invalid preset "${def.name}":\n- ${errs.join("\n- ")}`);
  return { name: def.name, version: opts.version ?? 1, roles: resolvedRoles, stages };
}

/** One-line summary for cards / announcement, e.g. "dev: plan[planner/codebuddy] → impl[implementer/codebuddy]×3 → …" */
export function presetSummary(p: ResolvedPreset): string {
  const parts = p.stages.map((s) => {
    const r = p.roles[s.role];
    const n = r.count > 1 ? `×${r.count}` : "";
    return `${s.id}[${r.name}/${r.cli}${r.model ? ":" + r.model : ""}]${n}`;
  });
  return `${p.name}: ${parts.join(" → ")}`;
}
