// Live check: does a real agent follow the [[image]] / [[file]] hint? (codebuddy, no Feishu)
//   npx tsx scripts/outgoing_agent_check.ts [model]
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadAllAgents } from "../src/config";
import { runCodebuddy } from "../src/ai/codebuddy";
import { extractSendOps, formatSendHint, resolveOutgoing, sendRoots } from "../src/outgoing";

const model = process.argv[2];
const cfg = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!.codebuddy!;
const cases: { msg: string; images: number; files: string[] }[] = [
  { msg: "用 python 画一张 sin(x) 在 0~2π 的曲线图发到群里", images: 1, files: [] },
  { msg: "写一个简短的 html 页面介绍令牌桶算法，发给我", images: 0, files: [".html"] },
  { msg: "把令牌桶和漏桶的对比整理成一份 markdown 文件发群里", images: 0, files: [".md"] },
];

let failed = 0;
await Promise.all(cases.map(async (c, i) => {
  const ws = mkdtempSync(join(tmpdir(), `outgoing-agent-${i}-`));
  try {
    const res = await runCodebuddy({
      prompt: c.msg, chatId: `outgoing-agent-${i}`, config: cfg, workdir: ws, model, resumeSession: false,
      appendSystemPrompt: formatSendHint(), hardTimeoutMs: 6 * 60_000,
    });
    const { ops, text } = extractSendOps(res.text);
    const out = resolveOutgoing(ops, { cwd: ws, roots: sendRoots([ws]), fallbackText: text });
    const exts = out.files.map((f) => f.filePath.slice(f.filePath.lastIndexOf(".")));
    const ok = out.images.length === c.images && c.files.every((e) => exts.includes(e)) && !out.notes.length;
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${c.msg}\n   ops=${JSON.stringify(ops)} images=${out.images.length} files=${exts.join(",")} notes=${out.notes.join(" | ")}\n   reply: ${text.replace(/\n/g, " ").slice(0, 160)}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}));
console.log(failed ? `\n${failed}/${cases.length} FAILED` : `\n${cases.length}/${cases.length} ok`);
process.exit(failed ? 1 : 0);
