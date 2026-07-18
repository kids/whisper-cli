// =============================================================================
// whisper-cli — Multi-group IM → AI CLI forwarding service
// =============================================================================
// Launches all configured agent groups concurrently.
// Each group = one IM platform bridge + one AI CLI runner.
//
// Start:  npx tsx src/index.ts   (or: npm start)
// =============================================================================
import { loadAllAgents, loadGlobalConfig, parseEnvFile } from "./config";
import { AgentRunner } from "./agent-runner";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

async function main(): Promise<void> {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  whisper-cli — Multi-Agent Forwarding Service");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Load all agent configs
  const envPath = resolve(ROOT, ".env");
  const agents = loadAllAgents(envPath);

  console.log(`Loaded ${agents.length} agent group(s):`);
  for (const agent of agents) {
    console.log(`  [${agent.index}] ${agent.name}: ${agent.platform} → ${agent.aiCli}`);
  }
  console.log("");

  // Load global config
  const env = parseEnvFile(envPath);
  const globalConfig = loadGlobalConfig(env);

  // State directory for session persistence
  const stateDir = resolve(ROOT, "state");
  { // ensure state dir exists
    const { mkdirSync, existsSync } = await import("node:fs");
    if (!existsSync(stateDir)) mkdirSync(stateDir);
  }

  // Create and start all agent runners
  const runners: AgentRunner[] = [];
  for (const agent of agents) {
    const runner = new AgentRunner(
      agent,
      globalConfig.workdir,
      globalConfig.codebuddyBin,
      globalConfig.cursorAgentBin,
      globalConfig.codexBin,
      stateDir,
    );
    runners.push(runner);

    try {
      await runner.start();
    } catch (err) {
      console.error(`[${agent.name}] Failed to start:`, (err as Error).message);
    }
  }

  console.log(`\nAll ${runners.length} agent(s) started. Waiting for messages…\n`);

  // Graceful shutdown
  const shutdown = (signal: string) => {
    console.log(`\n[${signal}] Shutting down…`);
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Keep the process alive
  process.stdin.resume();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
