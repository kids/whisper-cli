// =============================================================================
// .env config parser — reads multi-group agent configurations
// =============================================================================
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import type { AgentConfig, AiCli, Platform } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Raw .env reader
// ---------------------------------------------------------------------------
export function parseEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (v) env[k] = v;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Multi-group agent config parser
// ---------------------------------------------------------------------------

interface RawGroup {
  index: number;
  prefix: string;
  env: Record<string, string>;
}

function collectGroups(env: Record<string, string>): RawGroup[] {
  const groups: RawGroup[] = [];
  const seen = new Set<number>();

  for (const key of Object.keys(env)) {
    const m = key.match(/^AGENT_(\d+)_/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (seen.has(idx)) continue;
    seen.add(idx);

    const prefix = `AGENT_${idx}_`;
    const groupEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith(prefix)) {
        groupEnv[k.slice(prefix.length)] = v;
      }
    }
    groups.push({ index: idx, prefix, env: groupEnv });
  }

  groups.sort((a, b) => a.index - b.index);
  return groups;
}

function validatePlatform(p: string): Platform {
  if (p === "feishu" || p === "wecom") return p;
  throw new Error(`Unsupported platform: "${p}". Supported: feishu, wecom`);
}

function validateAiCli(c: string): AiCli {
  if (c === "codebuddy" || c === "cursor" || c === "codex") return c;
  throw new Error(`Unsupported AI CLI: "${c}". Supported: codebuddy, cursor, codex`);
}

function parseGroup(raw: RawGroup): AgentConfig | null {
  const e = raw.env;
  const platformRaw = e.PLATFORM?.toLowerCase();
  const aiCliRaw = e.AI_CLI?.toLowerCase();

  // Skip groups that are commented out or missing required fields
  if (!platformRaw || !aiCliRaw) return null;

  let platform: Platform;
  let aiCli: AiCli;
  try {
    platform = validatePlatform(platformRaw);
    aiCli = validateAiCli(aiCliRaw);
  } catch (err) {
    console.warn(`[config] Skipping AGENT_${raw.index}:`, (err as Error).message);
    return null;
  }

  const config: AgentConfig = {
    name: e.NAME || `Agent #${raw.index}`,
    index: raw.index,
    platform,
    aiCli,
    allowlist: new Set(
      (e.ALLOWLIST || e.FEISHU_ALLOWLIST || "").split(",").map((s) => s.trim()).filter(Boolean),
    ),
  };

  // Platform-specific
  if (platform === "feishu") {
    const appId = e.FEISHU_APP_ID;
    const appSecret = e.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      console.warn(`[config] Skipping AGENT_${raw.index}: missing FEISHU_APP_ID or FEISHU_APP_SECRET`);
      return null;
    }
    config.feishu = { appId, appSecret };
  }
  if (platform === "wecom") {
    const corpId = e.WECOM_CORP_ID;
    const corpSecret = e.WECOM_CORP_SECRET;
    const token = e.WECOM_TOKEN;
    const encodingAesKey = e.WECOM_ENCODING_AES_KEY;
    if (!corpId || !corpSecret) {
      console.warn(`[config] Skipping AGENT_${raw.index}: missing WECOM_CORP_ID or WECOM_CORP_SECRET`);
      return null;
    }
    config.wecom = { corpId, corpSecret, token: token || "", encodingAesKey: encodingAesKey || "" };
  }

  // CLI-specific
  if (aiCli === "codebuddy") {
    const apiKey = e.CODEBUDDY_API_KEY;
    if (!apiKey) {
      console.warn(`[config] Skipping AGENT_${raw.index}: missing CODEBUDDY_API_KEY`);
      return null;
    }
    config.codebuddy = {
      apiKey,
      internetEnvironment: e.CODEBUDDY_INTERNET_ENVIRONMENT,
    };
  }
  if (aiCli === "cursor") {
    const apiKey = e.CURSOR_API_KEY;
    if (!apiKey) {
      console.warn(`[config] Skipping AGENT_${raw.index}: missing CURSOR_API_KEY`);
      return null;
    }
    config.cursor = { apiKey };
  }
  if (aiCli === "codex") {
    // Codex uses persistent auth via `codex login` — no API key needed.
    config.codex = {};
  }

  return config;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadAllAgents(envPath?: string): AgentConfig[] {
  const path = envPath || resolve(ROOT, ".env");
  if (!existsSync(path)) {
    console.error(`[config] .env not found at ${path}. Copy .env.example to .env and fill in tokens.`);
    process.exit(1);
  }
  const env = parseEnvFile(path);
  const groups = collectGroups(env);

  if (groups.length === 0) {
    console.error("[config] No AGENT_<N>_* groups found in .env. See .env.example for format.");
    process.exit(1);
  }

  const agents: AgentConfig[] = [];
  for (const raw of groups) {
    const cfg = parseGroup(raw);
    if (cfg) agents.push(cfg);
  }

  if (agents.length === 0) {
    console.error("[config] No valid agent configurations. Check .env against .env.example.");
    process.exit(1);
  }

  return agents;
}

// ---------------------------------------------------------------------------
// Binary discovery — search common paths, fallback to `command -v`
// ---------------------------------------------------------------------------

export function findBinary(name: string, candidates: string[]): string {
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Last resort: let the shell find it
  try {
    const found = execSync(`command -v ${name}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (found && existsSync(found)) return found;
  } catch { /* noop */ }
  // Return first candidate as default (spawn will fail clearly if missing)
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Global config (not per-agent)
// ---------------------------------------------------------------------------

export interface GlobalConfig {
  workdir: string;
  codebuddyBin: string;
  cursorAgentBin: string;
  codexBin: string;
  logLevel: string;
}

export function loadGlobalConfig(env: Record<string, string>): GlobalConfig {
  const home = process.env.HOME || "/root";

  return {
    workdir: env.WORKDIR || ROOT,
    codebuddyBin: env.CODEBUDDY_BIN || findBinary("codebuddy", [
      "/opt/homebrew/bin/codebuddy",
      "/usr/local/bin/codebuddy",
      "/home/linuxbrew/.linuxbrew/bin/codebuddy",
      resolve(home, ".local/bin/codebuddy"),
      "/usr/bin/codebuddy",
    ]),
    cursorAgentBin: env.CURSOR_AGENT_BIN || findBinary("agent", [
      resolve(home, ".local/bin/agent"),
      "/opt/homebrew/bin/agent",
      "/usr/local/bin/agent",
    ]),
    codexBin: env.CODEX_BIN || findBinary("codex", [
      resolve(home, ".local/bin/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]),
    logLevel: env.LOG_LEVEL || "info",
  };
}
