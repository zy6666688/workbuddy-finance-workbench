// Team-only build adapter. The personal plugin still uses its original local storage.
import {
  DEFAULT_CLOSE_TASKS,
  DEFAULT_FIELD_DICTIONARY,
} from "../../src/finance-data.js";
export const STORE_PREFIX = "zy:server:";
const personal = new Set([
  "theme",
  "favorites",
  "recentWorkflows",
  "pinnedFiles",
  "recentOrders",
]);
let cache: Record<string, any> = {},
  context: any,
  issue = "";
const listeners = new Set<() => void>();
const report = (message: string) => {
  issue = message;
  for (const fn of listeners) fn();
};
export const storageIssueSnapshot = () => issue;
export function subscribeStorageIssues(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function configureStore(c: any) {
  // An old request may finish after logout, refresh or a company switch. Its
  // revision/error belongs to the context in which the request was started.
  if (context) context.active = false;
  context = {
    configuration: c,
    revision: c.saved.version,
    preferenceRevision: c.prefs._version || 0,
    queue: Promise.resolve(),
    pending: 0,
    issue: "",
    active: true,
  };
  cache = {
    todos: [],
    closeTasks: structuredClone(DEFAULT_CLOSE_TASKS),
    fieldDictionary: structuredClone(DEFAULT_FIELD_DICTIONARY),
    exceptions: [],
    auditLog: [],
    favorites: c.prefs.favorites || [],
    recentOrders: c.prefs.recent || [],
    recentWorkflows: [],
    pinnedFiles: [],
    theme: c.prefs.theme || "indigo",
    ...c.saved.state,
    ...c.prefs.desk,
    snapshots: [
      ...(c.saved.history || []),
      ...(c.saved.state.snapshots || []),
    ].sort((a, b) => a.period.localeCompare(b.period)),
    profile: c.profile,
  };
  report("");
}
export function clearStore() {
  if (context) context.active = false;
  context = null;
  cache = {};
  report("");
}
export function getDraft() {
  return structuredClone(cache);
}
export function readFinanceStore(key: string, fallback: any) {
  const value = cache[key];
  // The original plugin accepts older backups with partial settings/profile.
  return structuredClone(
    ["settings", "profile"].includes(key)
      ? { ...fallback, ...value }
      : (value ?? fallback),
  );
}
export function writeFinanceStore(key: string, value: any) {
  if (key === "auditLog") return true;
  if (key === "profile") {
    report("主体、期间和账号信息由顶部公司选择与账号设置管理");
    return false;
  }
  if (!context || (!personal.has(key) && context.configuration.readOnly)) {
    report("请先选择公司；只读账号不能修改业务记录");
    return false;
  }
  const current = context;
  const c = current.configuration;
  cache[key] = structuredClone(value);
  // Keep later edits in the exportable draft even when writes are blocked
  // after a conflict. Never silently export an earlier version of the form.
  if (
    current.issue.startsWith("保存冲突") ||
    current.issue.startsWith("保存失败")
  )
    return false;
  const copy = structuredClone(
    key === "snapshots"
      ? value.filter((s: any) => s.period === c.period)
      : value,
  );
  report("正在保存到团队服务器…");
  current.pending++;
  current.queue = current.queue.then(async () => {
    try {
      if (
        !current.active ||
        current.issue.startsWith("保存冲突") ||
        current.issue.startsWith("保存失败")
      )
        return;
      const result = personal.has(key)
        ? await c.request("/preferences/desk", {
            version: current.preferenceRevision,
            key,
            value: copy,
          })
        : await c.request(`/companies/${c.companyId}/workspace/${c.period}`, {
            version: current.revision,
            key,
            value: copy,
          });
      if (personal.has(key)) current.preferenceRevision = result.version;
      else current.revision = result.version;
    } catch (e: any) {
      const message = e instanceof Error ? e.message : String(e);
      current.issue =
        (message.includes("修改") ? "保存冲突：" : "保存失败：") +
        message +
        "。当前草稿保留在页面；先导出草稿，再刷新重新读取。";
      if (current.active) {
        report(current.issue);
        c.onNotice(current.issue);
      }
    } finally {
      current.pending--;
      if (current.active && !current.issue)
        report(current.pending ? "正在保存到团队服务器…" : "");
    }
  });
  return true;
}
export async function flushStore() {
  const current = context;
  if (!current) return;
  let observed;
  do {
    observed = current.queue;
    await observed;
  } while (observed !== current.queue);
  if (current.active && current.issue) throw new Error(current.issue);
}
export function commitFinanceRestore() {
  throw new Error("团队版历史数据必须由负责人通过资料导入预览后确认");
}
