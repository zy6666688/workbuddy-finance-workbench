import {
  BatchUpload,
  Followups,
  WorkBuddyHandoff,
  TeamManagement,
} from "./operations.js";
import { render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import "./style.css";
import { AuthLayout, AuthPassword } from "./auth.js";
import { ClientWorkspace, ReviewCenter } from "./agency.js";
import {
  DeliveryOverview,
  DeliveryDetailHeader,
  DeliveryActivity,
  defaultDeliveryQuery,
} from "./delivery.js";
import { FinanceDashboard } from "../../src/finance-dashboard.jsx";
import {
  writeFinanceStore,
  configureStore,
  flushStore,
  clearStore,
  getDraft,
} from "./server-store.js";

const statusNames: Record<string, string> = {
  collecting: "待收集",
  checking: "整理核对",
  processing: "经办处理中",
  review: "待复核",
  delivery: "待交付",
  archived: "已归档",
  pending: "等待处理",
  running: "处理中",
  completed: "已完成",
  failed: "失败",
  external: "外部处理中",
  returned: "已回传",
  stale: "输入已变更",
};
const roleNames: Record<string, string> = {
  owner: "负责人",
  reviewer: "主管 / 复核",
  operator: "经办",
  viewer: "只读",
};
const steps = [
  "collecting",
  "checking",
  "processing",
  "review",
  "delivery",
  "archived",
];
let csrf = "";
async function api(url: string, body?: any) {
  const r = await fetch("/api/v1" + url, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : body instanceof FormData
          ? { "x-csrf-token": csrf }
          : { "Content-Type": "application/json", "x-csrf-token": csrf },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error || "请求失败"), {
      status: r.status,
    });
  return data;
}
function values(e: Event) {
  e.preventDefault();
  return Object.fromEntries(new FormData(e.currentTarget as HTMLFormElement));
}
function Field({
  name,
  label,
  type = "text",
  required = true,
  value,
  children,
}: any) {
  return (
    <label>
      {label}
      {children || (
        <input
          name={name}
          type={type}
          required={required}
          defaultValue={value}
        />
      )}
    </label>
  );
}
function Badge({ value }: any) {
  return (
    <span className={"badge " + value}>{statusNames[value] || value}</span>
  );
}
function Panel({ title, note, children }: any) {
  return (
    <section className="panel">
      <header>
        <h2>{title}</h2>
        {note && <p>{note}</p>}
      </header>
      {children}
    </section>
  );
}
function App() {
  const [deskReady, setDeskReady] = useState(""),
    [deskEpoch, setDeskEpoch] = useState(0),
    [viewRequest, setViewRequest] = useState<any>(null),
    [references, setReferences] = useState<string[]>([]),
    [workspaceFiles, setWorkspaceFiles] = useState<any[]>([]);
  const uploadPicker = useRef<HTMLInputElement>(null),
    folderPicker = useRef<HTMLInputElement>(null);
  const [user, setUser] = useState<any>(null),
    [loading, setLoading] = useState(true),
    [page, setPage] = useState("finance"),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [companies, setCompanies] = useState<any[]>([]),
    [selectedCompany, setSelectedCompany] = useState<any>(null),
    [companySearch, setCompanySearch] = useState(""),
    [companySearchDone, setCompanySearchDone] = useState(false),
    [cid, setCid] = useState(""),
    [period, setPeriod] = useState(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
      })
        .format(new Date())
        .replace("/", "-"),
    );
  const [rows, setRows] = useState<any[]>([]),
    [detail, setDetail] = useState<any>(null),
    [users, setUsers] = useState<any[]>([]),
    [workflows, setWorkflows] = useState<any[]>([]),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [filter, setFilter] = useState(""),
    [preview, setPreview] = useState<any>(null),
    [health, setHealth] = useState<any>(null),
    [theme, setTheme] = useState("indigo"),
    [favorites, setFavorites] = useState<string[]>([]),
    [recent, setRecent] = useState<string[]>([]);
  const [deliveryQuery, setDeliveryQuery] = useState(defaultDeliveryQuery),
    [deliveryStats, setDeliveryStats] = useState<any>(null),
    [showCreate, setShowCreate] = useState(false),
    [batchMode, setBatchMode] = useState(false),
    [detailTab, setDetailTab] = useState("materials");
  const pendingOpen = useRef("");
  const activeView = useRef("home");
  const companyRequest = useRef(0),
    pendingActions = useRef(0);
  const selectedCompanyId = useRef(cid);
  selectedCompanyId.current = cid;
  const generation = useRef(0),
    fileRef = useRef<HTMLInputElement>(null),
    [members, setMembers] = useState<any[]>([]);
  const owner = user?.role === "owner",
    reviewer = owner || user?.role === "reviewer",
    write = user?.role !== "viewer";
  const current =
    companies.find((c) => c.id === cid) ||
    (selectedCompany?.id === cid ? selectedCompany : null);
  const canReviewDetail =
    reviewer &&
    detail &&
    detail.assignee_id !== user?.id &&
    !detail.contributors.includes(user?.id) &&
    detail.submission?.submittedBy !== user?.id &&
    (owner || detail.reviewer_id === user?.id);
  const run = async (fn: () => Promise<any>, message = "已保存") => {
    const startedIn = activeDeskKey.current;
    pendingActions.current++;
    setBusy(true);
    setNotice("");
    try {
      await fn();
      if (message && activeDeskKey.current === startedIn) setNotice(message);
    } catch (e: any) {
      if (activeDeskKey.current === startedIn) setNotice(e.message);
    } finally {
      pendingActions.current--;
      setBusy(pendingActions.current > 0);
    }
  };
  async function loadMe() {
    try {
      const u = await api("/auth/me");
      csrf = u.csrf;
      setUser(u);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void loadMe();
  }, []);
  async function loadCompanies(q = "") {
    const request = ++companyRequest.current;
    const c = await api(
      "/companies?limit=100&search=" + encodeURIComponent(q.trim()),
    );
    if (request !== companyRequest.current) return;
    setCompanies(c);
    const selected = c.find(
      (item: any) => item.id === selectedCompanyId.current,
    );
    if (selected) setSelectedCompany(selected);
    setCompanySearchDone(true);
  }
  useEffect(() => {
    if (!user || user.must_change_password) return;
    void run(async () => {
      await loadCompanies();
      setWorkflows(await api("/workflows"));
      if (reviewer) setUsers(await api("/users"));
      const p = await api("/preferences");
      setTheme(p.theme || "indigo");
      setFavorites(p.favorites || []);
      setRecent(p.desk?.recentOrders || []);
    }, "");
  }, [user?.id, user?.must_change_password]);
  async function refresh() {
    const gen = ++generation.current;
    let data: any[] = [];
    if (page === "orders") {
      const params = new URLSearchParams({
        ...deliveryQuery,
        companyId: cid,
        period,
        status: filter,
        offset: String(offset),
      });
      const [list, summary] = await Promise.all([
        api("/orders?" + params),
        api("/orders/overview?" + params),
      ]);
      data = list;
      if (gen === generation.current) setDeliveryStats(summary);
    }
    if (page === "companies")
      data = await api(
        `/companies?search=${encodeURIComponent(search)}&offset=${offset}`,
      );
    if (page === "jobs") data = await api("/jobs");
    if (page === "audit")
      data = await api(`/audit?companyId=${cid}&offset=${offset}`);
    if (page === "users") data = await api("/users");
    if (page === "health") {
      const h = await api("/admin/health");
      if (gen === generation.current) setHealth(h);
    }
    if (gen === generation.current) setRows(data);
  }
  useEffect(() => {
    if (!user || user.must_change_password) return;
    setRows([]);
    setDetail(null);
    setPreview(null);
    setMembers([]);
    if (pendingOpen.current) {
      const id = pendingOpen.current;
      pendingOpen.current = "";
      void run(() => openOrder(id), "");
    } else void run(refresh, "");
  }, [
    page,
    cid,
    period,
    offset,
    filter,
    deliveryQuery,
    user?.must_change_password,
  ]);
  useEffect(() => {
    setOffset(0);
    setShowCreate(false);
    setDeliveryStats(null);
  }, [cid, period, page]);
  useEffect(() => {
    if (page !== "jobs" || !user) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [page, user?.id]);
  const activeOrder = useRef<string | undefined>(undefined);
  activeOrder.current = detail?.id;
  async function refreshOrder(id: string) {
    if (activeOrder.current === id) await openOrder(id);
  }
  async function openOrder(id: string) {
    const gen = ++generation.current;
    const d = await api("/orders/" + id);
    if (gen === generation.current) {
      if (d.period !== period) {
        await flushStore();
        if (gen !== generation.current) return;
        pendingOpen.current = id;
        setViewRequest({ id: Date.now(), view: "team:" + page });
        setPeriod(d.period);
        return;
      }
      if (detail?.id !== d.id || detail?.status !== d.status)
        setDetailTab(
          ["collecting", "checking"].includes(d.status)
            ? "materials"
            : d.status === "processing"
              ? "processing"
              : "review",
        );
      setDetail(d);
      const next = [id, ...recent.filter((x) => x !== id)].slice(0, 10);
      if (next.join() !== recent.join()) {
        setRecent(next);
        writeFinanceStore("recentOrders", next);
      }
    }
  }
  async function orderAction(action: string, extra: any = {}) {
    await api(`/orders/${detail.id}/action`, {
      version: detail.version,
      action,
      ...extra,
    });
    await refreshOrder(detail.id);
  }
  async function enqueue(kind: string, payload: any, companyId = cid) {
    await api("/jobs", {
      kind,
      payload,
      companyId: companyId || undefined,
      key: crypto.randomUUID(),
    });
    if (activeDeskKey.current !== deskKey) return;
    setPage("jobs");
    setDetail(null);
  }
  function navigate(p: string) {
    setViewRequest({ id: Date.now(), view: "team:" + p });
    generation.current++;
    setPage(p);
    setOffset(0);
    setDetail(null);
    setPreview(null);
    setNotice("");
  }
  const deskKey =
    user && !user.must_change_password ? `${user.id}/${cid}/${period}` : "";
  const activeDeskKey = useRef(deskKey);
  activeDeskKey.current = deskKey;
  const [deskLoadAttempt, setDeskLoadAttempt] = useState(0);
  const [deskLoadError, setDeskLoadError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setDeskReady("");
    setWorkspaceFiles([]);
    setReferences([]);
    setDeskLoadError("");
    if (!deskKey) return;
    void (async () => {
      try {
        await flushStore();
        const [saved, prefs, files] = await Promise.all([
          cid
            ? api(`/companies/${cid}/workspace/${period}`)
            : Promise.resolve({ version: 0, state: {} }),
          api("/preferences"),
          cid
            ? api(`/companies/${cid}/files?period=${period}`)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        configureStore({
          key: deskKey,
          companyId: cid,
          period,
          saved,
          prefs,
          profile: {
            name: user.name,
            entity: current?.name || "请先选择客户公司",
            role: roleNames[user.role],
            period,
          },
          readOnly: !write || !cid,
          request: api,
          onNotice: setNotice,
        });
        setWorkspaceFiles(files);
        setDeskEpoch((x) => x + 1);
        setDeskReady(deskKey);
      } catch (e: any) {
        if (!cancelled) {
          setNotice(e.message);
          setDeskLoadError(e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deskKey, deskLoadAttempt]);
  async function uploadToMonth(selected: File[]) {
    if (!cid) throw new Error("请先选择客户公司");
    const orders = await api(`/orders?companyId=${cid}&period=${period}`);
    if (!orders.length) throw new Error("请先到月度交付创建本月工作单");
    let order = await api("/orders/" + orders[0].id);
    for (const f of selected) {
      if (activeDeskKey.current !== deskKey) return;
      const body = new FormData();
      body.set("file", f);
      await api(
        `/orders/${order.id}/files?kind=source&version=${order.version}`,
        body,
      );
      order = await api("/orders/" + order.id);
    }
    const files = await api(`/companies/${cid}/files?period=${period}`);
    if (activeDeskKey.current === deskKey) setWorkspaceFiles(files);
  }
  if (loading)
    return (
      <AuthLayout>
        <h2>正在连接工作台</h2>
        <p role="status">请稍候，正在确认登录状态…</p>
      </AuthLayout>
    );
  if (!user)
    return (
      <AuthLayout>
        <span className="zyAuth-entryTag">团队工作空间</span>
        <h2>欢迎回来</h2>
        <p>登录账号，继续今天的财务工作。</p>
        <form
          aria-busy={busy}
          onSubmit={(e) => {
            const b = values(e);
            void run(async () => {
              const r = await api("/auth/login", b);
              csrf = r.csrf;
              await loadMe();
            }, "");
          }}
        >
          <div className="zyAuth-field">
            <label htmlFor="auth-username">账号</label>
            <input
              id="auth-username"
              name="username"
              required
              autoComplete="username"
              autoCapitalize="none"
              spellcheck={false}
              placeholder="请输入团队账号"
            />
          </div>
          <AuthPassword />
          <button className="zyAuth-submit" disabled={busy}>
            {busy ? "正在登录…" : "登录工作台"}
          </button>
        </form>
        {notice && (
          <p role="alert" className="zyAuth-notice">
            {notice}
          </p>
        )}
        <p className="zyAuth-help">忘记密码？请联系团队负责人重置。</p>
        <p className="zyAuth-accountNote">
          账号由团队负责人统一分配。首次登录后，请按提示设置你的专属密码。
        </p>
      </AuthLayout>
    );
  if (user.must_change_password)
    return (
      <AuthLayout>
        <span className="zyAuth-entryTag">首次登录</span>
        <h2>设置你的专属密码</h2>
        <p>初始密码仅用于首次登录。修改后请重新登录。</p>
        <form
          onSubmit={(e) => {
            const b = values(e);
            void run(async () => {
              await api("/auth/password", b);
              setUser(null);
            }, "密码已修改，请重新登录");
          }}
        >
          <AuthPassword label="初始密码" name="current" />
          <AuthPassword label="新密码（至少 12 位）" fresh />
          <button className="zyAuth-submit" disabled={busy}>
            {busy ? "正在保存…" : "保存新密码"}
          </button>
        </form>
        <button
          className="zyAuth-back"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              await api("/auth/logout", {});
              setUser(null);
              clearStore();
            }, "")
          }
        >
          返回登录
        </button>
        {notice && (
          <p className="zyAuth-notice" role="alert">
            {notice}
          </p>
        )}
      </AuthLayout>
    );
  const teamPages = [
    ["orders", "月度交付"],
    ["companies", "客户公司"],
    ["imports", "资料导入"],
    ["jobs", "后台任务"],
    ["audit", "操作记录"],
    ["account", "账号设置"],
    ...(reviewer
      ? [
          ["review", "审核中心"],
          ["users", "团队成员"],
        ]
      : []),
    ...(owner ? [["health", "运行与备份"]] : []),
  ];
  const teamContent = () => (
    <div className="team-panels" aria-busy={busy}>
      {notice && (
        <div className="notice" role="alert">
          {notice}
          <button className="ghost" onClick={() => setNotice("")}>
            关闭
          </button>
        </div>
      )}
      {page === "orders" && !detail && (
        <>
          {reviewer && showCreate && (
            <div className="delivery-create">
              <div className="delivery-createHead">
                <h2>安排客户月份</h2>
                <button className="ghost" onClick={() => setShowCreate(false)}>
                  收起
                </button>
              </div>
              <Panel
                title="安排月度工作"
                note="每家公司每月一份；重复创建不会新增。批量建立前请明确勾选客户。经办与复核必须不同人。"
              >
                <form
                  className="formgrid"
                  onSubmit={(e) => {
                    const b = values(e),
                      selectedCompanies = new FormData(
                        e.currentTarget as HTMLFormElement,
                      ).getAll("companyIds");
                    void run(async () => {
                      if (b.assigneeId === b.reviewerId)
                        throw new Error("经办与复核必须选择不同人员");
                      const payload = {
                        period,
                        dueDate: b.dueDate,
                        assigneeId: b.assigneeId,
                        reviewerId: b.reviewerId,
                      };
                      if (b.mode === "batch") {
                        if (!selectedCompanies.length)
                          throw new Error("请勾选需要安排的客户公司");
                        await enqueue(
                          "monthly_batch",
                          {
                            ...payload,
                            companyIds: selectedCompanies,
                          },
                          "",
                        );
                      } else {
                        if (!b.companyId) throw new Error("请选择客户公司");
                        await api("/orders", {
                          companyId: b.companyId,
                          ...payload,
                        });
                        await refresh();
                        setShowCreate(false);
                      }
                    }, "工作已安排");
                  }}
                >
                  {!batchMode && (
                    <Field label="客户公司">
                      <select name="companyId" required defaultValue={cid}>
                        <option value="">请选择客户公司</option>
                        {companies.map((c) => (
                          <option value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <Field label="经办人员">
                    <select name="assigneeId" required>
                      {users
                        .filter((u) => u.active && u.role !== "viewer")
                        .map((u) => (
                          <option value={u.id}>{u.name}</option>
                        ))}
                    </select>
                  </Field>
                  <Field label="复核人员">
                    <select name="reviewerId" required>
                      {users
                        .filter(
                          (u) =>
                            u.active && ["owner", "reviewer"].includes(u.role),
                        )
                        .map((u) => (
                          <option value={u.id}>{u.name}</option>
                        ))}
                    </select>
                  </Field>
                  <Field label="截止日期" name="dueDate" type="date" />
                  <Field label="创建方式">
                    <select
                      name="mode"
                      value={batchMode ? "batch" : "single"}
                      onChange={(e) =>
                        setBatchMode(e.currentTarget.value === "batch")
                      }
                    >
                      <option value="single">单个客户</option>
                      <option value="batch">勾选客户批量生成</option>
                    </select>
                  </Field>
                  {batchMode && (
                    <fieldset className="delivery-companyPick">
                      <legend>
                        选择客户（当前已加载 {companies.length} 家）
                      </legend>
                      {companies.map((c) => (
                        <label className="check">
                          <input
                            type="checkbox"
                            name="companyIds"
                            value={c.id}
                          />
                          {c.name}
                        </label>
                      ))}
                      <small>查找更多客户可使用顶部客户搜索。</small>
                    </fieldset>
                  )}
                  <button disabled={busy}>确认安排</button>
                </form>
              </Panel>
            </div>
          )}
          <DeliveryOverview
            rows={rows}
            stats={deliveryStats}
            period={period}
            company={current?.name}
            reviewOnly={false}
            query={deliveryQuery}
            filter={filter}
            offset={offset}
            busy={busy}
            canCreate={reviewer}
            onQuery={(q: any) => {
              setDeliveryQuery(q);
              setOffset(0);
            }}
            onFilter={(s: string) => {
              setFilter(s);
              setOffset(0);
            }}
            onOffset={setOffset}
            onOpen={(id: string) => void run(() => openOrder(id), "")}
            onRefresh={() => void run(refresh, "已刷新")}
            onCreate={() => setShowCreate(true)}
            onNavigate={navigate}
          />
        </>
      )}
      {["orders", "review"].includes(page) && detail && (
        <div
          className={`team-order-layout tab-${detailTab} ${!write || detail.status === "archived" ? "no-upload" : ""}`}
        >
          <DeliveryDetailHeader
            order={detail}
            backLabel={page === "review" ? "返回审核队列" : "返回工作清单"}
            tab={detailTab}
            onTab={setDetailTab}
            onBack={() => {
              setDetail(null);
              void run(refresh, "");
            }}
          />
          <div
            className="delivery-section order-upload"
            hidden={
              detailTab === "history" || !write || detail.status === "archived"
            }
          >
            {write && detail.status !== "archived" && (
              <Panel title="资料上传">
                {" "}
                {write && detail.status !== "archived" && (
                  <BatchUpload
                    key={detail.id}
                    detail={detail}
                    api={api}
                    onRefresh={() => refreshOrder(detail.id)}
                    defaultKind={
                      detailTab === "processing"
                        ? "result"
                        : detailTab === "review"
                          ? "evidence"
                          : "source"
                    }
                  />
                )}
              </Panel>
            )}
          </div>
          <div
            className="delivery-section order-followup"
            hidden={detailTab !== "materials"}
          >
            {detailTab === "materials" && (
              <Followups
                key={"follow-" + detail.id}
                detail={detail}
                api={api}
                onRefresh={() => refreshOrder(detail.id)}
                write={write}
              />
            )}
          </div>
          <div
            className="delivery-section order-materials"
            hidden={detailTab !== "materials"}
          >
            <Panel
              title="资料清单"
              note="原件必须与本公司、本期间关联。缺件豁免需要独立复核人员说明理由。"
            >
              {write &&
                detail.checklist.some(
                  (i: any) => i.required && !i.fileId && !i.waiver,
                ) && (
                  <button
                    className="secondary"
                    onClick={() =>
                      void run(async () => {
                        await navigator.clipboard.writeText(
                          [
                            `${detail.company_name}｜${detail.period} 资料补充清单`,
                            ...detail.checklist
                              .filter(
                                (i: any) =>
                                  i.required && !i.fileId && !i.waiver,
                              )
                              .map(
                                (i: any, n: number) => `${n + 1}. ${i.name}`,
                              ),
                            `工作截止日期：${detail.due_date}`,
                            "请提供对应期间的资料，收到后由经办核对。",
                          ].join("\n"),
                        );
                      }, "补件清单已复制，请核对后自行发送给客户")
                    }
                  >
                    复制补件清单
                  </button>
                )}
              {detail.checklist.map((item: any, i: number) => (
                <div className="material">
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.required ? "必需" : "可选"} ·{" "}
                      {item.fileId
                        ? "已收集"
                        : item.waiver
                          ? "已豁免"
                          : "待补充"}
                    </small>
                  </div>
                  {detail.status === "collecting" && write && !item.fileId && (
                    <form
                      className="agency-material-upload"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        const data = new FormData(form);
                        void run(async () => {
                          await api(
                            `/orders/${detail.id}/files?kind=source&version=${detail.version}&materialIndex=${i}&category=${encodeURIComponent(item.name)}`,
                            data,
                          );
                          await refreshOrder(detail.id);
                        }, "原件已上传并关联到资料清单");
                      }}
                    >
                      <label>
                        {item.name}原件
                        <input
                          type="file"
                          name="file"
                          required
                          accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.txt,.docx"
                        />
                      </label>
                      <button disabled={busy}>上传并关联</button>
                    </form>
                  )}
                  {detail.status === "collecting" && write && (
                    <form
                      onSubmit={(e) => {
                        const b = values(e);
                        void run(async () => {
                          await api(`/orders/${detail.id}/material`, {
                            version: detail.version,
                            index: i,
                            action: "receive",
                            fileId: b.fileId,
                          });
                          await refreshOrder(detail.id);
                        });
                      }}
                    >
                      <select
                        name="fileId"
                        defaultValue={item.fileId || ""}
                        aria-label={item.name + "对应文件"}
                        required
                      >
                        <option value="">选择原件</option>
                        {detail.files
                          .filter((f: any) => f.kind === "source")
                          .map((f: any) => (
                            <option value={f.id}>
                              {f.name} · v{f.version}
                            </option>
                          ))}
                      </select>
                      <button className="secondary" disabled={busy}>
                        关联
                      </button>
                    </form>
                  )}
                  {detail.status === "collecting" &&
                    canReviewDetail &&
                    !item.fileId &&
                    !item.waiver && (
                      <form
                        onSubmit={(e) => {
                          const b = values(e);
                          void run(async () => {
                            await api(`/orders/${detail.id}/material`, {
                              version: detail.version,
                              index: i,
                              action: "waive",
                              reason: b.reason,
                            });
                            await refreshOrder(detail.id);
                          });
                        }}
                      >
                        <input
                          name="reason"
                          required
                          aria-label={item.name + "豁免理由"}
                          placeholder="豁免理由"
                        />
                        <button className="ghost" disabled={busy}>
                          豁免
                        </button>
                      </form>
                    )}
                </div>
              ))}
            </Panel>
          </div>
          <div
            className="delivery-section order-actions"
            hidden={
              detailTab !==
              (["collecting", "checking"].includes(detail.status)
                ? "materials"
                : detail.status === "processing"
                  ? "processing"
                  : "review")
            }
          >
            <Panel
              title="当前阶段操作"
              note="状态由服务端检查。经办不能复核自己的交付。"
            >
              {detailTab === "review" && detail.submission && (
                <div className="delivery-submission">
                  <h3>本次送审成果 · 第 {detail.submission.revision} 版</h3>
                  <p>{detail.submission.checks?.summary}</p>
                  {detail.submission.checks?.unresolved && (
                    <p>未解决事项：{detail.submission.checks.unresolved}</p>
                  )}
                  <div className="filelist">
                    {detail.submission.files.map((f: any) => (
                      <div>
                        <strong>
                          {f.name} · v{f.version}
                        </strong>
                        {write && (
                          <a href={"/api/v1/files/" + f.id + "/download"}>
                            下载送审版本
                          </a>
                        )}
                      </div>
                    ))}
                  </div>
                  <small>复核针对以上版本；替换成果后需要重新提交。</small>
                </div>
              )}
              {["collecting", "checking"].includes(detail.status) && write && (
                <button
                  disabled={
                    busy ||
                    (detail.status === "collecting" &&
                      detail.checklist.some(
                        (i: any) => i.required && !i.fileId && !i.waiver,
                      ))
                  }
                  onClick={() =>
                    void run(() =>
                      orderAction(
                        detail.status === "collecting"
                          ? "finish_collection"
                          : "start_processing",
                      ),
                    )
                  }
                >
                  {detail.status === "collecting"
                    ? "资料齐备，进入核对"
                    : "核对完成，进入处理"}
                </button>
              )}
              {detail.status === "processing" && (
                <div className="agency-readiness">
                  <h3>送审前检查</h3>
                  {detail.reviews[0]?.action === "reject" && (
                    <p className="agency-warning">
                      上次退回：{detail.reviews[0].reason}
                    </p>
                  )}
                  <ul>
                    {detail.readiness.items.map((i: any) => (
                      <li>
                        {i.ok ? "已具备" : "待完成"} · {i.label}
                      </li>
                    ))}
                  </ul>
                  <p>以上检查通过后，仍须经办填写校验说明并确认成果。</p>
                </div>
              )}
              {detail.status === "processing" && write && (
                <form
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(() =>
                      orderAction("submit", {
                        checks: {
                          passed: b.passed === "on",
                          summary: b.summary,
                          unresolved: b.unresolved,
                        },
                      }),
                    );
                  }}
                >
                  <Field label="校验说明">
                    <textarea
                      name="summary"
                      required
                      placeholder="记录行数、金额勾稽、文件检查结果"
                    />
                  </Field>
                  <Field label="未解决事项">
                    <textarea
                      name="unresolved"
                      placeholder="没有未解决事项时留空"
                    />
                  </Field>
                  <label className="check">
                    <input type="checkbox" name="passed" required />
                    我已核对成果与来源，校验通过
                  </label>
                  <button disabled={busy || !detail.readiness.ready}>
                    提交独立复核
                  </button>
                </form>
              )}
              {detail.status === "review" && !canReviewDetail && (
                <p className="muted">
                  本批次等待 {detail.reviewer_name || "指定复核人员"}{" "}
                  独立复核。参与过经办的人员不能审核自己的成果。
                </p>
              )}
              {detail.status === "review" && canReviewDetail && (
                <form
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(() =>
                      orderAction(String(b.action), { reason: b.reason }),
                    );
                  }}
                >
                  <Field label="复核意见">
                    <textarea required name="reason" />
                  </Field>
                  <Field label="处理结论">
                    <select name="action">
                      <option value="approve">通过复核</option>
                      <option value="reject">退回经办</option>
                    </select>
                  </Field>
                  <button disabled={busy}>提交复核结论</button>
                </form>
              )}
              {detail.status === "delivery" && write && (
                <form
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(() =>
                      orderAction("deliver", {
                        delivery: {
                          channel: b.channel,
                          evidenceFileId: b.evidenceFileId,
                        },
                      }),
                    );
                  }}
                >
                  <Field label="实际交付方式" name="channel" />
                  <Field label="交付证据">
                    <select name="evidenceFileId" required>
                      {detail.files
                        .filter(
                          (f: any) =>
                            f.kind === "evidence" &&
                            f.category !== "系统任务包",
                        )
                        .map((f: any) => (
                          <option value={f.id}>{f.name}</option>
                        ))}
                    </select>
                  </Field>
                  <button disabled={busy}>登记交付并归档</button>
                </form>
              )}
              {detail.status === "archived" && write && (
                <form
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(() =>
                      orderAction(
                        detail.reopen_request &&
                          canReviewDetail &&
                          detail.reopen_request.by !== user.id
                          ? "reopen"
                          : "request_reopen",
                        { reason: b.reason },
                      ),
                    );
                  }}
                >
                  <p>
                    归档成果已冻结。
                    {detail.reopen_request
                      ? "已有重开申请，等待独立审批。"
                      : "需要更正时，先申请重开。"}
                  </p>
                  {detail.reopen_request && (
                    <p className="agency-warning">
                      重开申请：{detail.reopen_request.reason} ·{" "}
                      {new Date(detail.reopen_request.at).toLocaleString(
                        "zh-CN",
                        { timeZone: "Asia/Shanghai" },
                      )}
                    </p>
                  )}
                  <Field label="原因">
                    <textarea name="reason" required />
                  </Field>
                  <button
                    disabled={
                      busy ||
                      (!!detail.reopen_request &&
                        (!canReviewDetail ||
                          detail.reopen_request.by === user.id))
                    }
                  >
                    {detail.reopen_request &&
                    canReviewDetail &&
                    detail.reopen_request.by !== user.id
                      ? "批准重开"
                      : "申请重开"}
                  </button>
                </form>
              )}
              {["delivery", "archived"].includes(detail.status) && write && (
                <button
                  className="secondary"
                  onClick={() =>
                    void run(
                      () =>
                        enqueue(
                          "delivery_export",
                          { orderId: detail.id },
                          detail.company_id,
                        ),
                      "已提交打包",
                    )
                  }
                >
                  生成已审核交付包
                </button>
              )}
            </Panel>
          </div>
          <div
            className="delivery-section order-files"
            hidden={detailTab === "history"}
          >
            <Panel
              title="资料与成果文件"
              note="上传同名文件会形成新版本。复核后更换成果将退回处理阶段，必须重新复核。"
            >
              <div className="filelist">
                {!detail.files.length && (
                  <p className="muted">
                    尚未上传文件。先上传原始资料，再关联到资料清单。
                  </p>
                )}
                {detail.files.map((f: any) => (
                  <div>
                    <div>
                      <strong>{f.name}</strong>
                      <small>
                        {
                          (
                            {
                              source: "原始资料",
                              result: "处理成果",
                              evidence: "证据",
                            } as any
                          )[f.kind]
                        }{" "}
                        · {f.category} · v{f.version} ·{" "}
                        {Math.ceil(Number(f.size) / 1024)} KB
                      </small>
                    </div>
                    {write && (
                      <a href={"/api/v1/files/" + f.id + "/download"}>下载</a>
                    )}
                  </div>
                ))}
              </div>
            </Panel>
          </div>
          <div
            className="delivery-section order-handoff"
            hidden={detailTab !== "processing"}
          >
            <Panel title="外部处理与成果回传">
              <WorkBuddyHandoff
                key={detail.id}
                detail={detail}
                api={api}
                onRefresh={() => refreshOrder(detail.id)}
                write={write}
                workflows={workflows}
              />
            </Panel>
          </div>
          <div
            className="delivery-section order-history"
            hidden={detailTab !== "history"}
          >
            {reviewer && detail.status !== "archived" && (
              <Panel title="分工与截止日期">
                <form
                  className="formgrid"
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(async () => {
                      await api(`/orders/${detail.id}/assign`, {
                        version: detail.version,
                        ...b,
                      });
                      await refreshOrder(detail.id);
                    });
                  }}
                >
                  <Field label="经办">
                    <select name="assigneeId" defaultValue={detail.assignee_id}>
                      {detail.assignable.map((u: any) => (
                        <option value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="复核">
                    <select name="reviewerId" defaultValue={detail.reviewer_id}>
                      {detail.assignable
                        .filter(
                          (u: any) =>
                            ["owner", "reviewer"].includes(u.role) &&
                            !detail.contributors.includes(u.id) &&
                            u.id !== detail.assignee_id &&
                            u.id !== detail.submission?.submittedBy,
                        )
                        .map((u: any) => (
                          <option value={u.id}>{u.name}</option>
                        ))}
                    </select>
                  </Field>
                  <Field
                    label="截止日期"
                    name="dueDate"
                    type="date"
                    value={String(detail.due_date).slice(0, 10)}
                  />
                  <button disabled={busy}>更新分工</button>
                </form>
              </Panel>
            )}
            <Panel
              title="工作单动态"
              note="显示最近 50 条工作单操作，时间按上海时区显示"
            >
              <DeliveryActivity items={detail.activity} files={detail.files} />
            </Panel>
          </div>
          <div
            className="delivery-section order-reviews"
            hidden={!["history", "review"].includes(detailTab)}
          >
            <Panel title="历次复核记录">
              {detail.reviews.length ? (
                detail.reviews.map((r: any) => (
                  <article className="record">
                    <strong>
                      {r.action === "approve" ? "通过" : "退回"} · 第{" "}
                      {r.revision} 版
                    </strong>
                    <p>{r.reason}</p>
                    <small>
                      {r.actor_name} ·{" "}
                      {new Date(r.created_at).toLocaleString("zh-CN", {
                        timeZone: "Asia/Shanghai",
                      })}
                    </small>
                  </article>
                ))
              ) : (
                <p className="muted">尚无已完成的复核记录</p>
              )}
            </Panel>
          </div>
        </div>
      )}
      {page === "companies" && (
        <ClientWorkspace
          api={api}
          period={period}
          companyId={cid}
          owner={owner}
          reviewer={reviewer}
          users={users}
          onChanged={loadCompanies}
          onOpen={(id: string) => {
            pendingOpen.current = id;
            navigate("orders");
          }}
        />
      )}
      {page === "review" && (
        <div className="delivery-section" hidden={!!detail}>
          <ReviewCenter
            api={api}
            period={period}
            companyId={cid}
            refreshKey={detail?.version || 0}
            onOpen={(id: string) => void run(() => openOrder(id), "")}
          />
        </div>
      )}
      {page === "imports" && (
        <>
          <h1>资料导入与校验</h1>
          <p className="muted">
            结构化导入采用标准模板。PDF、图片请在月度工作单中作为原件上传。
          </p>
          <Panel title="标准模板">
            <div className="templategrid">
              {Object.entries({
                companies: "客户建档",
                materials: "资料清单",
                bank: "银行流水",
                ledger: "账务明细",
                delivery: "交付清单",
              }).map(([k, v]) => (
                <div>
                  <strong>{v}</strong>
                  <a href={"/api/v1/templates/" + k + "/xlsx"}>Excel</a>
                  <a href={"/api/v1/templates/" + k + "/csv"}>CSV</a>
                </div>
              ))}
            </div>
          </Panel>
          {write && (
            <Panel title="先预览，再确认">
              <form
                className="formgrid"
                onSubmit={(e) => {
                  const b = values(e);
                  void run(async () => {
                    const f = new FormData();
                    f.set("file", fileRef.current!.files![0]);
                    setPreview(
                      await api(
                        `/imports/preview?kind=${b.kind}&companyId=${cid}&period=${period}&mapping=${encodeURIComponent(String(b.mapping || "{}"))}`,
                        f,
                      ),
                    );
                  }, "预览完成，尚未写入业务");
                }}
              >
                <Field label="导入类型">
                  <select name="kind">
                    <option value="bank">银行流水</option>
                    <option value="ledger">账务明细</option>
                    <option value="materials">资料清单</option>
                    <option value="delivery">交付清单</option>
                    {owner && <option value="companies">客户建档</option>}
                  </select>
                </Field>
                <Field label="Excel / CSV 文件">
                  <input
                    type="file"
                    ref={fileRef}
                    required
                    accept=".csv,.xlsx"
                  />
                </Field>
                <Field label="自定义列名映射（选填）">
                  <input
                    name="mapping"
                    placeholder={'例如 {"amount":"金额"}'}
                  />
                </Field>
                <button disabled={busy}>检查并预览</button>
              </form>
              {preview?.rows && (
                <div>
                  <h3>
                    共 {preview.count} 行 · 金额合计 {preview.total}
                  </h3>
                  <p>
                    {preview.errors.length
                      ? "发现 " +
                        preview.errors.length +
                        " 项问题，请修正后重新导入"
                      : "格式校验通过，等待确认写入"}
                  </p>
                  <pre>
                    {JSON.stringify(
                      preview.errors.length
                        ? preview.errors.slice(0, 30)
                        : preview.rows.slice(0, 5),
                      null,
                      2,
                    )}
                  </pre>
                  <p>导入编号：{preview.id}</p>
                  <button
                    disabled={busy || preview.errors.length > 0}
                    onClick={() =>
                      void run(
                        () =>
                          enqueue("import_commit", { importId: preview.id }),
                        "已提交导入",
                      )
                    }
                  >
                    确认导入
                  </button>
                </div>
              )}
            </Panel>
          )}
          {write && (
            <Panel
              title="流水与账务唯一匹配"
              note="输入已确认导入的两份数据编号。重复候选保留人工复核，金额使用十进制精度。"
            >
              <form
                className="formgrid"
                onSubmit={(e) => {
                  const b = values(e);
                  void run(
                    async () =>
                      setPreview({
                        reconciliation: await api("/reconcile", b),
                      }),
                    "核对完成",
                  );
                }}
              >
                <Field label="银行流水导入编号" name="bankImportId" />
                <Field label="账务明细导入编号" name="ledgerImportId" />
                <button disabled={busy}>开始核对</button>
              </form>
              {preview?.reconciliation && (
                <pre>{JSON.stringify(preview.reconciliation, null, 2)}</pre>
              )}
            </Panel>
          )}
          {owner && (
            <Panel
              title="旧版备份迁移"
              note="必须先选择目标公司。旧记录只作为历史资料，不能成为新系统审批证据。"
            >
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = (
                    e.currentTarget as HTMLFormElement
                  ).elements.namedItem("backup") as HTMLInputElement;
                  void run(async () => {
                    if (!cid) throw new Error("请先选择目标公司");
                    const p = await api("/imports/legacy/preview", {
                      companyId: cid,
                      backup: JSON.parse(await input.files![0].text()),
                    });
                    setPreview({ legacy: p });
                  }, "迁移预览完成");
                }}
              >
                <Field label="旧版 JSON 备份">
                  <input name="backup" type="file" accept=".json" required />
                </Field>
                <button disabled={busy}>预览历史迁移</button>
              </form>
              {preview?.legacy && (
                <div>
                  <p>
                    {preview.legacy.source} · {preview.legacy.todos} 项待办
                  </p>
                  <button
                    onClick={() =>
                      void run(() =>
                        enqueue("import_commit", {
                          importId: preview.legacy.id,
                        }),
                      )
                    }
                  >
                    确认导入此公司
                  </button>
                </div>
              )}
            </Panel>
          )}
        </>
      )}
      {page === "workflows" && (
        <>
          <div className="hero">
            <p className="eyebrow">WORKBUDDY HANDOFF</p>
            <h1>25 个场景，进入同一条交付链。</h1>
            <p>
              先进入客户的月度工作单，选定资料后建立执行记录。系统保留输入版本，AI
              在 WorkBuddy 中完成处理。
            </p>
          </div>
          <div className="cards">
            {workflows.map((w) => (
              <article className="panel">
                <h2>{w.title}</h2>
                <button
                  className="ghost"
                  onClick={() =>
                    void run(async () => {
                      const next = favorites.includes(w.id)
                        ? favorites.filter((x) => x !== w.id)
                        : [...favorites, w.id];
                      if (!writeFinanceStore("favorites", next))
                        throw new Error("收藏未保存，请检查页面提示");
                      await flushStore();
                      setFavorites(next);
                    }, "")
                  }
                >
                  {favorites.includes(w.id) ? "取消收藏" : "收藏工作流"}
                </button>
                <p>任务包 · 成果回传 · 独立复核</p>
                <button
                  className="secondary"
                  onClick={() => navigate("orders")}
                >
                  进入月度工作单
                </button>
              </article>
            ))}
          </div>
        </>
      )}
      {page === "jobs" && (
        <>
          <h1>后台任务</h1>
          <p className="muted">
            任务保存在服务器，关闭浏览器不影响执行。每5秒刷新一次。
          </p>
          {rows.map((j) => (
            <article className="panel">
              <div className="row">
                <h2>
                  {
                    (
                      {
                        monthly_batch: "批量月度任务",
                        import_commit: "资料导入",
                        run_export: "WorkBuddy任务包",
                        delivery_export: "审核交付包",
                      } as any
                    )[j.kind]
                  }
                </h2>
                <Badge value={j.status} />
              </div>
              <small>{new Date(j.created_at).toLocaleString()}</small>
              {j.error && <p role="alert">{j.error}</p>}
              {j.status === "failed" && write && (
                <button
                  onClick={() =>
                    void run(async () => {
                      await api("/jobs/" + j.id + "/retry", {});
                      await refresh();
                    }, "已重新排队")
                  }
                >
                  重试
                </button>
              )}
              {j.result && (
                <p>
                  {j.kind === "monthly_batch"
                    ? `已创建 ${j.result.created || 0} / ${j.result.total || 0} 个月份，其余已存在`
                    : j.kind === "import_commit"
                      ? "资料导入已完成"
                      : j.result.fileId
                        ? "文件已生成，可下载保存"
                        : "处理已完成"}
                </p>
              )}
              {j.result?.fileId && (
                <a
                  className="button"
                  href={"/api/v1/jobs/" + j.id + "/download"}
                >
                  下载任务成果
                </a>
              )}
            </article>
          ))}
          {!rows.length && <div className="empty">暂无后台任务</div>}
        </>
      )}
      {page === "users" && owner && (
        <TeamManagement
          api={api}
          user={user}
          onChanged={async () => {
            setUsers(await api("/users"));
          }}
        />
      )}
      {page === "audit" && (
        <>
          <h1>操作记录</h1>
          <p className="muted">
            业务变更与审计共同保存，原始记录不可从界面修改。
          </p>
          {rows.map((r) => (
            <article className="record">
              <strong>{r.action}</strong>
              <small>
                {new Date(r.created_at).toLocaleString()} · 操作人 {r.actor_id}
              </small>
              <details>
                <summary>查看记录详情</summary>
                <pre>{JSON.stringify(r.details, null, 2)}</pre>
              </details>
            </article>
          ))}
        </>
      )}
      {page === "health" && health && (
        <>
          <h1>运行与备份</h1>
          <div className="cards">
            <Panel title="文件存储">
              <strong className="metric">
                {(health.storage.freeBytes / 1024 ** 3).toFixed(1)} GB
              </strong>
              <p>可用空间</p>
            </Panel>
            <Panel title="最近备份">
              <strong>
                {health.backup.status === "completed"
                  ? "备份成功"
                  : health.backup.status === "failed"
                    ? "备份失败"
                    : "暂无备份记录"}
              </strong>
              <p>
                {health.backup.at
                  ? new Date(health.backup.at).toLocaleString()
                  : "请检查备份服务"}
              </p>
              <small>数据库与附件共同备份，默认保留 30 个每日恢复点。</small>
            </Panel>
          </div>
          <Panel title="当前账号的失败任务">
            {health.failedJobs?.length ? (
              <>
                {health.failedJobs.map((j: any) => (
                  <div className="ops-history">
                    <strong>
                      {(
                        {
                          monthly_batch: "批量建月",
                          run_export: "WorkBuddy 任务包",
                          delivery_export: "审核交付包",
                          import_commit: "资料导入",
                        } as any
                      )[j.kind] || "后台任务"}
                    </strong>
                    <p>{j.error}</p>
                    <small>{new Date(j.updated_at).toLocaleString()}</small>
                  </div>
                ))}
                <button className="secondary" onClick={() => navigate("jobs")}>
                  前往任务中心重试
                </button>
              </>
            ) : (
              <p>暂无失败任务</p>
            )}
          </Panel>
          <Panel title="恢复与运维">
            <p>
              每日备份数据库与附件，保留30个每日恢复点。恢复在独立环境执行，核对文件和授权后再切换。
            </p>
            <p>
              同一台机器上的备份无法应对整机损坏，请按部署说明配置异机复制。
            </p>
            <a href="/api/v1/openapi.json">查看 API 文档</a>
          </Panel>
        </>
      )}
      {page === "account" && recent.length > 0 && (
        <Panel title="最近访问">
          {recent.map((id) => (
            <button
              className="secondary"
              onClick={() =>
                void run(async () => {
                  pendingOpen.current = id;
                  navigate("orders");
                }, "")
              }
            >
              查看工作单 {id.slice(0, 8)}
            </button>
          ))}
        </Panel>
      )}
      {page === "account" && (
        <Panel title="修改登录密码" note="修改后，所有设备的旧会话都将撤销。">
          <form
            onSubmit={(e) => {
              const b = values(e);
              void run(async () => {
                await api("/auth/password", b);
                csrf = "";
                setUser(null);
                generation.current++;
                setRows([]);
                setDetail(null);
              }, "密码已修改，请重新登录");
            }}
          >
            <Field label="原密码" name="current" type="password" />
            <Field label="新密码（至少12位）" name="password" type="password" />
            <button disabled={busy}>保存新密码</button>
          </form>
        </Panel>
      )}
      {["audit"].includes(page) && !detail && (
        <div className="pagination">
          <button
            className="secondary"
            disabled={!offset || busy}
            onClick={() => setOffset(Math.max(0, offset - 30))}
          >
            上一页
          </button>
          <span>第 {Math.floor(offset / 30) + 1} 页</span>
          <button
            className="secondary"
            disabled={rows.length < 30 || busy}
            onClick={() => setOffset(offset + 30)}
          >
            下一页
          </button>
        </div>
      )}
    </div>
  );
  if (deskReady !== deskKey)
    return (
      <AuthLayout>
        <h2>正在加载公司工作台</h2>
        <p role="status">{notice || "正在读取服务端资料与业务记录…"}</p>
        {deskLoadError && (
          <div className="agency-actions">
            <button onClick={() => setDeskLoadAttempt((n) => n + 1)}>
              重新加载
            </button>
            {cid && (
              <button
                className="secondary"
                onClick={() => {
                  generation.current++;
                  setCid("");
                  setSelectedCompany(null);
                  setDetail(null);
                }}
              >
                返回公司选择
              </button>
            )}
          </div>
        )}
      </AuthLayout>
    );
  return (
    <div className="team-host">
      <FinanceDashboard
        key={deskKey + "/" + deskEpoch}
        sessionId={user.id}
        files={workspaceFiles}
        workspace={{
          name: current?.name || "客户资料库",
          path: cid ? `${current?.name} / ${period}` : "选择公司后读取",
          mode: "server",
        }}
        status={
          notice ||
          "团队版 · 原版业务模块完整保留 · 数据按公司与期间保存在服务器"
        }
        onStatus={setNotice}
        onRefresh={() =>
          void run(async () => {
            try {
              await flushStore();
            } catch {
              if (
                !window.confirm(
                  "刷新会放弃当前未保存的草稿。请先导出草稿，确认继续刷新？",
                )
              )
                return;
              clearStore();
            }
            if (activeDeskKey.current !== deskKey) return;
            setViewRequest({ id: Date.now(), view: activeView.current });
            setDeskLoadAttempt((n) => n + 1);
          }, "")
        }
        onOpenWorkspace={() => navigate("orders")}
        onChooseFiles={() => uploadPicker.current?.click()}
        onChooseFolder={() => folderPicker.current?.click()}
        onUploadFiles={(files: File[]) =>
          void run(() => uploadToMonth(files), "资料已保存到本月工作单")
        }
        onReferenceFile={(file: any) => {
          setReferences((x) => [...new Set([...x, file.id])]);
          setNotice("已引用 " + file.name + "；发起任务时会固定此版本");
        }}
        onDownloadFile={(file: any) => {
          window.location.href = "/api/v1/files/" + file.id + "/download";
        }}
        onLaunchWorkflow={(workflow: any) =>
          void run(async () => {
            if (!cid) throw new Error("请先选择客户公司");
            const orders = await api(
              `/orders?companyId=${cid}&period=${period}`,
            );
            if (!orders.length)
              throw new Error("请先建立本月工作单并完成资料核对");
            const order = await api("/orders/" + orders[0].id);
            if (activeDeskKey.current !== deskKey) return;
            const ids = references;
            if (!ids.length)
              throw new Error(
                "请先到资料库引用本次输入文件版本，或在月度交付中逐项选择输入",
              );
            const r = await api(`/orders/${order.id}/runs`, {
              version: order.version,
              workflowId: workflow.id,
              taskBrief: workflow.taskBrief || {},
              fileIds: ids,
              key: crypto.randomUUID(),
            });
            if (activeDeskKey.current !== deskKey) return;
            await enqueue("run_export", { runId: r.id }, cid);
            if (activeDeskKey.current === deskKey)
              setViewRequest({ id: Date.now(), view: "team:jobs" });
          }, "执行记录已建立，任务包生成中")
        }
        launching={busy}
        onClose={() =>
          void run(async () => {
            await flushStore();
            await api("/auth/logout", {});
            clearStore();
            csrf = "";
            setUser(null);
            activeView.current = "home";
            setViewRequest(null);
            setPage("finance");
            companyRequest.current++;
            setCompanies([]);
            setSelectedCompany(null);
            setCompanySearch("");
            setCompanySearchDone(false);
            setCid("");
            setDetail(null);
            setRows([]);
            setDeskReady("");
          }, "")
        }
        team={{
          viewRequest,
          groups: [
            {
              label: "团队交付",
              items: teamPages
                .filter(([k]) => ["orders", "companies", "review"].includes(k))
                .map(([k, v]) => ["team:" + k, v, "·"]),
            },
            {
              label: "团队管理",
              items: teamPages
                .filter(
                  ([k]) =>
                    !["orders", "companies", "review", "audit"].includes(k),
                )
                .map(([k, v]) => ["team:" + k, v, "·"]),
            },
          ],
          metadata: Object.fromEntries(
            teamPages.map(([k, v]) => [
              "team:" + k,
              [v, "公司隔离 · 责任到人 · 版本留痕"],
            ]),
          ),
          redirect: {
            audit: "team:audit",
            backup: owner ? "team:health" : "team:account",
          },
          onViewChange: (v: string) => {
            activeView.current = v;
            const nextPage = v.startsWith("team:") ? v.slice(5) : "finance";
            // Restoring the same view after a company/period refresh must not
            // cancel an in-flight request to open that month's work order.
            if (nextPage === page) return;
            generation.current++;
            setPage(nextPage);
            setOffset(0);
            setDetail(null);
            setPreview(null);
          },
          renderView: teamContent,
          contextBar: (
            <header className="team-context">
              <div>
                <span className="eyebrow">ZY / 团队协作</span>
                <strong>{current?.name || "授权公司工作区"}</strong>
              </div>
              <div className="topfilters">
                <label>
                  查找客户
                  <input
                    aria-label="查找客户"
                    placeholder="名称或编号，回车搜索"
                    maxLength={100}
                    value={companySearch}
                    onInput={(e) => setCompanySearch(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        void run(
                          () => loadCompanies(e.currentTarget.value),
                          "",
                        );
                    }}
                  />
                  {companySearchDone && companySearch.trim() && (
                    <small role="status">
                      找到 {companies.length} 家
                      {companies.length === 100 ? "（最多显示100家）" : ""}
                      ；当前公司保持不变
                    </small>
                  )}
                </label>
                <label>
                  当前公司
                  <select
                    aria-label="当前公司"
                    value={cid}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      void run(async () => {
                        await flushStore();
                        generation.current++;
                        setViewRequest({
                          id: Date.now(),
                          view: activeView.current,
                        });
                        setCid(next);
                        setSelectedCompany(
                          companies.find((c) => c.id === next) ||
                            (current?.id === next ? current : null),
                        );
                        setDetail(null);
                        setPreview(null);
                        setOffset(0);
                      }, "");
                    }}
                  >
                    <option value="">全部授权公司</option>
                    {current && !companies.some((c) => c.id === current.id) && (
                      <option value={current.id}>
                        {current.name}（当前公司）
                      </option>
                    )}
                    {companies.map((c) => (
                      <option value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  会计期间
                  <input
                    aria-label="会计期间"
                    type="month"
                    value={period}
                    onChange={(e) => {
                      const next = e.currentTarget.value;
                      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(next)) return;
                      void run(async () => {
                        await flushStore();
                        setViewRequest({
                          id: Date.now(),
                          view: activeView.current,
                        });
                        setPeriod(next);
                      }, "");
                    }}
                  />
                </label>
              </div>
            </header>
          ),
          exportWorkspace: () => {
            if (!cid || !write) {
              setNotice("当前账号不能导出，或尚未选择公司");
              return;
            }
            const blob = new Blob(
              [
                JSON.stringify(
                  {
                    product: "dsh-finance-workbench",
                    version: 2,
                    teamDraft: true,
                    ...getDraft(),
                  },
                  null,
                  2,
                ),
              ],
              { type: "application/json" },
            );
            const url = URL.createObjectURL(blob),
              a = document.createElement("a");
            a.href = url;
            a.download = "团队工作台草稿.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          },
        }}
      />
      <input
        hidden
        ref={uploadPicker}
        type="file"
        multiple
        onChange={(e) => {
          const files = [...(e.currentTarget.files || [])];
          e.currentTarget.value = "";
          void run(() => uploadToMonth(files), "文件已上传");
        }}
      />
      <input
        hidden
        ref={folderPicker}
        type="file"
        multiple
        {...({ webkitdirectory: "" } as any)}
        onChange={(e) => {
          const files = [...(e.currentTarget.files || [])];
          e.currentTarget.value = "";
          void run(() => uploadToMonth(files), "文件夹资料已上传");
        }}
      />
    </div>
  );
}
render(<App />, document.getElementById("root")!);
