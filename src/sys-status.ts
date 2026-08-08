// System resource status (host / CPU / memory / GPU / disk)
import { execSync } from "node:child_process";
import * as os from "node:os";

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m || !parts.length) parts.push(`${m}m`);
  return parts.join(" ");
}

/** Collect host resource summary for `/status`. */
export function collectSysStatus(): string {
  const lines: string[] = [];

  lines.push(`${os.hostname()}  |  ${os.platform()} ${os.arch()}  |  up ${formatUptime(os.uptime())}`);
  lines.push("");

  const cpus = os.cpus();
  const load = os.loadavg();
  lines.push(`**CPU:** ${cpus[0]?.model ?? "unknown"} (${cpus.length} core${cpus.length > 1 ? "s" : ""})`);
  lines.push(`Load: ${load.map((l) => l.toFixed(2)).join(" / ")}  (1m / 5m / 15m)`);
  lines.push("");

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const memPercent = ((usedMem / totalMem) * 100).toFixed(1);
  lines.push(`**Memory:** ${formatBytes(usedMem)} / ${formatBytes(totalMem)}  (${memPercent}%)`);
  lines.push("");

  const platform = os.platform();
  try {
    if (platform === "darwin") {
      const raw = execSync("system_profiler SPDisplaysDataType 2>/dev/null", {
        encoding: "utf8",
        timeout: 5000,
      });
      const lines2 = raw.split("\n").map((l) => l.trimStart());
      let inChipset = false;
      const gpuLines: string[] = [];
      for (const l of lines2) {
        if (l.startsWith("Chipset Model:")) {
          inChipset = true;
          gpuLines.push(l);
        } else if (inChipset) {
          if (
            l.startsWith("Vendor:") ||
            l.startsWith("Bus:") ||
            l.startsWith("VRAM") ||
            l.startsWith("Display Type:") ||
            l.startsWith("Resolution:")
          ) {
            gpuLines.push(l);
            if (l.startsWith("Resolution:")) inChipset = false;
          } else if (!l.startsWith(" ") && l !== "" && l.includes(":")) {
            inChipset = false;
          }
        }
        if (gpuLines.length >= 6) break;
      }
      if (gpuLines.length) lines.push(`**GPU:**\n${gpuLines.join("\n")}`);
    } else if (platform === "linux") {
      try {
        const nvidia = execSync(
          "nvidia-smi --query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader 2>/dev/null",
          { encoding: "utf8", timeout: 5000 },
        ).trim();
        if (nvidia) {
          lines.push(`**GPU (NVIDIA):**\n\`\`\`\n${nvidia}\n\`\`\``);
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  if (!lines.some((l) => l.startsWith("**GPU"))) {
    lines.push("**GPU:** (not detected)");
  }
  lines.push("");

  try {
    const df = execSync("df -h / | tail -1", { encoding: "utf8", timeout: 5000 }).trim();
    const parts = df.split(/\s+/);
    if (parts.length >= 5) {
      lines.push(`**Disk (/):** ${parts[2]} used / ${parts[1]} total  (${parts[4]})`);
    }
  } catch {
    /* ignore */
  }

  return lines.join("\n");
}
