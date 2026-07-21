// =============================================================================
// Prompt helpers — /review + per-project systemPromptFile (from feishu-cursor)
// =============================================================================
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function stripMdcFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content.trim();
  const end = content.indexOf("---", 3);
  if (end === -1) return content.trim();
  return content.slice(end + 3).trim();
}

/** Work-group /review: critique the previous assistant reply (one-shot, no side effects) */
export function buildReviewPrompt(focus?: string): string {
  const focusBlock = focus ? `\n【用户指定审视焦点】\n${focus}\n` : "";
  return [
    "【一次性审视模式 · 不要执行工具、不要改代码、不要 push、不要扩写文档】",
    "",
    "请以 senior reviewer / red-team 视角，严格审视你在上一轮对话中的最后一条 assistant 回复。",
    "",
    "目标：找出逻辑漏洞、未验证假设、数据/方法论 bias、过度自信表述；给出可操作的补证建议。",
    "禁止：人身攻击、为批评而批评、无依据的否定。",
    "这是一次性审视，不要据此改变既有计划或代码，除非用户明确要求。",
    focusBlock,
    "输出结构：",
    "1. 核心结论是否站得住（高/中/低置信 + 理由）",
    "2. 主要漏洞（按严重性排序，每条附「若成立则…」）",
    "3. 可能的 bias / 隐含前提",
    "4. 建议的补充验证（最小成本优先）",
  ].join("\n");
}

/**
 * If the project has systemPromptFile, wrap user input with explicit system instructions
 * (more reliable for headless agent than relying on workspace rules alone).
 */
export function wrapWithProjectPrompt(
  workspace: string,
  systemPromptFile: string | undefined,
  userPrompt: string,
): string {
  if (!systemPromptFile) return userPrompt;
  const path = resolve(workspace, systemPromptFile);
  if (!existsSync(path)) {
    console.warn(`[prompt] systemPromptFile not found: ${path}`);
    return userPrompt;
  }
  const body = stripMdcFrontmatter(readFileSync(path, "utf-8"));
  return [
    "【系统指令 · 必须严格按以下工作流执行，禁止仅在聊天中回复观点而不落盘】",
    body,
    "",
    "【用户输入】",
    userPrompt,
    "",
    "【硬性要求】必须完成：扩写 → 写入 _docs → git push → 返回 GitHub 链接。不要跳过任何步骤。",
  ].join("\n");
}

export const REVIEW_CMD_RE = /^\/(review|critique|redteam|reproach|审视|二审)\s*(.*)$/is;

export function parseReviewCommand(text: string): { focus: string } | null {
  const m = text.trim().match(REVIEW_CMD_RE);
  if (!m) return null;
  return { focus: m[2].trim() };
}
