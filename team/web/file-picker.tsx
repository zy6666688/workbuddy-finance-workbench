import { useEffect, useRef, useState } from "preact/hooks";
import {
  fileScopeKey,
  toggleFileSelection,
  filePageQuery,
} from "./file-selection.js";

export type FileScope = { companyId: string; period: string; orderId?: string };
type Props = {
  api: any;
  scope: FileScope;
  purpose?: string;
  runId?: string;
  origin?: string;
  eligibleOnly?: boolean;
  latestOnly?: boolean;
  refreshKey?: string | number;
  title?: string;
  disabled?: boolean;
  selectedIds?: string[];
  onChange?: (ids: string[]) => void;
  maxSelection?: number;
  onReference?: (file: any) => void;
};
const base = (s: FileScope) =>
  s.orderId ? `/orders/${s.orderId}/files` : `/companies/${s.companyId}/files`;
const periodQuery = (s: FileScope) =>
  s.orderId ? "" : `?period=${encodeURIComponent(s.period)}`;
const size = (n: number) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${(n / 1024).toFixed(1)} KB`;

/** Resolves explicit UUIDs, including old versions absent from the current page. */
export function FileSnapshotList({
  api,
  scope,
  ids,
  title = "已选文件",
  onRemove,
  disabled,
  requireEligible = false,
  refreshKey,
}: any) {
  const [state, setState] = useState<any>({
    rows: [],
    unavailableIds: [],
    loading: true,
    error: "",
  });
  const [retry, setRetry] = useState(0);
  const key = fileScopeKey(scope) + JSON.stringify([ids, refreshKey, retry]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    let alive = true;
    setState({
      rows: [],
      unavailableIds: [],
      loading: !!ids.length,
      error: "",
    });
    if (ids.length)
      void api(base(scope) + "/resolve" + periodQuery(scope), { ids })
        .then((data: any) => {
          if (alive && currentKey.current === key)
            setState({ ...data, key, loading: false, error: "" });
        })
        .catch((e: any) => {
          if (alive && currentKey.current === key)
            setState({
              rows: [],
              unavailableIds: [],
              key,
              loading: false,
              error: e.message,
            });
        });
    return () => {
      alive = false;
    };
  }, [key]);
  if (!ids.length) return null;
  return (
    <div className="ops-file-selection">
      <strong>
        {title} · {ids.length} 份
      </strong>
      {state.loading && <p role="status">正在核对所选版本…</p>}
      {state.key === key && state.error && (
        <p role="alert">
          无法核对所选文件：{state.error}。
          <button
            type="button"
            className="secondary"
            onClick={() => setRetry((x) => x + 1)}
          >
            重新核对
          </button>
        </p>
      )}
      {(state.key === key ? state.rows : []).map((f: any) => (
        <div
          className={
            "ops-file-row" +
            (requireEligible && !f.eligible ? " ops-file-ineligible" : "")
          }
          key={f.id}
        >
          <span>
            {f.name}{" "}
            <small>
              v{f.version} · {size(f.size)}
            </small>
            {requireEligible && !f.eligible && (
              <small role="alert">
                该版本已不符合当前选择要求（版本、任务状态或权限已变化），请移除后重新选择。
              </small>
            )}
          </span>
          {f.canDownload && <a href={`/api/v1/files/${f.id}/download`}>下载</a>}
          {onRemove && (
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() => onRemove(f.id)}
            >
              移除
            </button>
          )}
        </div>
      ))}
      {(state.key === key ? state.unavailableIds : []).map((id: string) => (
        <div className="ops-file-row" key={id}>
          <span>文件已不可用或无访问权限 · {id.slice(0, 8)}</span>
          {onRemove && (
            <button
              type="button"
              className="ghost"
              disabled={disabled}
              onClick={() => onRemove(id)}
            >
              移除
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function Files({
  selectedIds = [],
  maxSelection = 100,
  latestOnly = true,
  ...props
}: Props) {
  const {
    api,
    scope,
    purpose = "all",
    runId,
    origin,
    eligibleOnly,
    refreshKey,
    onChange,
    disabled,
    onReference,
    title,
  } = props;
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [fileType, setType] = useState("all"),
    [sort, setSort] = useState("recent"),
    [category, setCategory] = useState(""),
    [pinned, setPinned] = useState(false);
  const [page, setPage] = useState({ offset: 0, version: "" }),
    [data, setData] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [retry, setRetry] = useState(0);
  const scopeKey =
    fileScopeKey(scope) +
    "/" +
    (runId || "") +
    "/" +
    purpose +
    "/" +
    (origin || "");
  const queryKey = JSON.stringify([
    scopeKey,
    query,
    fileType,
    sort,
    category,
    pinned,
    latestOnly,
    eligibleOnly,
    refreshKey,
  ]);
  const requestKey = queryKey + JSON.stringify(page) + retry;
  const currentRequest = useRef(requestKey);
  currentRequest.current = requestKey;
  const confirmedVersion = useRef("");
  const previousScope = useRef(scopeKey),
    activeQuery = useRef(queryKey);
  useEffect(() => {
    if (previousScope.current !== scopeKey) {
      previousScope.current = scopeKey;
      onChange?.([]);
      setSearch("");
      setQuery("");
    }
  }, [scopeKey]);
  useEffect(() => {
    let alive = true;
    const changed = activeQuery.current !== queryKey;
    activeQuery.current = queryKey;
    if (changed && (page.offset || page.version)) {
      setPage({ offset: 0, version: "" });
      return;
    }
    setLoading(true);
    setError("");
    setData(null);
    const q = filePageQuery({
      scope,
      purpose,
      search: query,
      fileType,
      sort,
      latestOnly,
      runId,
      origin,
      eligibleOnly,
      category,
      pinned,
      offset: page.offset,
      pageVersion: page.version,
    });
    void api(base(scope) + "/page?" + q)
      .then((value: any) => {
        if (alive && currentRequest.current === requestKey) {
          confirmedVersion.current = value.pageVersion;
          setData({ ...value, requestKey });
          setLoading(false);
        }
      })
      .catch((e: any) => {
        if (!alive || currentRequest.current !== requestKey) return;
        setLoading(false);
        if (e.status === 409 && page.offset) {
          setNotice("资料列表已更新，已返回第一页；跨页选择仍保留。");
          setPage({ offset: 0, version: "" });
        } else setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [queryKey, page.offset, page.version, retry]);
  const select = (id: string, checked: boolean) => {
    try {
      onChange?.(toggleFileSelection(selectedIds, id, checked, maxSelection));
      setNotice("");
    } catch (e: any) {
      setNotice(e.message);
    }
  };
  return (
    <section className="ops-files" aria-label={title || "文件列表"}>
      {title && <strong>{title}</strong>}
      <div className="ops-file-tools">
        <input
          aria-label="搜索文件名"
          placeholder="搜索文件名"
          value={search}
          onInput={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setQuery(search.trim());
            }
          }}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => setQuery(search.trim())}
        >
          搜索
        </button>
        <select
          aria-label="文件类型"
          value={fileType}
          onChange={(e) => setType(e.currentTarget.value)}
        >
          <option value="all">全部类型</option>
          <option value="sheet">表格</option>
          <option value="document">文档</option>
          <option value="image">图片</option>
          <option value="slides">演示</option>
          <option value="other">其他</option>
        </select>
        <select
          aria-label="文件分类"
          value={category}
          onChange={(e) => setCategory(e.currentTarget.value)}
        >
          <option value="">全部分类</option>
          {(data?.requestKey === requestKey
            ? data?.facets?.categories
            : []
          )?.map((c: string) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label="文件排序"
          value={sort}
          onChange={(e) => setSort(e.currentTarget.value)}
        >
          <option value="recent">最近更新</option>
          <option value="name">文件名称</option>
          <option value="size">文件大小</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={pinned}
            onChange={(e) => setPinned(e.currentTarget.checked)}
          />
          仅置顶
        </label>
      </div>
      {notice && (
        <p className="ops-notice" role="status">
          {notice}
        </p>
      )}
      {loading && <p role="status">正在加载文件…</p>}
      {error && (
        <p role="alert">
          {error}{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => setRetry((x) => x + 1)}
          >
            重试
          </button>
        </p>
      )}
      {data && data.requestKey === requestKey && (
        <>
          <small>
            筛选结果 {data.filteredTotal} 份 · 范围内共{" "}
            {data.scopeSummary.total} 份，{size(data.scopeSummary.bytes)}
          </small>
          <div className="ops-file-list">
            {data.rows.map((f: any) => (
              <div className="ops-file-row" key={f.id}>
                {onChange && (
                  <input
                    aria-label={`选择 ${f.name} v${f.version}`}
                    type="checkbox"
                    checked={selectedIds.includes(f.id)}
                    disabled={
                      disabled || (purpose === "source" && !f.canReference)
                    }
                    onChange={(e) => select(f.id, e.currentTarget.checked)}
                  />
                )}
                <span className="ops-file-name">
                  {f.pinned && "★ "}
                  {f.name}
                  <small>
                    v{f.version} · {f.category} · {size(f.size)}
                  </small>
                </span>
                {f.canDownload && (
                  <a href={`/api/v1/files/${f.id}/download`}>下载</a>
                )}
                {onReference && f.canReference && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => onReference(f)}
                  >
                    引用
                  </button>
                )}
              </div>
            ))}
            {!data.rows.length && <p className="muted">没有符合条件的文件。</p>}
          </div>
          <div className="ops-file-pager">
            <span>
              {data.filteredTotal ? data.offset + 1 : 0}–
              {data.offset + data.rows.length} / {data.filteredTotal}
            </span>
            <button
              type="button"
              className="secondary"
              disabled={loading || !data.offset}
              onClick={() =>
                setPage({
                  offset: Math.max(0, data.offset - data.limit),
                  version: data.pageVersion,
                })
              }
            >
              上一页
            </button>
            <button
              type="button"
              className="secondary"
              disabled={loading || !data.hasMore}
              onClick={() =>
                setPage({
                  offset: data.offset + data.limit,
                  version: data.pageVersion,
                })
              }
            >
              下一页
            </button>
          </div>
        </>
      )}
      {onChange && (
        <FileSnapshotList
          api={api}
          scope={scope}
          ids={selectedIds}
          disabled={disabled}
          requireEligible
          refreshKey={`${refreshKey || ""}/${confirmedVersion.current}`}
          onRemove={(id: string) => select(id, false)}
        />
      )}
    </section>
  );
}
export function FilePicker(
  props: Props & { selectedIds: string[]; onChange: (ids: string[]) => void },
) {
  return <Files {...props} />;
}
export function PagedFiles(props: Props) {
  return <Files latestOnly={false} {...props} />;
}
