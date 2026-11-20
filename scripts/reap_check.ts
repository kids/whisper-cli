// Offline check for src/orc/reap.ts: a finished task's detached background jobs are stopped,
// nothing else is (sibling worktree, files).   npx tsx scripts/reap_check.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findStrays, reapStrays } from "../src/orc/reap";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) { failed++; console.log(`FAIL ${name}`, detail === undefined ? "" : JSON.stringify(detail)); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const root = mkdtempSync(join(tmpdir(), "reap-check-"));
const wt = join(root, "worktrees", "repo-1234", "task-ab12");
const sib = wt + "x"; // path-prefix sibling: must never be matched
mkdirSync(join(wt, ".orc_status"), { recursive: true });
mkdirSync(sib, { recursive: true });
const script = join(wt, ".orc_status", "loop.sh");
writeFileSync(script, "#!/bin/sh\nwhile true; do sleep 300; done\n");

// like the EF eval loop: `setsid nohup sh loop.sh &` from the worktree, fully detached
const job = spawn("setsid", ["sh", script], { cwd: wt, detached: true, stdio: "ignore" });
job.unref();
const other = spawn("setsid", ["sh", "-c", "while true; do sleep 300; done"], { cwd: sib, detached: true, stdio: "ignore" });
other.unref();
await sleep(500);

const found = findStrays(wt);
check("finds the detached loop and its sleep child", found.length >= 2 && found.some((s) => s.cmd.includes("loop.sh")) && found.some((s) => /^sleep/.test(s.cmd)), found);
check("ignores the path-prefix sibling", !findStrays(wt).some((s) => s.cmd.includes("while true")), found);
check("never itself", !found.some((s) => s.pid === process.pid));
check("refuses shallow / relative paths", findStrays("/").length === 0 && findStrays("tmp/x").length === 0 && findStrays("").length === 0);

const pids = found.map((s) => s.pid);
reapStrays(wt, 500);
await sleep(1200);
check("all stray processes gone", pids.every((p) => !alive(p)), pids.filter(alive));
check("files untouched", existsSync(script));
check("sibling still running", findStrays(sib).length >= 1);

reapStrays(sib, 200);
await sleep(500);
rmSync(root, { recursive: true, force: true });
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
