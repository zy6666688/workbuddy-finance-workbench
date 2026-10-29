/** Selection is independent of the loaded page and never keyed by a filename. */
export function toggleFileSelection(
  ids: string[],
  id: string,
  checked: boolean,
  max = 100,
) {
  const selected = new Set(ids);
  if (checked) {
    if (!selected.has(id) && selected.size >= max)
      throw Error(`最多选择 ${max} 份文件，请分批处理`);
    selected.add(id);
  } else selected.delete(id);
  return [...selected];
}
export function fileScopeKey(scope: {
  companyId: string;
  period: string;
  orderId?: string;
}) {
  return [scope.companyId, scope.period, scope.orderId || ""].join("/");
}

export function filePageQuery(options: {
  scope: { companyId: string; period: string; orderId?: string };
  purpose?: string;
  search?: string;
  fileType?: string;
  sort?: string;
  category?: string;
  latestOnly?: boolean;
  eligibleOnly?: boolean;
  pinned?: boolean;
  runId?: string;
  origin?: string;
  offset?: number;
  pageVersion?: string;
}) {
  const q = new URLSearchParams({
    kind: options.purpose || "all",
    search: options.search || "",
    fileType: options.fileType || "all",
    sort: options.sort || "recent",
    latestOnly: String(options.latestOnly !== false),
    limit: "50",
    offset: String(options.offset || 0),
  });
  if (!options.scope.orderId) q.set("period", options.scope.period);
  if (options.runId) q.set("runId", options.runId);
  if (options.origin) q.set("origin", options.origin);
  if (options.eligibleOnly || options.purpose === "evidence")
    q.set("eligibleOnly", "true");
  if (options.category) q.set("category", options.category);
  if (options.pinned) q.set("pinnedOnly", "true");
  if (options.offset && options.pageVersion)
    q.set("pageVersion", options.pageVersion);
  return q;
}
