// =============================================================================
// orc — 决策说明 (the advisor's brief, rendered for a human)
// =============================================================================
// When a task cannot settle itself (a stage used up its rework budget with two
// defensible ways forward, or a blocker with no good option), the advisor reads
// the whole history and writes this in plain text. The point is that the human
// can decide from the message alone: where the work stands, what is actually
// stuck and why it cannot be fixed by trying again, which real choices exist and
// what each costs, what the advisor recommends, and what it needs from the human.
//
// 没有 JSON、没有字段校验：正文原样给人看；如果按评审口径可以带着遗留问题继续，
// 末尾单独一行 [[continue_with_known_issues]]，后面逐条列暂不解决的问题。
// =============================================================================
import type { Task } from "./types";

const cut = (t: string, n: number) => { const x = (t || "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n - 1) + "…" : x; };

const AUTO = /^\s*\[\[\s*continue_with_known_issues\s*\]\]\s*$/i;

export interface Brief {
  /** 给人看的部分（去掉标记块） */
  text: string;
  /** 带着已知问题继续，不再等人 */
  auto: boolean;
  knownIssues: string[];
}

/** 决策说明就是正文；末尾的标记只决定"要不要继续"，不改变正文 */
export function parseBrief(text: string): Brief {
  const lines = (text || "").split(/\r?\n/);
  const at = lines.findIndex((l) => AUTO.test(l));
  if (at < 0) return { text: (text || "").trim(), auto: false, knownIssues: [] };
  const knownIssues = lines.slice(at + 1)
    .map((l) => l.replace(/^\s*[-*·]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
  return { text: lines.slice(0, at).join("\n").trim(), auto: true, knownIssues };
}

/** The block a human reads when a decision is needed */
export function renderBrief(task: Task, b: Brief, stageName: string): string {
  const head = `**${task.title}：${stageName}反复没过，需要你定一件事**`;
  const tail = `直接说选哪个就行（说「第 2 条」「按你的建议」都可以）；想改口径、缩小范围、或者不做了，也直接说。${task.branch ? `\n现在的版本在分支 \`${task.branch}\`。` : ""}`;
  return [head, b.text ? cut(b.text, 4000) : "（这份说明没写出内容）", tail].join("\n\n");
}

/** Framework keeps going on its own (the advisor said the leftover issues are acceptable to defer) */
export function renderAutoNote(task: Task, b: Brief, kept: string[]): string {
  const why = b.text ? cut(b.text, 800) : "";
  return [
    `**${task.title}：我先带着已知问题往下走了一步**`,
    why ? `\n${why}` : "",
    kept.length ? "\n**暂不解决的（记为已知问题）**：\n" + kept.slice(0, 8).map((x) => `- ${cut(x, 220)}`).join("\n") : "",
    "\n要改回来就说「退回这一版」或者补充要求，我会重新安排。",
  ].filter(Boolean).join("\n");
}
