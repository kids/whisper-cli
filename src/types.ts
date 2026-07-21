// =============================================================================
// Shared types for whisper-cli
// =============================================================================

/** Supported IM platforms */
export type Platform = "feishu" | "wecom";

/** Supported AI CLI tools */
export type AiCli = "codebuddy" | "cursor" | "codex";

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
  /** Working directory for this agent; overrides the global WORKDIR */
  workdir?: string;
  /** Feishu-specific config (when platform === "feishu") */
  feishu?: FeishuConfig;
  /** WeCom-specific config (when platform === "wecom") */
  wecom?: WeComConfig;
  /** CodeBuddy-specific config (when aiCli === "codebuddy") */
  codebuddy?: CodeBuddyConfig;
  /** Cursor-specific config (when aiCli === "cursor") */
  cursor?: CursorConfig;
  /** Codex-specific config (when aiCli === "codex") */
  codex?: CodexConfig;
  /** Allowed user open_ids (optional) */
  allowlist: Set<string>;
  /**
   * Admin console mode (from feishu-cursor):
   * p2p chat = management (/新任务 /列表 /归档), work groups = AI sessions.
   * When true, only registered (non-archived) groups run AI.
   */
  adminMode?: boolean;
  /** Configured admin p2p chat_id (optional; auto-recorded on first p2p) */
  adminChatId?: string;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
}

/** Incoming Feishu image/file attachment */
export interface IncomingAttachment {
  type: "file" | "image";
  fileKey: string;
  fileName?: string;
}

/** Agent-produced image to send back to chat */
export interface AgentImage {
  filePath?: string;
  imageData?: string;
}

/** Agent-produced file to send back to chat */
export interface AgentFile {
  filePath: string;
  fileName?: string;
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

export interface CodexConfig {
  // Codex uses persistent auth via `codex login` — no API key required at runtime.
  // Keep as empty interface for type consistency.
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
  /** Images produced by the agent (Cursor generateImage / path mentions) */
  images?: AgentImage[];
  /** Files produced / mentioned by the agent */
  files?: AgentFile[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens: number;
}

/** Per-chat cumulative usage persisted across restarts */
export interface CumulativeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  turns: number;
}

export function emptyCumulativeUsage(): CumulativeUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0, turns: 0 };
}

/** Persisted agent state (one file per agent group) */
export interface AgentState {
  sessions: Record<string, string>;   // chat_id -> session/thread_id
  models: Record<string, string>;     // chat_id -> model_id
  tokens: Record<string, CumulativeUsage>;
  savedAt: string;
}
