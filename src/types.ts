// =============================================================================
// Shared types for whisper-cli
// =============================================================================

/** Supported IM platforms */
export type Platform = "feishu" | "wecom";

/** Supported AI CLI tools */
export type AiCli = "codebuddy" | "cursor";

/** A single agent group configuration parsed from .env */
export interface AgentConfig {
  /** Group name for logging */
  name: string;
  /** Group index (1-based from .env key) */
  index: number;
  /** IM platform to bridge */
  platform: Platform;
  /** AI CLI to invoke */
  aiCli: AiCli;
  /** Feishu-specific config (when platform === "feishu") */
  feishu?: FeishuConfig;
  /** WeCom-specific config (when platform === "wecom") */
  wecom?: WeComConfig;
  /** CodeBuddy-specific config (when aiCli === "codebuddy") */
  codebuddy?: CodeBuddyConfig;
  /** Cursor-specific config (when aiCli === "cursor") */
  cursor?: CursorConfig;
  /** Allowed user open_ids (optional) */
  allowlist: Set<string>;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

export interface WeComConfig {
  corpId: string;
  corpSecret: string;
  token: string;
  encodingAesKey: string;
}

export interface CodeBuddyConfig {
  apiKey: string;
  internetEnvironment?: string;
}

export interface CursorConfig {
  apiKey: string;
}

/** AI CLI run result */
export interface AiResult {
  text: string;
  /** CodeBuddy model name or Cursor model */
  model?: string;
  /** Token usage stats */
  usage?: TokenUsage;
  /** Session ID for continuation */
  sessionId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
}
