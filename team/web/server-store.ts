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
  configuration: any,
  revision = 0,
  preferenceRevision = 0,
  queue = Promise.resolve(),
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
  configuration = c;
  revision = c.saved.version;
  preferenceRevision = c.prefs._version || 0;
  cache = {
    todos: [],
    closeTasks: structuredClone(DEFAULT_CLOSE_TASKS),
    fieldDictionary: structuredClone(DEFAULT_FIELD_DICTIONARY),
    exceptions: [],
    auditLog: [],
    favorites: [],
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
  configuration = null;
  cache = {};
  revision = 0;
  report("");
}
export function getDraft() {
  return structuredClone(cache);
}
export function readFinanceStore(key: string, fallback: any) {
  return structuredClone(cache[key] ?? fallback);
}
export function writeFinanceStore(key: string, value: any) {
  if (key === "auditLog") return true;
  if (key === "profile") {
    report("主体、期间和账号信息由顶部公司选择与账号设置管理");
    return false;
  }
  if (!configuration || (!personal.has(key) && configuration.readOnly)) {
    report("请先选择公司；只读账号不能修改业务记录");
    return false;
  }
  if (issue.startsWith("保存冲突") || issue.startsWith("保存失败"))
    return false;
  const c = configuration;
  cache[key] = structuredClone(value);
  const copy = structuredClone(
    key === "snapshots"
      ? value.filter((s: any) => s.period === c.period)
      : value,
  );
  report("正在保存到团队服务器…");
  queue = queue.then(async () => {
    if (issue.startsWith("保存冲突") || issue.startsWith("保存失败")) return;
    try {
      const result = personal.has(key)
        ? await c.request("/preferences/desk", {
            version: preferenceRevision,
            key,
            value: copy,
          })
        : await c.request(`/companies/${c.companyId}/workspace/${c.period}`, {
            version: revision,
            key,
            value: copy,
          });
      if (personal.has(key)) preferenceRevision = result.version;
      else revision = result.version;
      report("");
    } catch (e: any) {
      report(
        (e.message.includes("修改") ? "保存冲突：" : "保存失败：") +
          e.message +
          "。当前草稿保留在页面；先复制需要保留的内容，再刷新重新读取。",
      );
      c.onNotice(issue);
    }
  });
  return true;
}
export async function flushStore() {
  await queue;
  if (issue.startsWith("保存冲突") || issue.startsWith("保存失败"))
    throw new Error(issue);
}
export function commitFinanceRestore() {
  throw new Error("团队版历史数据必须由负责人通过资料导入预览后确认");
}
