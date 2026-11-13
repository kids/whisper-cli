// Offline checks for the `[[...]]` protocol markers, no LLM:
//   1) 文档里的标记表和源码里的标记必须一致（加了标记忘了登记、或登记了没有实现，都报错）
//   2) 一个标记只属于一层（L1 交付 / L2 流程 / L3 记账），不能跨层复用
//   3) 越界不生效：每个解析器只认自己那层的词，别人的标记原样留在正文里
//   npx tsx scripts/marker_check.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) passed++; else { failed++; console.log(`FAIL ${name}`, detail ?? ""); }
}

const ROOT = resolve(import.meta.dirname, "..");
const DOC = join(ROOT, "docs/ARCHITECTURE.md");
const MARK = /\[\[([a-z_]+)\]\]/g;

function markersIn(text: string): string[] {
  return [...text.matchAll(MARK)].map((m) => m[1]);
}

// ---- 1) 文档表 ↔ 源码 --------------------------------------------------------
const doc = readFileSync(DOC, "utf8");
const section = doc.slice(doc.indexOf("## 8. 协议标记"), doc.indexOf("## 9. 主要环境变量"));

interface Row { layer: string; text: string }
const rows: Row[] = [];
let layer = "";
for (const line of section.split("\n")) {
  if (!line.trim().startsWith("|")) continue;
  const cells = line.split("|").slice(1, -1).map((c) => c.trim());
  if (!cells.length) continue;
  if (/^层$/.test(cells[0]) || /^-+$/.test(cells[0])) continue; // header / separator
  if (cells[0]) layer = cells[0];
  if (layer) rows.push({ layer, text: cells[1] ?? "" });
}
const documented = new Map<string, Set<string>>();
for (const r of rows) for (const m of markersIn(r.text)) {
  if (!documented.has(m)) documented.set(m, new Set());
  documented.get(m)!.add(r.layer);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|md|yaml|yml)$/.test(name)) out.push(p);
  }
  return out;
}
const sourceFiles = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "orc"))];
const inSource = new Set<string>();
for (const f of sourceFiles) for (const m of markersIn(readFileSync(f, "utf8"))) inSource.add(m);
const inDoc = new Set(documented.keys());

check("每个标记都在文档里登记了", [...inSource].every((m) => inDoc.has(m)), [...inSource].filter((m) => !inDoc.has(m)));
check("文档里登记的标记都有实现", [...inDoc].every((m) => inSource.has(m)), [...inDoc].filter((m) => !inSource.has(m)));
check("一个标记只属于一层", [...documented].every(([, s]) => s.size === 1), [...documented].filter(([, s]) => s.size > 1).map(([m, s]) => `${m}: ${[...s].join("/")}`));
check("标记总数不为零（表被解析到了）", documented.size >= 20, documented.size);

// ---- 2) 越界不生效 -----------------------------------------------------------
const L = await import("../src/orc/ledger");
const { parseRoleOutput } = await import("../src/orc/output");
const { parseBrief } = await import("../src/orc/brief");
const { extractSendOps } = await import("../src/outgoing");
const { extractMemoryOps } = await import("../src/memory");
const { extractWatchOps } = await import("../src/watch");
const { extractTaskOps } = await import("../src/orc/route");

const loopMarker = "[[instruct]]\n把 X 改成 Y";
const stageMarker = "[[done]] 写完了";

check("监督者不认阶段结论", L.parseSignal(stageMarker) === undefined, L.parseSignal(stageMarker));
check("监督者不认附件标记", L.parseSignal("[[image]] a.png") === undefined);
check("阶段结论不认监督者动作", "error" in parseRoleOutput("impl", loopMarker), parseRoleOutput("impl", loopMarker));
check("阶段结论不认附件标记", "error" in parseRoleOutput("impl", "[[file]] a.zip"), parseRoleOutput("impl", "[[file]] a.zip"));
check("决策说明不吞别人的标记", (() => { const b = parseBrief(loopMarker); return !b.auto && b.text.includes("[[instruct]]"); })(), parseBrief(loopMarker));
check("发包不吞监督者标记", (() => { const r = extractSendOps(loopMarker); return !r.ops.length && r.text.includes("[[instruct]]"); })(), extractSendOps(loopMarker));
check("记忆不吞监督者标记", (() => { const r = extractMemoryOps(loopMarker); return !r.remember.length && !r.forget.length && r.text.includes("[[instruct]]"); })(), extractMemoryOps(loopMarker));
check("监控不吞监督者标记", (() => { const r = extractWatchOps(loopMarker); return !r.add.length && !r.remove.length && r.text.includes("[[instruct]]"); })(), extractWatchOps(loopMarker));
check("转交不吞附件标记", (() => { const r = extractTaskOps("[[image]] a.png\n继续"); return !r.ops.length && r.text.includes("[[image]]"); })(), extractTaskOps("[[image]] a.png\n继续"));
check("发包认自己的标记", extractSendOps("[[image]] /tmp/a.png").ops.length === 1);
check("转交认自己的标记", extractTaskOps('[[task]] {"goal":"x"}').ops.length === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
