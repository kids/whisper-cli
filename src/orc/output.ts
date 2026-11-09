// =============================================================================
// orc — tolerant structured-output parsing (one parser for every CLI)
// =============================================================================
// Each role ends its final message with a JSON object (fenced or bare). We scan
// all candidate objects from the end and take the last one carrying the key the
// role's OutputKind requires. Works without --json-schema, so any CLI can play
// any role.
// =============================================================================
import type { OutputKind } from "./types";

export interface PlanSubtask { title: string; spec: string; deps: number[] }

export interface ParsedOutput {
  kind: OutputKind;
  pass: boolean;
  summary: string;
  notes: string[];
  value: any;
  /** plan only */
  spec?: string;
  subtasks?: PlanSubtask[];
}

const REQUIRED_KEY: Record<OutputKind, string> = {
  plan: "spec",
  impl: "status",
  verdict: "verdict",
  test: "pass",
  report: "summary",
  action: "action",
};

/** Every balanced top-level {...} in the text (string-aware), in order of appearance */
export function findJsonObjects(text: string): any[] {
  const out: any[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const ch = text[j];
      if (esc) { esc = false; continue; }
      if (inStr) { if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    try {
      const v = JSON.parse(text.slice(i, j + 1));
      if (v && typeof v === "object" && !Array.isArray(v)) { out.push(v); i = j; }
    } catch { /* not JSON — keep scanning inside */ }
  }
  return out;
}

const str = (v: any) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v));
const strList = (v: any): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);

export function parseRoleOutput(kind: OutputKind, text: string): ParsedOutput | { error: string } {
  const key = REQUIRED_KEY[kind];
  const candidates = findJsonObjects(text || "").filter((o) => key in o);
  const v = candidates[candidates.length - 1];
  if (!v) return { error: `最后的回复里没有包含 "${key}" 字段的 JSON 对象` };
  const notes = strList(v.notes);
  const summary = str(v.summary);

  switch (kind) {
    case "plan": {
      if (typeof v.spec !== "string" || !v.spec.trim()) return { error: `"spec" 必须是非空字符串` };
      const subtasks: PlanSubtask[] = Array.isArray(v.subtasks)
        ? v.subtasks
            .filter((s: any) => s && typeof s.title === "string")
            .map((s: any) => ({
              title: s.title.trim(),
              spec: str(s.spec).trim() || s.title.trim(),
              deps: Array.isArray(s.deps) ? s.deps.map(Number).filter((n: number) => Number.isInteger(n)) : [],
            }))
        : [];
      // deps are indices into subtasks; drop forward/self/out-of-range refs (keeps the DAG acyclic)
      subtasks.forEach((s, i) => { s.deps = [...new Set(s.deps.filter((d) => d >= 0 && d < i))]; });
      return { kind, pass: true, summary: summary || v.spec.slice(0, 200), notes, value: v, spec: v.spec.trim(), subtasks };
    }
    case "impl": {
      const status = str(v.status).toLowerCase();
      if (status !== "done" && status !== "blocked") return { error: `"status" 必须是 "done" 或 "blocked"` };
      return { kind, pass: status === "done", summary, notes, value: v };
    }
    case "verdict": {
      const verdict = str(v.verdict).toLowerCase();
      if (verdict !== "approve" && verdict !== "revise") return { error: `"verdict" 必须是 "approve" 或 "revise"` };
      return { kind, pass: verdict === "approve", summary, notes, value: { ...v, issues: Array.isArray(v.issues) ? v.issues : [] } };
    }
    case "test": {
      if (typeof v.pass !== "boolean") return { error: `"pass" 必须是布尔值` };
      return { kind, pass: v.pass, summary, notes, value: { ...v, cases: Array.isArray(v.cases) ? v.cases : [] } };
    }
    case "report": {
      if (!summary.trim()) return { error: `"summary" 必须是非空字符串` };
      return { kind, pass: true, summary, notes, value: v };
    }
    case "action": {
      // validated by the loop's own action parser (ledger.ts)
      return { kind, pass: true, summary: str(v.action), notes, value: v };
    }
  }
}

/** Human-readable feedback block for the next attempt after a failed verdict/test */
export function formatFeedback(stageId: string, p: ParsedOutput): string {
  const lines = [`【${stageId} 未通过】${p.summary}`.trim()];
  if (p.kind === "verdict") {
    for (const it of p.value.issues.slice(0, 30)) {
      if (typeof it === "string") { lines.push(`- ${it}`); continue; }
      const loc = it.file ? ` (${it.file}${it.line ? ":" + it.line : ""})` : "";
      lines.push(`- [${it.severity ?? "issue"}]${loc} ${str(it.desc ?? it.description ?? it.issue ?? it.text ?? it)}`);
    }
  } else if (p.kind === "test") {
    for (const c of p.value.cases.filter((c: any) => c && c.result !== "pass" && c.pass !== true).slice(0, 30)) {
      lines.push(`- ✗ ${str(c.name ?? c.case ?? "case")}: ${str(c.detail ?? c.error ?? c.result ?? "")}`.trim());
    }
  }
  return lines.join("\n");
}

/** `[[progress]] …` milestone lines an agent may emit while working (002 §3.1) */
export function lastProgressLine(text: string): string | undefined {
  const m = [...(text || "").matchAll(/\[\[progress\]\]\s*(.+)/g)];
  return m.length ? m[m.length - 1][1].trim().slice(0, 200) : undefined;
}
