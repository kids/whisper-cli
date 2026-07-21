// =============================================================================
// projects.json — workspace routing (from feishu-cursor)
// =============================================================================
import { readFileSync, existsSync, watchFile } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

export interface ProjectEntry {
  path: string;
  description: string;
  systemPromptFile?: string;
}

export interface ProjectsConfig {
  projects: Record<string, ProjectEntry>;
  default_project: string;
}

export const PROJECTS_PATH = resolve(ROOT, "projects.json");

let cached: ProjectsConfig | null = null;

export function loadProjects(path = PROJECTS_PATH): ProjectsConfig {
  if (!existsSync(path)) {
    return { projects: {}, default_project: "" };
  }
  cached = JSON.parse(readFileSync(path, "utf-8")) as ProjectsConfig;
  return cached;
}

export function getProjects(): ProjectsConfig {
  return cached ?? loadProjects();
}

/** Route `project:prompt` or fall back to default / provided fallback */
export function routePrompt(
  text: string,
  fallback?: { workspace: string; label: string },
): { workspace: string; prompt: string; label: string; project?: ProjectEntry } {
  const cfg = getProjects();
  const m = text.match(/^(\S+?)[:\uff1a]\s*(.+)/s);
  if (m) {
    const key = m[1].toLowerCase();
    const project = cfg.projects[key] || cfg.projects[m[1]];
    if (project) {
      return {
        workspace: project.path,
        prompt: m[2].trim(),
        label: key,
        project,
      };
    }
  }
  if (fallback) {
    return {
      workspace: fallback.workspace,
      prompt: text.trim(),
      label: fallback.label,
      project: cfg.projects[fallback.label],
    };
  }
  const def = cfg.default_project;
  const project = cfg.projects[def];
  return {
    workspace: project?.path || ROOT,
    prompt: text.trim(),
    label: def || "default",
    project,
  };
}

export function watchProjects(onChange: () => void): void {
  if (!existsSync(PROJECTS_PATH)) return;
  watchFile(PROJECTS_PATH, { interval: 5000 }, () => {
    loadProjects();
    onChange();
  });
}
