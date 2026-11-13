// =============================================================================
// orc — how a role reports back (one parser for every CLI)
// =============================================================================
// Judgment stages answer with ONE conclusion line plus free prose:
//   impl    [[done]] 改了 A、B          [[blocked]] 缺 key
//   verdict [[approve]] 能用            [[revise]] 归一化丢方向
//   test    [[pass]] 全绿              [[fail]] 用例 3 没过
//   report  [[report]] 一句话摘要
// Problem lists are comparable one-per-line entries ([[major]] / [[minor]]),
// notes for the shared file are [[note]]. Everything else is prose.
// plan / brief / loop actions still answer in JSON — the engine builds tasks,
// renders the decision note and executes actions out of those fields.
// =============================================================================
import type { OutputKind } from "./types";

export interface PlanSubtask { title: string; spec: string; deps: number[] }
export interface Issue { severity: "major" | "minor"; file?: string; line?: number; desc: string }

export interface ParsedOutput {
  kind: OutputKind;
  pass: boolean;
  summary: string;
  /** `[[note]]` lines — appended to the team notes file */
  notes: string[];
  /** the reply without protocol lines: what the role actually wrote */
  body: string;
  /** verdict only: comparable problem list, in the order it was written */
  issues?: Issue[];
  /** plan only */
  spec?: string;
  subtasks?: PlanSubtask[];
  /** brief only */
  value?: any;
}

interface Spec { yes: string; no?: string }

/** Stages that answer with a conclusion line, and the words they may use */
const CONCL: Partial<Record<OutputKind, Spec>> = {
  impl: { yes: "done", no: "blocked" },
  verdict: { yes: "approve", no: "revise" },
  test: { yes: "pass", no: "fail" },
  report: { yes: "report" },
};

/** Stages that answer in JSON: the fields below are consumed by the engine */
const JSON_KEY: Partial<Record<OutputKind, string>> = {
  plan: "spec",
  brief: "situation",
  action: "action",
};

const LINE = /^\s*\[\[([a-z_]+)\]\]\s*(.*)$/i;

/** What a role must put in its reply, in the words a retry note should use */
export function conclusionHint(kind: OutputKind): string {
  const m = CONCL[kind];
  return m
    ? `单独一行 [[${m.yes}]] 一句话${m.no ? `（或 [[${m.no}]] 一句话）` : ""}`
    : `一个包含 "${JSON_KEY[kind]}" 字段的 JSON 对象`;
}

export function parseRoleOutput(kind: OutputKind, text: string): ParsedOutput | { error: string } {
  const spec = CONCL[kind];
  return spec ? parseConclusionReply(kind, spec, text) : parseJsonReply(kind, text);
}

function parseConclusionReply(kind: OutputKind, spec: Spec, text: string): ParsedOutput | { error: string } {
  let marker: { tag: string; said: string } | undefined;
  const notes: string[] = [];
  const issues: Issue[] = [];
  const body: string[] = [];
  for (const line of (text || "").split(/\r?\n/)) {
    const m = line.match(LINE);
    if (!m) { body.push(line); continue; }
    const tag = m[1].toLowerCase();
    const said = m[2].trim();
    if (tag === spec.yes || tag === spec.no) marker = { tag, said };
    else if (tag === "note") { if (said) notes.push(said); }
    else if (tag === "major" || tag === "minor") { if (said) issues.push(issueOf(tag, said)); }
    // other [[…]] lines (progress / watch / image …) are not part of the prose
  }
  if (!marker) return { error: `最后的回复里没有结论 —— 应为${conclusionHint(kind)}` };
  const prose = body.join("\n").trim();
  const firstLine = prose.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? "";
  const summary = (marker.said || firstLine).slice(0, kind === "report" ? 4000 : 600);
  return {
    kind,
    pass: kind === "report" ? true : marker.tag === spec.yes,
    summary: kind === "report" ? (marker.said || prose.slice(0, 4000)) : summary,
    notes,
    body: prose,
    ...(kind === "verdict" ? { issues } : {}),
  };
}

/** `[[major]] src/a.py:88 描述` → a comparable issue */
function issueOf(severity: "major" | "minor", said: string): Issue {
  const m = said.match(/^(\S+?):(\d+)\s+(.+)$/);
  return m ? { severity, file: m[1], line: Number(m[2]), desc: m[3] } : { severity, desc: said };
}

// ---- JSON answers (plan / brief / loop action) -------------------------------

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

function parseJsonReply(kind: OutputKind, text: string): ParsedOutput | { error: string } {
  const key = JSON_KEY[kind]!;
  const candidates = findJsonObjects(text || "").filter((o) => key in o);
  const v = candidates[candidates.length - 1];
  if (!v) return { error: `最后的回复里没有包含 "${key}" 字段的 JSON 对象` };
  const notes = strList(v.notes);
  const summary = str(v.summary);
  const body = (text || "").trim();

  if (kind === "plan") {
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
    return { kind, pass: true, summary: summary || v.spec.slice(0, 200), notes, body, spec: v.spec.trim(), subtasks };
  }
  if (kind === "brief") {
    if (typeof v.situation !== "string" || !v.situation.trim()) return { error: `"situation" 必须是非空字符串` };
    return { kind, pass: true, summary: v.situation.trim(), notes, body, value: v };
  }
  // action: validated by the loop's own action parser (ledger.ts)
  return { kind, pass: true, summary: str(v.action), notes, body, value: v };
}

/** Feedback block for the next attempt after a failed review / test */
export function formatFeedback(stageId: string, p: ParsedOutput, only?: Issue[]): string {
  const list = only ?? p.issues ?? [];
  const lines = [`【${stageId} 未通过】${p.summary}`.trim()];
  for (const it of list.slice(0, 30)) lines.push(`- ${it.file ? `${it.file}${it.line ? ":" + it.line : ""} ` : ""}${it.desc}`);
  // no comparable problem list (test stage, or prose-only review): hand over what the role wrote
  if (!list.length && p.body) lines.push("", p.body.length > 2000 ? `${p.body.slice(0, 2000)}\n…（正文已截断）` : p.body);
  return lines.join("\n");
}

/** `[[progress]] …` milestone lines an agent may emit while working (002 §3.1) */
export function lastProgressLine(text: string): string | undefined {
  const m = [...(text || "").matchAll(/\[\[progress\]\]\s*(.+)/g)];
  return m.length ? m[m.length - 1][1].trim().slice(0, 200) : undefined;
}
