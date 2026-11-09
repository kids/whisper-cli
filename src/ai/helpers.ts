// Shared helpers for AI CLI runners
// (reply-text paths → chat attachments live in src/outgoing.ts)
import type { AiResult } from "../types";

export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r/g, "")
    .trim();
}

export function normalizeUsage(u: Record<string, unknown> | undefined): AiResult["usage"] {
  if (!u || typeof u !== "object") return undefined;
  const num = (...keys: string[]): number => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    return 0;
  };
  const input = num("inputTokens", "input_tokens");
  const output = num("outputTokens", "output_tokens");
  const cacheRead = num("cacheReadTokens", "cache_read_tokens", "cache_read_input_tokens", "cached_input_tokens", "cached");
  const cacheWrite = num("cacheWriteTokens", "cache_write_tokens", "cache_creation_input_tokens");
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    totalTokens: input + output,
  };
}

export const STALL_TIMEOUT_MS = Number(process.env.AGENT_STALL_MS || 45 * 60 * 1000);
export const HARD_TIMEOUT_MS = Number(process.env.AGENT_MAX_MS || 0);
