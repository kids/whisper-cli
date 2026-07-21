// =============================================================================
// Task store — admin console: work groups ↔ sessions (from feishu-cursor)
// =============================================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
export const TASKS_PATH = resolve(ROOT, ".tasks.json");

export interface TaskEntry {
  chatId: string;
  title: string;
  workspace: string;
  projectLabel: string;
  cursorSessionId: string | null;
  createdAt: number;
  lastActiveAt: number;
  archived: boolean;
}

export interface TaskStore {
  adminChatId: string | null;
  adminOpenId: string | null;
  tasks: TaskEntry[];
}

const MAX_TASKS = 50;

function emptyStore(): TaskStore {
  return { adminChatId: null, adminOpenId: null, tasks: [] };
}

let store: TaskStore = emptyStore();

function load(): void {
  if (!existsSync(TASKS_PATH)) return;
  try {
    store = { ...emptyStore(), ...JSON.parse(readFileSync(TASKS_PATH, "utf-8")) };
  } catch { /* ignore corrupt */ }
}

function save(): void {
  writeFileSync(TASKS_PATH, JSON.stringify(store, null, 2));
}

load();

export function getStore(): TaskStore {
  return store;
}

export function setAdminChat(chatId: string): void {
  if (!store.adminChatId) {
    store.adminChatId = chatId;
    save();
  }
}

export function setAdminOpenId(openId: string): void {
  if (openId && store.adminOpenId !== openId) {
    store.adminOpenId = openId;
    save();
  }
}

export function isAdminChat(chatId: string, configured?: string): boolean {
  if (configured && chatId === configured) return true;
  if (store.adminChatId) return chatId === store.adminChatId;
  return false;
}

export function getTaskByChatId(chatId: string): TaskEntry | undefined {
  return store.tasks.find((t) => t.chatId === chatId && !t.archived);
}

export function findTask(query: string): TaskEntry | undefined {
  const q = query.toLowerCase();
  return store.tasks.find(
    (t) => t.chatId.startsWith(q) || t.title.toLowerCase().includes(q),
  );
}

export function addTask(
  entry: Omit<TaskEntry, "createdAt" | "lastActiveAt" | "archived" | "cursorSessionId">,
): TaskEntry {
  const task: TaskEntry = {
    ...entry,
    cursorSessionId: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    archived: false,
  };
  store.tasks.unshift(task);
  if (store.tasks.length > MAX_TASKS) store.tasks = store.tasks.slice(0, MAX_TASKS);
  save();
  return task;
}

export function updateTaskSession(chatId: string, cursorSessionId: string, title?: string): void {
  const task = store.tasks.find((t) => t.chatId === chatId);
  if (!task) return;
  task.cursorSessionId = cursorSessionId;
  task.lastActiveAt = Date.now();
  if (title && (task.title === "(新任务)" || !task.title)) task.title = title;
  save();
}

export function archiveTask(chatId: string): TaskEntry | null {
  const task = store.tasks.find((t) => t.chatId === chatId);
  if (!task) return null;
  task.archived = true;
  save();
  return task;
}

export function listTasks(activeOnly = false): TaskEntry[] {
  const list = activeOnly ? store.tasks.filter((t) => !t.archived) : store.tasks;
  return [...list].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function titleFromPrompt(prompt: string): string {
  const noise = /^(帮我|请你?|麻烦|你好|嗨|hi|hello|hey|ok|好的|嗯|哦)[，,。.！!？?\s]*/gi;
  const cleaned = prompt.replace(noise, "").trim();
  if (cleaned.length >= 2 && cleaned.length <= 36) return cleaned;
  if (cleaned.length > 36) return cleaned.slice(0, 34) + "…";
  return cleaned || "新任务";
}

export function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}小时前`;
  return `${Math.floor(diff / 86400_000)}天前`;
}
