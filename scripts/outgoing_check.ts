// Offline checks for src/outgoing.ts ([[image]] / [[file]] → attachments).
//   npx tsx scripts/outgoing_check.ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractSendOps, formatSendHint, resolveOutgoing, secretReason, sendRoots } from "../src/outgoing";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`, ok ? "" : JSON.stringify(detail ?? ""));
  if (!ok) failed++;
};

const ws = mkdtempSync(join(tmpdir(), "outgoing-ws-"));
const outside = mkdtempSync(join(tmpdir(), "outgoing-out-"));
const w = (p: string, data: string | Buffer = "x") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, data); return p; };
const png = w(join(ws, "out", "plot.png"), Buffer.from("89504e47", "hex"));
const html = w(join(ws, "report.html"), "<h1>hi</h1>");
const md = w(join(ws, "notes 2026.md"), "# notes");
const svg = w(join(ws, "chart.svg"), "<svg/>");
w(join(ws, ".env"), "SECRET=1");
w(join(ws, "deploy", "id_rsa"), "k");
w(join(ws, "home", ".ssh", "config"), "k");
w(join(ws, "server.pem"), "k");
w(join(ws, "empty.png"), "");
const big = w(join(ws, "big.png"), Buffer.alloc(11 * 1024 * 1024, 1));
const far = w(join(outside, "leak.txt"), "x");
symlinkSync(far, join(ws, "link.txt"));

// ---- parsing ----
{
  const reply = [
    "图画好了，结论是 loss 在第 3 轮后收敛。",
    "[[image]] /x/out/plot.png",
    "  `[[file]] report.html`",
    "- [[文件]] \"notes 2026.md\"",
    "[[图片]] chart.svg",
    "```",
    "[[image]] /in/code/block.png",
    "```",
    "[[image]]",
    "收尾一句",
  ].join("\n");
  const r = extractSendOps(reply);
  check("ops parsed (aliases, backticks, list marker, quotes)", JSON.stringify(r.ops) === JSON.stringify([
    { kind: "image", raw: "/x/out/plot.png" }, { kind: "file", raw: "report.html" }, { kind: "file", raw: "\"notes 2026.md\"" }, { kind: "image", raw: "chart.svg" },
  ]), r.ops);
  check("op lines stripped, fenced lines kept", !/\[\[(image|file|文件|图片)\]\] (\/x|report|"notes|chart)/.test(r.text) && r.text.includes("/in/code/block.png") && r.text.startsWith("图画好了") && r.text.endsWith("收尾一句"), r.text);
  check("inline mention not an op", extractSendOps("用 [[image]] 加路径就能发图").ops.length === 0);
}

// ---- resolution ----
const res = (lines: string[], fallbackText?: string) => resolveOutgoing(extractSendOps(lines.join("\n")).ops, { cwd: ws, roots: [ws], fallbackText });
{
  const r = res([`[[image]] ${png}`, "[[file]] report.html", '[[file]] "notes 2026.md"']);
  check("image + html + md (relative to workspace, quoted with space)", r.images.length === 1 && r.images[0].filePath === png && r.files.map((f) => f.fileName).join() === "report.html,notes 2026.md" && !r.notes.length, r);
  check("files carry real paths", r.files[0].filePath === html && r.files[1].filePath === md);
}
{
  const r = res(["[[image]] chart.svg"]);
  check("non-image via [[image]] → sent as file with note", r.files[0]?.filePath === svg && !r.images.length && /不是图片格式/.test(r.notes[0] ?? ""), r);
}
{
  const r = res([`[[image]] ${big}`]);
  check("image > 10MB → sent as file with note", r.files[0]?.filePath === big && /超过 10MB/.test(r.notes[0] ?? ""), r);
}
{
  const r = res(["[[file]] .env", "[[file]] deploy/id_rsa", "[[file]] home/.ssh/config", "[[file]] server.pem"]);
  check("secrets refused", !r.files.length && r.notes.length === 4 && r.notes.every((n) => /不发送/.test(n)), r.notes);
}
{
  const r = res([`[[file]] ${far}`, "[[file]] link.txt"]);
  check("outside roots refused (incl. symlink escape)", !r.files.length && r.notes.length === 2 && r.notes.every((n) => /不在允许发送的目录里/.test(n)), r.notes);
}
{
  const r = res(["[[file]] nope.csv", "[[image]] empty.png", `[[file]] ${ws}`]);
  check("missing / empty / directory → notes", !r.files.length && !r.images.length && /不存在/.test(r.notes[0]) && /空的/.test(r.notes[1]) && /不是普通文件/.test(r.notes[2]), r.notes);
}
{
  const r = res([`[[image]] ${png}`, "[[image]] out/plot.png", `[[file]] ${png}`]);
  check("deduped by real path", r.images.length === 1 && !r.files.length && !r.notes.length, r);
}
{
  const many = Array.from({ length: 12 }, (_, i) => w(join(ws, "many", `f${i}.txt`)));
  const r = res(many.map((p) => `[[file]] ${p}`));
  check("max 10 per reply", r.files.length === 10 && r.notes.length === 2 && /最多/.test(r.notes[0]), r.notes);
}
{
  const text = `图在 ${png}，报告在 ${html}，配置 ${join(ws, ".env")}，大图 ${big}`;
  const r = res([], text);
  check("fallback: bare image path sent quietly; bare files / big images not", r.images.length === 1 && r.images[0].filePath === png && !r.files.length && !r.notes.length, r);
  const r2 = resolveOutgoing([], { cwd: ws, roots: [ws], fallbackText: `见 ${join(outside, "x.png")}` });
  check("fallback: outside roots ignored silently", !r2.images.length && !r2.notes.length);
}
{
  check("sendRoots never '/' and includes tmp", (() => { const r = sendRoots(["/", ws, undefined, "/no/such/dir"]); return !r.includes("/") && r.some((x) => x === ws || ws.startsWith(x)); })());
  check("secretReason basics", !!secretReason("/a/.env.local") && !!secretReason("/a/.git/config") && !secretReason("/a/report.md") && !secretReason("/a/env.md"));
  const h = formatSendHint();
  check("hint explains protocol + limits", h.includes("[[image]]") && h.includes("[[file]]") && /不要自己调用飞书/.test(h) && /10MB/.test(h));
}

rmSync(ws, { recursive: true, force: true });
rmSync(outside, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
