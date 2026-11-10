// =============================================================================
// orc CLI — local entry point (debugging / PoC). Feishu is just another entry.
// =============================================================================
//   npm run orc -- presets
//   npm run orc -- submit --repo <path> [--preset dev] [--patch '<json>'] [--title t] "<goal>"
//   npm run orc -- run                 drive the scheduler until all work settles
//   npm run orc -- status [id]
//   npm run orc -- stop <id> | retry <id> [note] | attach <id> <text>
// State: $ORC_HOME (default ~/.orc): orc.db, worktrees/, tasks/<id>/, notes/
// =============================================================================
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadAllAgents, loadGlobalConfig, parseEnvFile } from "../config";
import { applyPatch, fallbackNote, loadPresets, loadRoles, presetSummary, resolvePreset } from "./config";
import { CliExecutor } from "./runner";
import { Orchestrator } from "./scheduler";
import { OrcStore } from "./store";
import type { PresetPatch, Task } from "./types";

export const ORC_HOME = process.env.ORC_HOME || resolve(process.env.HOME || "/root", ".orc");

function parseArgs(argv: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      flags[k] = v ?? argv[++i] ?? "";
    } else pos.push(a);
  }
  return { pos, flags };
}

function fmtTask(t: Task): string {
  const stage = t.preset.stages[t.stageIdx]?.id ?? "end";
  return `#${t.id}${t.parentId ? ` (←#${t.parentId})` : ""} [${t.status}] ${t.preset.name}@${stage}  ${t.title}\n    ${t.progress}`;
}

function build() {
  mkdirSync(ORC_HOME, { recursive: true });
  const envPath = resolve(import.meta.dirname, "../../.env");
  const env = parseEnvFile(envPath);
  const agents = loadAllAgents(envPath);
  const exec = new CliExecutor(agents, loadGlobalConfig(env));
  const store = new OrcStore(resolve(ORC_HOME, "orc.db"));
  const orc = new Orchestrator(store, exec, {
    orcHome: ORC_HOME,
    notify: async (task, n) => console.log(`\n🔔 [${n.kind}] #${task.id} ${task.title}\n${n.text}\n`),
    onProgress: (t) => console.log(`… #${t.id} ${t.progress}`),
  });
  return { store, exec, orc };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  const roles = loadRoles();
  const presets = loadPresets();

  if (cmd === "presets") {
    for (const p of presets.values()) {
      try { console.log(`${presetSummary(resolvePreset(p, roles))}\n    ${p.description}`); }
      catch (e) { console.log(`${p.name}: INVALID ${(e as Error).message}`); }
    }
    return;
  }

  const { store, exec, orc } = build();

  if (cmd === "submit") {
    const goal = pos.join(" ").trim();
    if (!goal) throw new Error("usage: submit --repo <path> [--preset dev] \"<goal>\"");
    const base = presets.get(flags.preset || "dev");
    if (!base) throw new Error(`unknown preset ${flags.preset}`);
    const patch: PresetPatch = flags.patch ? JSON.parse(flags.patch) : {};
    const preset = resolvePreset(applyPatch(base, patch, presets), roles, { availableClis: exec.available() });
    const task = orc.submit({ goal, title: flags.title, repo: resolve(flags.repo || process.cwd()), preset });
    const fb = fallbackNote(preset);
    console.log(`submitted ${fmtTask(task)}\n    ${presetSummary(preset)}${fb ? `\n    ${fb}` : ""}`);
    return;
  }

  if (cmd === "run") {
    const stop = () => { console.log("\n[orc] interrupted — running attempts will be recovered on next run"); process.exit(130); };
    process.on("SIGINT", stop);
    await orc.runUntilIdle();
    console.log("[orc] idle");
    for (const t of store.listTasks({ limit: 10 })) console.log(fmtTask(t));
    return;
  }

  if (cmd === "status") {
    if (pos[0]) {
      const t = store.getTask(Number(pos[0]));
      if (!t) throw new Error(`no task ${pos[0]}`);
      console.log(fmtTask(t));
      console.log(`    ${presetSummary(t.preset)}\n    branch=${t.branch} worktree=${t.worktree}\n    loops=${JSON.stringify(t.loops)}`);
      if (t.feedback) console.log(`    feedback:\n${t.feedback.replace(/^/gm, "      ")}`);
      for (const a of store.listAttempts(t.id)) {
        const dur = a.endedAt ? `${Math.round((a.endedAt - a.startedAt) / 1000)}s` : "running";
        console.log(`  - a${a.id} ${a.stageId}/${a.role}#${a.slot + 1} ${a.cli}${a.model ? ":" + a.model : ""} [${a.status}] ${dur} tok=${a.tokens} pass=${a.parsed?.pass ?? "-"}  ${(a.parsed?.summary || a.error || "").slice(0, 120)}`);
      }
      for (const c of store.listTasks({ parentId: t.id })) console.log("  child " + fmtTask(c));
    } else {
      for (const t of store.listTasks({ limit: 30 })) console.log(fmtTask(t));
    }
    return;
  }

  if (cmd === "stop") { console.log(orc.stop(Number(pos[0])) ? "stopped" : "not found"); return; }
  if (cmd === "retry") { console.log(orc.retry(Number(pos[0]), pos.slice(1).join(" ") || undefined) ? "re-queued (run `orc run`)" : "not retryable"); return; }
  if (cmd === "attach") { console.log(orc.attach(Number(pos[0]), pos.slice(1).join(" "), flags.urgent === "true") ? "queued for next attempt" : "not attachable"); return; }

  console.log("commands: presets | submit | run | status [id] | stop <id> | retry <id> [note] | attach <id> <text> [--urgent true]");
}

main().catch((e) => { console.error(`orc: ${(e as Error).message}`); process.exit(1); });
