// =============================================================================
// Watches — durable, zero-token monitoring of long-running work (training, jobs)
// =============================================================================
// An agent run is one CLI process with a 30–90 min ceiling, so it must not sit
// and wait for a multi-hour job. Instead the agent starts the job in the
// background, registers a watch and ends its turn. Code then probes on a timer
// (process / log / metrics / file / cmd — no LLM, no CLI process), keeps a
// progress card up to date, and wakes the agent (or just notifies) when a
// condition hits. Watches live in a JSON file with their next check time, so a
// restart resumes them. (docs/orc architecture page: "长时任务与连接")
//
// Agent protocol (single-agent replies): a line
//   [[watch]] {"title":"…","pid":123,"log":"/x/train.log","done":"finished", …}
//   [[unwatch]] 3
// =============================================================================
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const MIN_EVERY_S = 30;
export const MAX_TIMEOUT_S = 14 * 86400;
export const MAX_ACTIVE_PER_CHAT = 10;
const CMD_TIMEOUT_MS = 30_000;
const MAX_SCAN_BYTES = 1 << 20;
const TAIL_BYTES = 16 << 10;

// ---- spec -------------------------------------------------------------------

export interface MetricsSpec {
  path: string;
  /** fields shown on the card, e.g. ["step","loss"] (default: all, up to 6) */
  show?: string[];
  /** stop condition, e.g. "loss<0.5" or "step>=50000" */
  stop?: string;
}

export interface WatchSpec {
  title: string;
  everyS: number;
  timeoutS: number;
  /** fire when this process is gone */
  pid?: number;
  log?: string;
  /** regexes (case-insensitive) on new log lines → fire early (errors) */
  wakeOn?: string[];
  /** regex on new log lines → fire (finished) */
  done?: string;
  /** log (or metrics file) not modified for this long → fire (hung?) */
  staleS?: number;
  metrics?: MetricsSpec;
  /** fire when this path exists */
  file?: string;
  /** read-only shell check; exit 0 → fire */
  cmd?: string;
  /** what the agent should do when woken; absent → notify only */
  onWake?: string;
  /** soft-wake the agent this often to refresh the human-facing note (min 30m) */
  reportEveryS?: number;
}

/** Max length of the agent-authored card body */
export const MAX_NOTE = 2000;
/** Soft progress reports are opt-in and never more frequent than this */
export const MIN_REPORT_S = 30 * 60;

export type WatchStatus = "active" | "fired" | "expired" | "cancelled" | "error";

export interface Watch {
  id: number;
  chatId: string;
  /** bot group serving the chat (routes card updates / wake-ups after restart) */
  bot: string;
  /** session to wake (single agent: the chat id) */
  sessionKey: string;
  cwd: string;
  spec: WatchSpec;
  status: WatchStatus;
  createdAt: number;
  nextAt: number;
  checks: number;
  /** byte offset already scanned in spec.log */
  logOffset: number;
  /** /proc start time of spec.pid at registration (guards against pid reuse) */
  pidStart?: string;
  cardId?: string;
  /** machine probe line (pid / metrics / last log); used for wake context, not the card */
  summary: string;
  /** agent-authored markdown shown on the card (richer than summary) */
  note?: string;
  lastCheckAt?: number;
  /** next soft report wake (when spec.reportEveryS is set) */
  nextReportAt?: number;
  fired?: { reason: string; at: number };
  errors: number;
}

const DUR_RE = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)?s?$/i;

/** "10m" / "2h" / "1.5d" / 600 → seconds */
export function parseDuration(v: unknown, fallback?: number): number {
  if (v == null || v === "") {
    if (fallback == null) throw new Error("missing duration");
    return fallback;
  }
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  const m = String(v).trim().match(DUR_RE);
  if (!m) throw new Error(`bad duration "${v}" (use e.g. 30s / 10m / 2h / 1d)`);
  const n = Number(m[1]);
  const u = (m[2] || "s").toLowerCase()[0];
  return n * ({ s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[u];
}

const absPath = (p: unknown, cwd: string, field: string): string => {
  if (typeof p !== "string" || !p.trim()) throw new Error(`${field} must be a path`);
  return isAbsolute(p) ? p : resolve(cwd, p);
};

function checkRegex(src: string, field: string): string {
  try { new RegExp(src, "i"); } catch { throw new Error(`${field}: invalid regex "${src}"`); }
  return src;
}

export const METRIC_COND_RE = /^\s*([\w.\-/]+)\s*(<=|>=|==|<|>)\s*(-?\d+(?:\.\d+)?(?:e-?\d+)?)\s*$/i;

/** Validate + normalize raw JSON from an agent (snake_case or camelCase) */
export function parseWatchSpec(raw: any, cwd: string): WatchSpec {
  if (!raw || typeof raw !== "object") throw new Error("watch spec must be a JSON object");
  const spec: WatchSpec = {
    title: String(raw.title ?? "").trim().slice(0, 80),
    everyS: Math.max(MIN_EVERY_S, parseDuration(raw.every, 600)),
    timeoutS: Math.min(MAX_TIMEOUT_S, parseDuration(raw.timeout, 2 * 86400)),
  };
  if (raw.pid != null) {
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 1) throw new Error("pid must be a positive integer");
    spec.pid = pid;
  }
  if (raw.log != null) spec.log = absPath(raw.log, cwd, "log");
  const wakeOn = raw.wake_on ?? raw.wakeOn;
  if (wakeOn != null) spec.wakeOn = (Array.isArray(wakeOn) ? wakeOn : [wakeOn]).map(String).filter(Boolean).slice(0, 10).map((r: string) => checkRegex(r, "wake_on"));
  if (raw.done != null) spec.done = checkRegex(String(raw.done), "done");
  if (raw.stale != null) spec.staleS = parseDuration(raw.stale);
  if (raw.metrics != null) {
    const m = typeof raw.metrics === "string" ? { path: raw.metrics } : raw.metrics;
    spec.metrics = { path: absPath(m.path, cwd, "metrics.path") };
    if (Array.isArray(m.show)) spec.metrics.show = m.show.map(String).slice(0, 8);
    if (m.stop != null) {
      if (!METRIC_COND_RE.test(String(m.stop))) throw new Error(`metrics.stop must look like "loss<0.5", got "${m.stop}"`);
      spec.metrics.stop = String(m.stop);
    }
  }
  if (raw.file != null) spec.file = absPath(raw.file, cwd, "file");
  if (raw.cmd != null) spec.cmd = String(raw.cmd).slice(0, 1000);
  const onWake = raw.on_wake ?? raw.onWake;
  if (onWake != null && String(onWake).trim()) spec.onWake = String(onWake).trim().slice(0, 1000);
  const report = raw.report ?? raw.report_every ?? raw.reportEvery;
  if (report != null && String(report).trim() !== "") {
    spec.reportEveryS = Math.max(MIN_REPORT_S, parseDuration(report));
  }
  if ((spec.wakeOn || spec.done) && !spec.log) throw new Error("wake_on / done need a log path");
  if (spec.staleS && !spec.log && !spec.metrics) throw new Error("stale needs a log or metrics path");
  if (!spec.pid && !spec.log && !spec.metrics && !spec.file && !spec.cmd) {
    throw new Error("nothing to watch: give at least one of pid / log / metrics / file / cmd");
  }
  if (!spec.title) spec.title = spec.log ? spec.log.split("/").pop()! : spec.pid ? `pid ${spec.pid}` : "watch";
  return spec;
}

/** Agent-authored card body from a [[watch]] JSON (create or update). */
export function parseWatchNote(raw: any): string | undefined {
  const v = raw?.note ?? raw?.card;
  if (v == null) return undefined;
  const note = String(v).trim();
  if (!note) return undefined;
  return note.slice(0, MAX_NOTE);
}

/** `[[watch]] {"id":7,"note":"…"}` — refresh the card body without touching probes. */
export function isWatchNoteUpdate(raw: any): boolean {
  return raw != null && typeof raw === "object" && raw.id != null && (raw.note != null || raw.card != null);
}

// ---- probes -----------------------------------------------------------------

export function procStart(pid: number): string | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").pop()!.split(" ")[19]; } catch { return undefined; }
}

export function pidAlive(pid: number, expectStart?: string): boolean {
  try { process.kill(pid, 0); } catch (e: any) { if (e?.code !== "EPERM") return false; }
  if (expectStart && existsSync(`/proc/${pid}`)) return procStart(pid) === expectStart;
  // zombie = exited, not yet reaped
  try { return !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8")); } catch { return true; }
}

function readRange(path: string, from: number, to: number): string {
  if (to <= from) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(to - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    return buf.subarray(0, n).toString("utf8");
  } finally { closeSync(fd); }
}

export function tailLines(path: string, n = 20): string[] {
  try {
    const size = statSync(path).size;
    const txt = readRange(path, Math.max(0, size - TAIL_BYTES), size);
    // progress bars rewrite one line with \r; keep the last frame
    return txt.split("\n").map((l) => l.split("\r").filter(Boolean).pop() ?? "").filter((l) => l.trim()).slice(-n);
  } catch { return []; }
}

function lastMetrics(path: string): Record<string, unknown> | undefined {
  const lines = tailLines(path, 3);
  const last = lines[lines.length - 1];
  if (!last) return undefined;
  if (last.trim().startsWith("{")) { try { return JSON.parse(last); } catch { return undefined; } }
  // csv: header is the first line of the file
  try {
    const header = readRange(path, 0, Math.min(statSync(path).size, 4096)).split("\n")[0].split(",").map((s) => s.trim());
    if (header.join(",") === last.trim()) return undefined;
    const vals = last.split(",").map((s) => s.trim());
    return Object.fromEntries(header.map((h, i) => [h, vals[i] !== undefined && vals[i] !== "" && !Number.isNaN(Number(vals[i])) ? Number(vals[i]) : vals[i]]));
  } catch { return undefined; }
}

export function evalCond(cond: string, row: Record<string, unknown>): boolean | undefined {
  const m = cond.match(METRIC_COND_RE);
  if (!m) return undefined;
  const v = Number(row[m[1]]);
  if (row[m[1]] == null || Number.isNaN(v)) return undefined;
  const t = Number(m[3]);
  return { "<": v < t, "<=": v <= t, ">": v > t, ">=": v >= t, "==": v === t }[m[2]];
}

function runCmd(cmd: string, cwd: string): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const child = spawn("bash", ["-c", cmd], { cwd: existsSync(cwd) ? cwd : "/", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const add = (b: Buffer) => { if (out.length < 4000) out += b.toString(); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, CMD_TIMEOUT_MS);
    child.on("close", (code) => { clearTimeout(t); res({ code, out: out.trim() }); });
    child.on("error", (e) => { clearTimeout(t); res({ code: null, out: e.message }); });
  });
}

export interface CheckResult {
  fire?: { reason: string; kind: "exited" | "error" | "done" | "stale" | "file" | "metrics" | "cmd" | "timeout" };
  summary: string;
  /** evidence handed to the agent / shown on fire */
  evidence: string;
  logOffset: number;
}

const fmtAge = (s: number) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : s < 172800 ? `${(s / 3600).toFixed(1)}h` : `${(s / 86400).toFixed(1)}d`);
export { fmtAge };

/** One probe pass. Never throws (problems become summary text). */
export async function checkWatch(w: Watch, now = Date.now()): Promise<CheckResult> {
  const s = w.spec;
  const parts: string[] = [];
  const evidence: string[] = [];
  let fire: CheckResult["fire"];
  let logOffset = w.logOffset;
  const setFire = (f: NonNullable<CheckResult["fire"]>) => { if (!fire) fire = f; };

  if (s.log) {
    if (!existsSync(s.log)) parts.push("日志尚未生成");
    else {
      const st = statSync(s.log);
      if (st.size < logOffset) logOffset = 0; // truncated / rotated
      const from = Math.max(logOffset, st.size - MAX_SCAN_BYTES);
      const fresh = readRange(s.log, from, st.size);
      // only complete lines; a partial last line is rescanned next time
      const cut = fresh.lastIndexOf("\n");
      const scanned = cut >= 0 ? fresh.slice(0, cut + 1) : "";
      logOffset = from + Buffer.byteLength(scanned);
      const lines = scanned.split(/\r?\n|\r/).filter((l) => l.trim());
      const hit = (re: string) => { const r = new RegExp(re, "i"); return lines.find((l) => r.test(l)); };
      for (const re of s.wakeOn ?? []) {
        const l = hit(re);
        if (l) { setFire({ kind: "error", reason: `日志出现 /${re}/：${l.trim().slice(0, 200)}` }); break; }
      }
      if (s.done) { const l = hit(s.done); if (l) setFire({ kind: "done", reason: `日志出现完成标记：${l.trim().slice(0, 200)}` }); }
      const age = (now - st.mtimeMs) / 1000;
      if (s.staleS && age > s.staleS) setFire({ kind: "stale", reason: `日志已 ${fmtAge(age)} 没有更新（阈值 ${fmtAge(s.staleS)}），可能卡住` });
      const last = tailLines(s.log, 1)[0];
      if (last && !s.metrics) parts.push(last.trim().slice(0, 140));
    }
  }

  if (s.metrics) {
    if (!existsSync(s.metrics.path)) parts.push("指标文件尚未生成");
    else {
      const row = lastMetrics(s.metrics.path);
      if (row) {
        const keys = s.metrics.show?.length ? s.metrics.show : Object.keys(row).slice(0, 6);
        parts.push(keys.filter((k) => k in row).map((k) => `${k} ${typeof row[k] === "number" ? +(row[k] as number).toPrecision(5) : row[k]}`).join(" · "));
        const bad = Object.entries(row).find(([k, v]) => (s.metrics!.show ? s.metrics!.show.includes(k) : true) && (typeof v === "string" ? /^(nan|inf|-inf)$/i.test(v) : typeof v === "number" && !Number.isFinite(v)));
        if (bad) setFire({ kind: "error", reason: `指标 ${bad[0]} = ${bad[1]}` });
        if (s.metrics.stop && evalCond(s.metrics.stop, row)) setFire({ kind: "metrics", reason: `指标达到条件 ${s.metrics.stop}` });
        evidence.push(`最新指标：${JSON.stringify(row).slice(0, 500)}`);
      }
      if (s.staleS && !s.log) {
        const age = (now - statSync(s.metrics.path).mtimeMs) / 1000;
        if (age > s.staleS) setFire({ kind: "stale", reason: `指标文件已 ${fmtAge(age)} 没有更新，可能卡住` });
      }
    }
  }

  if (s.file && existsSync(s.file)) setFire({ kind: "file", reason: `产物已出现：${s.file}` });

  if (s.cmd) {
    const r = await runCmd(s.cmd, w.cwd);
    if (r.code === 0) setFire({ kind: "cmd", reason: `检查命令返回 0${r.out ? "：" + r.out.slice(0, 200) : ""}` });
    else if (r.out && !s.log && !s.metrics) parts.push(r.out.split("\n").pop()!.slice(0, 140));
  }

  if (s.pid) {
    const alive = pidAlive(s.pid, w.pidStart);
    if (!alive) setFire({ kind: "exited", reason: `进程 ${s.pid} 已结束` });
    parts.unshift(alive ? `进程 ${s.pid} 运行中` : `进程 ${s.pid} 已结束`);
  }

  const age = (now - w.createdAt) / 1000;
  if (!fire && age > s.timeoutS) fire = { kind: "timeout", reason: `已监控 ${fmtAge(age)}，超过上限 ${fmtAge(s.timeoutS)}` };

  if (s.log && existsSync(s.log)) evidence.unshift(`日志 ${s.log} 末尾：\n${tailLines(s.log, fire ? 40 : 10).join("\n")}`);
  return { fire, summary: parts.filter(Boolean).join(" · ") || "-", evidence: evidence.join("\n\n").slice(-6000), logOffset };
}

// ---- store ------------------------------------------------------------------

interface WatchFile { nextId: number; watches: Watch[] }

const storePath = () => process.env.WATCHES_PATH || resolve(import.meta.dirname, "../state/watches.json");
let db: WatchFile | null = null;

function load(): WatchFile {
  if (db) return db;
  try { db = existsSync(storePath()) ? JSON.parse(readFileSync(storePath(), "utf8")) : null; } catch { db = null; }
  db ??= { nextId: 1, watches: [] };
  return db;
}

function save(): void {
  const d = load();
  // keep finished watches for a while so /watch can still show them
  const cutoff = Date.now() - 14 * 86400_000;
  d.watches = d.watches.filter((w) => w.status === "active" || (w.fired?.at ?? w.lastCheckAt ?? w.createdAt) > cutoff);
  mkdirSync(resolve(storePath(), ".."), { recursive: true });
  writeFileSync(storePath() + ".tmp", JSON.stringify(d, null, 1));
  renameSync(storePath() + ".tmp", storePath());
}

export function getWatch(id: number): Watch | undefined {
  return load().watches.find((w) => w.id === id);
}

export function listWatches(filter: { chatId?: string; status?: WatchStatus[] } = {}): Watch[] {
  return load().watches.filter((w) => (!filter.chatId || w.chatId === filter.chatId) && (!filter.status || filter.status.includes(w.status)));
}

export function updateWatch(id: number, patch: Partial<Watch>): Watch | undefined {
  const w = getWatch(id);
  if (!w) return undefined;
  Object.assign(w, patch);
  save();
  return w;
}

export function addWatch(input: { chatId: string; bot: string; sessionKey: string; cwd: string; spec: WatchSpec; note?: string }): Watch {
  const active = listWatches({ chatId: input.chatId, status: ["active"] }).length;
  if (active >= MAX_ACTIVE_PER_CHAT) throw new Error(`本群已有 ${active} 个进行中的监控（上限 ${MAX_ACTIVE_PER_CHAT}），先说「停掉监控 #编号」停掉一些`);
  const d = load();
  const now = Date.now();
  let logOffset = 0;
  // appending to an old log: skip what was there before (fresh logs are scanned from 0
  // so an early crash between launch and registration is still caught)
  if (input.spec.log && existsSync(input.spec.log)) {
    const st = statSync(input.spec.log);
    if (now - st.mtimeMs > 5 * 60_000) logOffset = st.size;
  }
  const note = input.note?.trim().slice(0, MAX_NOTE) || undefined;
  const w: Watch = {
    id: d.nextId++, chatId: input.chatId, bot: input.bot, sessionKey: input.sessionKey, cwd: input.cwd,
    spec: input.spec, status: "active", createdAt: now,
    // first look soon, so a crash right after launch surfaces within a minute
    nextAt: now + Math.min(60, input.spec.everyS) * 1000,
    checks: 0, logOffset, summary: "等待首次检查", errors: 0, note,
    nextReportAt: input.spec.reportEveryS ? now + input.spec.reportEveryS * 1000 : undefined,
    pidStart: input.spec.pid ? procStart(input.spec.pid) : undefined,
  };
  d.watches.push(w);
  save();
  return w;
}

/** Update the human-facing card body; returns the watch or undefined if not found / wrong chat. */
export function setWatchNote(id: number, note: string, chatId?: string): Watch | undefined {
  const w = getWatch(id);
  if (!w || (chatId && w.chatId !== chatId)) return undefined;
  const cleaned = note.trim().slice(0, MAX_NOTE);
  if (!cleaned) throw new Error("note must be non-empty");
  return updateWatch(id, { note: cleaned });
}

export function cancelWatch(id: number, chatId?: string): boolean {
  const w = getWatch(id);
  if (!w || w.status !== "active" || (chatId && w.chatId !== chatId)) return false;
  updateWatch(id, { status: "cancelled" });
  return true;
}

// ---- manager ----------------------------------------------------------------

export interface WatchHost {
  /** Card create/update for progress; optional */
  card?(w: Watch): Promise<void>;
  /** Condition hit (or timeout): notify and/or wake the agent */
  fire(w: Watch, r: CheckResult): Promise<void>;
  /** Soft wake so the agent can refresh `note` (opt-in via report_every); does not end the watch */
  report?(w: Watch, r: CheckResult): Promise<void>;
}

const hosts = new Map<string, WatchHost>();
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function registerWatchHost(bot: string, host: WatchHost): void {
  hosts.set(bot, host);
}

/** Probe every due watch once. Exported for tests and `/watch check`. */
export async function tickWatches(now = Date.now(), only?: number): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let n = 0;
  try {
    const due = listWatches({ status: ["active"] }).filter((w) => (only ? w.id === only : w.nextAt <= now));
    for (const w of due) {
      const host = hosts.get(w.bot);
      if (!host) continue; // its bot is not up (yet); try again next tick
      n++;
      let r: CheckResult;
      try { r = await checkWatch(w, now); }
      catch (e) {
        const errors = w.errors + 1;
        updateWatch(w.id, { errors, nextAt: now + w.spec.everyS * 1000, summary: `检查出错：${(e as Error).message}`, status: errors >= 5 ? "error" : "active" });
        continue;
      }
      updateWatch(w.id, {
        checks: w.checks + 1, lastCheckAt: now, summary: r.summary, logOffset: r.logOffset, errors: 0,
        nextAt: now + w.spec.everyS * 1000,
        ...(r.fire ? { status: r.fire.kind === "timeout" ? "expired" : "fired", fired: { reason: r.fire.reason, at: now } } : {}),
      });
      const cur = getWatch(w.id)!;
      // card text is agent note only — probes never rewrite it; refresh once on terminal so IM keeps the last note
      if (r.fire) await host.card?.(cur).catch(() => {});
      if (r.fire) {
        await host.fire(cur, r).catch((e) => console.warn(`[watch] #${w.id} fire handler failed: ${(e as Error).message}`));
      } else if (cur.spec.reportEveryS && host.report && (cur.nextReportAt ?? 0) <= now) {
        updateWatch(cur.id, { nextReportAt: now + cur.spec.reportEveryS * 1000 });
        await host.report(getWatch(cur.id)!, r).catch((e) => console.warn(`[watch] #${w.id} report failed: ${(e as Error).message}`));
      }
    }
  } finally { ticking = false; }
  return n;
}

export function startWatches(tickMs = Number(process.env.WATCH_TICK_MS || 15_000)): void {
  if (timer) return;
  timer = setInterval(() => void tickWatches(), tickMs);
  timer.unref?.();
}

export function stopWatches(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// ---- rendering / protocol -----------------------------------------------------

/**
 * Card == agent note, verbatim. No status icons, age, probe summary, or stop hints —
 * those are templates; humans should read what the agent wrote. Empty note → bare id line
 * so a card can exist until the first report.
 */
export function renderWatchCard(w: Watch): string {
  const note = w.note?.trim();
  if (note) return note.slice(0, MAX_NOTE);
  return `监控 #${w.id} ${w.spec.title}`;
}

export function describeSpec(s: WatchSpec): string {
  const what = [
    s.pid && `进程 ${s.pid}`, s.log && `日志 ${s.log}`, s.metrics && `指标 ${s.metrics.path}${s.metrics.stop ? `（${s.metrics.stop} 停）` : ""}`,
    s.file && `产物 ${s.file}`, s.cmd && `命令 \`${s.cmd.slice(0, 60)}\``,
  ].filter(Boolean).join("、");
  return `${what}；每 ${fmtAge(s.everyS)} 检查，最长 ${fmtAge(s.timeoutS)}`;
}

/** Hint + this chat's active watches, injected for single-agent turns */
export function formatWatchContext(chatId: string): string {
  const active = listWatches({ chatId, status: ["active"] });
  return [
    "【长任务监控】你的每一轮最长几十分钟，不要在一轮里干等长作业。正确做法：",
    "1. 后台启动并落日志（`setsid nohup … & echo $!`），本轮结束后进程要还活着；",
    "2. 末尾行登记监控。代码只负责探测（零 token）；**群卡片 = 你写的 `note` 原文，代码不加任何壳**：",
    '`[[watch]] {"title":"训练 a.yaml","pid":12345,"log":"out/train.log","done":"Training finished","wake_on":["Traceback","CUDA out of memory","nan"],"stale":"30m","metrics":{"path":"out/metrics.jsonl"},"every":"10m","timeout":"2d","report":"1h","note":"刚启动 Adam，目标 ≥100k step。","on_wake":"跑 eval 并汇报"}`',
    "   至少 pid/log/metrics/file/cmd 之一；`note` 写给人看的关键进展（不要贴大表）；可选 `report`（≥30m）到点叫醒你改 note；无 on_wake 则只通知；",
    "3. 更新进展：`[[watch]] {\"id\":编号,\"note\":\"…这段话会原样出现在卡片上\"}`。取消：`[[unwatch]] 编号`。",
    active.length
      ? `本群进行中的监控：\n${active.map((w) => `- #${w.id} ${w.spec.title}${w.note ? "：" + w.note.replace(/\s+/g, " ").slice(0, 120) : "（还没写 note）"}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n");
}

export interface WatchOps {
  text: string;
  add: { raw?: any; error?: string }[];
  remove: number[];
}

const WATCH_RE = /^[ \t>*-]*`?\[\[watch\]\]\s*(\{.*\})\s*`?\s*$/gim;
const UNWATCH_RE = /^[ \t>*-]*`?\[\[unwatch\]\]\s*([#\d,，\s]+?)`?\s*$/gim;

export function extractWatchOps(text: string): WatchOps {
  const add: WatchOps["add"] = [];
  const remove: number[] = [];
  let out = (text || "").replace(WATCH_RE, (_, j: string) => {
    try { add.push({ raw: JSON.parse(j) }); } catch (e) { add.push({ error: `JSON 解析失败：${(e as Error).message}` }); }
    return "";
  });
  out = out.replace(UNWATCH_RE, (_, ids: string) => {
    for (const s of ids.split(/[#,，\s]+/)) if (/^\d+$/.test(s)) remove.push(Number(s));
    return "";
  });
  if (add.length || remove.length) out = out.replace(/\n{3,}/g, "\n\n").trimEnd();
  return { text: out, add, remove };
}

/** Prompt that resumes the agent's session when a watch fires */
export function buildWakePrompt(w: Watch, r: CheckResult): string {
  return [
    `【监控 #${w.id} 唤醒】你之前登记的监控「${w.spec.title}」触发了：${r.fire?.reason ?? w.fired?.reason ?? ""}`,
    `监控对象：${describeSpec(w.spec)}；已运行 ${fmtAge((Date.now() - w.createdAt) / 1000)}。`,
    r.evidence ? `观测：\n${r.evidence}` : "",
    `你登记时留下的后续安排：${w.spec.onWake}`,
    "请先核实现状（进程、日志、产物），再按安排继续；如果还需要继续等待，可以再登记一个新的监控（记得写 note）。",
  ].filter(Boolean).join("\n\n");
}

/** Soft wake: agent reports key progress into note (card shows that text only). */
export function buildReportPrompt(w: Watch, r: CheckResult): string {
  return [
    `【监控 #${w.id} 进展刷新】「${w.spec.title}」已运行 ${fmtAge((Date.now() - w.createdAt) / 1000)}。请只汇报关键进展，不要贴大表。`,
    `探测（仅供你参考，不要原样贴进卡片）：${r.summary || w.summary}`,
    r.evidence ? `观测摘录：\n${r.evidence.slice(0, 1500)}` : "",
    w.note ? `你上次写的 note：\n${w.note}` : "还没有 note。",
    `看完现状后，用一行 \`[[watch]] {"id":${w.id},"note":"…"}\` 写一小段关键进展（阶段/关键数字/是否正常/大概还要多久）。卡片只会显示这段原文。不要重跑作业；若已结束或出错，按 on_wake 处理。`,
  ].filter(Boolean).join("\n\n");
}

/** /watch | /watch stop <id…> | /watch check <id> — returns markdown or undefined */
export function watchCommandKind(text: string): { kind: "list" | "stop" | "check" | "usage"; ids: number[] } | undefined {
  const m = text.trim().match(/^\/(watch|watches|监控)(?:\s+([\s\S]*))?$/i);
  if (!m) return undefined;
  const arg = (m[2] || "").trim();
  if (!arg) return { kind: "list", ids: [] };
  const sm = arg.match(/^(stop|cancel|停止|取消|check|检查)\s+([#\d,，\s]+)$/i);
  if (!sm) return { kind: "usage", ids: [] };
  const ids = sm[2].split(/[#,，\s]+/).filter((s) => /^\d+$/.test(s)).map(Number);
  return { kind: /^(check|检查)$/i.test(sm[1]) ? "check" : "stop", ids };
}

// ---- 「停掉监控」 in plain words ---------------------------------------------------
// A code fast path (no model turn) for short, unambiguous requests. Anything longer,
// compound or phrased as a question goes to the agent, which still has `[[unwatch]]`.

const STOP_VERB = "停|停掉|停止|停下|取消|关掉|关闭|关了|结束掉|撤|撤掉|撤销|去掉|删|删掉|删除|移除|终止|不要了|不用了";
const STOP_A = new RegExp(`(${STOP_VERB})[^。！？?\\n]{0,14}(监控|盯)`);
const STOP_B = new RegExp(`(监控|盯着?)[^。！？?\\n]{0,12}(${STOP_VERB})`);
const STOP_C = /(别|不要|不用|无需|不必|甭)(再)?(盯|监控)/;
const NOT_STOP = /(别|不要|不用|先别|不能|不许)(停|取消|关|撤|删|去掉|移除|终止)|继续(盯|监控)|接着(盯|监控)|(保留|留着)[^。！？\n]{0,6}监控/;
const QUESTION = /[吗嘛么呢？?]\s*$|为什么|为啥|怎么|是不是|有没有|是否|什么时候|啥时候/;
const COMPOUND = /然后|并且|顺便|同时|之后|以后|另外|后(把|再|就)|再(帮|跑|启|开)|重新|换成|改成|进程|kill|杀/i;
const MAX_LEN = 40;

export interface StopWatchIntent { ids: number[]; all: boolean }

/** 「停掉监控」「别盯了」「取消 #3 监控」「把训练那个监控停了」「监控全关了」 → intent; else undefined */
export function parseStopWatchIntent(text: string): StopWatchIntent | undefined {
  const s = (text || "").trim();
  if (!s || s.length > MAX_LEN || s.startsWith("/")) return undefined;
  if (QUESTION.test(s) || NOT_STOP.test(s) || COMPOUND.test(s)) return undefined;
  if (!(STOP_A.test(s) || STOP_B.test(s) || STOP_C.test(s))) return undefined;
  const ids = [...s.matchAll(/#\s?(\d+)|(\d+)\s?号|监控\s?#?\s?(\d+)/g)].map((m) => Number(m[1] ?? m[2] ?? m[3]));
  return { ids: [...new Set(ids)], all: /全部|所有|全都|统统|一起|(都|全)(给我)?(停|关|撤|删|取消|去掉|不要|不用)/.test(s) };
}

/** Watch that a supervisor-loop task is parked on (stopping it would strand the task) */
export function loopTaskOf(w: Watch): number | undefined {
  const m = /^orc-loop:(\d+)$/.exec(w.sessionKey);
  return m ? Number(m[1]) : undefined;
}

export interface StopWatchPlan { stop: Watch[]; loopOwned: Watch[]; missing: number[]; ambiguous: Watch[] }

const GENERIC = new Set(["监控", "盯着", "任务", "那个", "这个", "停止", "停掉", "取消", "关掉", "关闭", "结束", "删掉", "删除", "不要", "不用"]);
/** Distinctive bits of a watch title: 2-char CJK windows and 3+ char latin/digit words */
function titleKeys(title: string): string[] {
  const keys = new Set<string>();
  for (const run of title.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    for (let i = 0; i + 2 <= run.length; i++) { const k = run.slice(i, i + 2); if (!GENERIC.has(k)) keys.add(k); }
  }
  for (const w of title.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []) keys.add(w);
  return [...keys];
}

/** Which of this chat's active watches the words point at */
export function planStopWatches(text: string, intent: StopWatchIntent, active: Watch[]): StopWatchPlan {
  const plan: StopWatchPlan = { stop: [], loopOwned: [], missing: [], ambiguous: [] };
  const take = (ws: Watch[]) => { for (const w of ws) (loopTaskOf(w) ? plan.loopOwned : plan.stop).push(w); };
  if (intent.ids.length) {
    for (const id of intent.ids) {
      const w = active.find((x) => x.id === id);
      if (w) take([w]); else plan.missing.push(id);
    }
    return plan;
  }
  const own = active.filter((w) => !loopTaskOf(w));
  if (intent.all) { plan.stop = own; return plan; }
  const t = text.toLowerCase();
  const byTitle = active.filter((w) => titleKeys(w.spec.title).some((k) => t.includes(k)));
  if (byTitle.length === 1) { take(byTitle); return plan; }
  if (byTitle.length > 1) {
    const ownHits = byTitle.filter((w) => !loopTaskOf(w));
    if (ownHits.length === 1) plan.stop = ownHits; else if (ownHits.length) plan.ambiguous = ownHits; else take(byTitle);
    return plan;
  }
  if (own.length === 1) plan.stop = own;
  else if (own.length > 1) plan.ambiguous = own;
  else take(active);
  return plan;
}
