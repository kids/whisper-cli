// Live check: a real agent launches a ~1 min "training" in the background,
// registers a watch and ends its turn; the watch fires on completion and
// resumes the same session. No Feishu (host is simulated).
//   npx tsx scripts/watch_live_check.ts [model]
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const work = mkdtempSync(join(tmpdir(), "watch-live-"));
process.env.WATCHES_PATH = join(work, ".watches.json");
const { loadAllAgents } = await import("../src/config");
const { runCodebuddy, getCodebuddySession, clearCodebuddySession } = await import("../src/ai/codebuddy");
const W = await import("../src/watch");

const model = process.argv[2];
const cfg = loadAllAgents(resolve(import.meta.dirname, "../.env")).find((a) => a.codebuddy)!.codebuddy!;
const CHAT = "oc_watch_live";
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The job reads its per-step sleep from config.json every step: it starts out as a
// ~3 h run (so the agent must not wait for it), and the harness shortens it once
// the watch is registered, to keep the test to a couple of minutes.
writeFileSync(join(work, "config.json"), JSON.stringify({ steps: 20, sleep_per_step_s: 540 }));
writeFileSync(join(work, "train.py"), `import json, time, math, os
os.makedirs("out", exist_ok=True)
cfg = lambda: json.load(open("config.json"))
with open("out/metrics.jsonl", "a") as m:
    for step in range(1, cfg()["steps"] + 1):
        loss = 2.0 * math.exp(-step / 8)
        print(f"step {step}/{cfg()['steps']} loss {loss:.4f}", flush=True)
        m.write(json.dumps({"step": step, "loss": round(loss, 4)}) + "\\n"); m.flush()
        t = time.time()
        while time.time() - t < cfg()["sleep_per_step_s"]:
            time.sleep(1)
print("Training finished. final_loss=%.4f" % loss, flush=True)
`);

const run = (prompt: string, resume: boolean) => {
  if (!resume) clearCodebuddySession(CHAT);
  return runCodebuddy({ prompt, chatId: CHAT, config: cfg, workdir: work, model, resumeSession: resume, appendSystemPrompt: W.formatWatchContext(CHAT), disableAutoMemory: true } as any);
};

// 1. launch turn
const t0 = Date.now();
const r1 = await run("用 python3 跑一下当前目录的 train.py（按 config.json 大约要 3 小时），日志写到 out/train.log。跑完后读 out/metrics.jsonl，告诉我最终 loss 和 loss 是否单调下降。", false);
const turnS = (Date.now() - t0) / 1000;
const sid = getCodebuddySession(CHAT);
const ops = W.extractWatchOps(r1.text);
console.log(`INFO launch turn ${turnS.toFixed(0)}s; reply: ${ops.text.slice(0, 200).replace(/\n/g, " ")}`);
check("agent registered a watch", ops.add.length === 1 && !ops.add[0].error, JSON.stringify(ops.add));
if (!ops.add.length || ops.add[0].error) process.exit(1);
check("turn ended before the job finished", !readFileSync(join(work, "out/train.log"), "utf8").includes("Training finished"), `${turnS.toFixed(0)}s`);
const spec = W.parseWatchSpec(ops.add[0].raw, work);
console.log(`INFO spec ${JSON.stringify(ops.add[0].raw)}`);
check("watch has pid or done marker", !!spec.pid || !!spec.done);
check("watch has on_wake (agent wants to be woken)", !!spec.onWake);

writeFileSync(join(work, "config.json"), JSON.stringify({ steps: 20, sleep_per_step_s: 3 })); // fast-forward (see top)
const w = W.addWatch({ chatId: CHAT, bot: "live", sessionKey: CHAT, cwd: work, spec });
if (spec.pid) check("job alive after the CLI process exited", W.pidAlive(spec.pid, w.pidStart));

// 2. probe until it fires (simulated host; probes ignore `every` here)
let fired: { w: any; r: any } | undefined;
const summaries: string[] = [];
W.registerWatchHost("live", { card: async (x) => { summaries.push(x.summary); }, fire: async (x, r) => { fired = { w: x, r }; } });
const deadline = Date.now() + 180_000;
while (!fired && Date.now() < deadline) { await sleep(5000); await W.tickWatches(Date.now(), w.id); }
console.log(`INFO card summaries: ${summaries.slice(0, 3).concat(summaries.slice(-2)).join(" | ")}`);
check("watch fired", !!fired, fired?.w.fired?.reason ?? "timeout");
check("fired for completion (not error)", !!fired && ["done", "exited", "file", "metrics", "cmd"].includes(fired.r.fire.kind), fired?.r.fire.kind);
check("card showed live progress", summaries.some((s) => /step|loss|运行中/.test(s)));

// 3. wake turn resumes the same session
const r2 = await run(W.buildWakePrompt(fired!.w, fired!.r), true);
const final = readFileSync(join(work, "out/metrics.jsonl"), "utf8").trim().split("\n").pop()!;
const finalLoss = JSON.parse(final).loss as number;
console.log(`INFO wake reply: ${r2.text.slice(0, 300).replace(/\n/g, " ")}`);
check("wake resumed same session", getCodebuddySession(CHAT) === sid, `${sid?.slice(0, 8)} → ${getCodebuddySession(CHAT)?.slice(0, 8)}`);
check("wake reply reports the final loss", r2.text.includes(String(finalLoss)) || r2.text.includes(finalLoss.toFixed(3)), `final=${finalLoss}`);
check("no new watch on completion", W.extractWatchOps(r2.text).add.length === 0);
check("job left nothing running", !spec.pid || !W.pidAlive(spec.pid));
console.log(`\n${failed ? `${failed} FAILED` : "all passed"} in ${Math.round((Date.now() - t0) / 1000)}s  (work dir ${work}, exists=${existsSync(work)})`);
process.exit(failed ? 1 : 0);
