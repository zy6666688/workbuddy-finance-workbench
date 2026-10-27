import { render } from "preact";
import { useState, useEffect, useRef } from "preact/hooks";
import "./style.css";
import { AuthLayout, AuthPassword } from "./auth.js";
import { FinanceDashboard } from "../../src/finance-dashboard.jsx";
import {
  writeFinanceStore,
  configureStore,
  flushStore,
  clearStore,
  getDraft,
  storageIssueSnapshot,
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
  if (!r.ok) throw new Error(data.error || "请求失败");
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
  const pendingOpen = useRef("");
  const generation = useRef(0),
    fileRef = useRef<HTMLInputElement>(null),
    [members, setMembers] = useState<any[]>([]);
  const owner = user?.role === "owner",
    reviewer = owner || user?.role === "reviewer",
    write = user?.role !== "viewer";
  const current = companies.find((c) => c.id === cid);
  const run = async (fn: () => Promise<any>, message = "已保存") => {
    setBusy(true);
    setNotice("");
    try {
      await fn();
      if (message) setNotice(message);
    } catch (e: any) {
      setNotice(e.message);
    } finally {
      setBusy(false);
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
    const c = await api("/companies?limit=100&search=" + encodeURIComponent(q));
    setCompanies(c);
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
    if (["orders", "review"].includes(page))
      data = await api(
        `/orders?companyId=${cid}&period=${period}&status=${page === "review" ? "review" : filter === "overdue" ? "" : filter}&overdue=${filter === "overdue"}&offset=${offset}`,
      );
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
  }, [page, cid, period, offset, filter, user?.must_change_password]);
  useEffect(() => {
    if (page !== "jobs" || !user) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [page, user?.id]);
  async function openOrder(id: string) {
    const gen = ++generation.current;
    const d = await api("/orders/" + id);
    if (gen === generation.current) {
      setDetail(d);
      const next = [id, ...recent.filter((x) => x !== id)].slice(0, 10);
      setRecent(next);
      writeFinanceStore("recentOrders", next);
    }
  }
  async function orderAction(action: string, extra: any = {}) {
    await api(`/orders/${detail.id}/action`, {
      version: detail.version,
      action,
      ...extra,
    });
    await openOrder(detail.id);
  }
  async function enqueue(kind: string, payload: any, companyId = cid) {
    await api("/jobs", {
      kind,
      payload,
      companyId: companyId || undefined,
      key: crypto.randomUUID(),
    });
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
  useEffect(() => {
    let cancelled = false;
    setDeskReady("");
    setWorkspaceFiles([]);
    setReferences([]);
    if (!deskKey) return;
    void (async () => {
      try {
        await flushStore();
        const [saved, prefs] = await Promise.all([
          cid
            ? api(`/companies/${cid}/workspace/${period}`)
            : Promise.resolve({ version: 0, state: {} }),
          api("/preferences"),
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
        if (cid)
          setWorkspaceFiles(
            await api(`/companies/${cid}/files?period=${period}`),
          );
        setDeskEpoch((x) => x + 1);
        setDeskReady(deskKey);
      } catch (e: any) {
        if (!cancelled) setNotice(e.message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deskKey]);
  async function uploadToMonth(selected: File[]) {
    if (!cid) throw new Error("请先选择客户公司");
    const orders = await api(`/orders?companyId=${cid}&period=${period}`);
    if (!orders.length) throw new Error("请先到月度交付创建本月工作单");
    let order = await api("/orders/" + orders[0].id);
    for (const f of selected) {
      const body = new FormData();
      body.set("file", f);
      await api(
        `/orders/${order.id}/files?kind=source&version=${order.version}`,
        body,
      );
      order = await api("/orders/" + order.id);
    }
    setWorkspaceFiles(await api(`/companies/${cid}/files?period=${period}`));
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
      {["orders", "review"].includes(page) && !detail && (
        <>
          <div className="hero">
            <p className="eyebrow">MONTHLY DELIVERY</p>
            <h1>
              {page === "review"
                ? "待复核的成果，逐项确认。"
                : "把本月工作，推进到交付。"}
            </h1>
            <p>按公司、期间与责任人组织资料，关键节点由另一位同事复核。</p>
          </div>
          <div className="toolbar">
            <label>
              处理阶段
              <select
                disabled={page === "review"}
                value={filter}
                onChange={(e) => {
                  setFilter(e.currentTarget.value);
                  setOffset(0);
                }}
              >
                <option value="">全部阶段</option>
                {steps.map((s) => (
                  <option value={s}>{statusNames[s]}</option>
                ))}
                <option value="overdue">仅看逾期</option>
              </select>
            </label>
            <button
              className="secondary"
              onClick={() => void run(refresh, "已刷新")}
            >
              刷新列表
            </button>
          </div>
          <div className="cards">
            {rows.map((o) => (
              <button
                className="ordercard"
                onClick={() => void run(() => openOrder(o.id), "")}
              >
                <div>
                  <Badge value={o.status} />
                  <small>{o.period}</small>
                </div>
                <h2>{o.company_name}</h2>
                <p>截止 {String(o.due_date).slice(0, 10)}</p>
                <span>查看资料与处理进度 →</span>
              </button>
            ))}
          </div>
          {!rows.length && (
            <div className="empty">
              本期暂无工作单。选择客户公司后创建，或批量安排本月任务。
            </div>
          )}
          {reviewer && (
            <Panel
              title="安排月度工作"
              note="每家公司每月一份；重复创建不会新增。批量任务使用当前公司列表中显示的客户。"
            >
              <form
                className="formgrid"
                onSubmit={(e) => {
                  const b = values(e);
                  void run(async () => {
                    const payload = {
                      period,
                      dueDate: b.dueDate,
                      assigneeId: b.assigneeId,
                      reviewerId: b.reviewerId,
                    };
                    if (b.mode === "batch")
                      await enqueue(
                        "monthly_batch",
                        {
                          ...payload,
                          companyIds: cid ? [cid] : companies.map((c) => c.id),
                        },
                        "",
                      );
                    else {
                      if (!cid) throw new Error("请选择一家公司");
                      await api("/orders", { companyId: cid, ...payload });
                      await refresh();
                    }
                  }, "工作已安排");
                }}
              >
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
                  <select name="mode">
                    <option value="single">当前公司</option>
                    <option value="batch">当前列表批量生成</option>
                  </select>
                </Field>
                <button disabled={busy}>创建月度工作</button>
              </form>
            </Panel>
          )}
        </>
      )}
      {["orders", "review"].includes(page) && detail && (
        <>
          <button
            className="ghost"
            onClick={() => {
              setDetail(null);
              void run(refresh, "");
            }}
          >
            ← 返回月度列表
          </button>
          <div className="detailhead">
            <div>
              <p className="eyebrow">
                {detail.period} / 第 {detail.revision} 次交付版本
              </p>
              <h1>
                {companies.find((c) => c.id === detail.company_id)?.name ||
                  "月度工作单"}
              </h1>
            </div>
            <Badge value={detail.status} />
          </div>
          <ol className="steps">
            {steps.map((s, i) => (
              <li className={i <= steps.indexOf(detail.status) ? "done" : ""}>
                <span>{i + 1}</span>
                {statusNames[s]}
              </li>
            ))}
          </ol>
          <div className="columns">
            <Panel
              title="资料清单"
              note="原件必须与本公司、本期间关联。缺件豁免需要独立复核人员说明理由。"
            >
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
                          await openOrder(detail.id);
                        });
                      }}
                    >
                      <select
                        name="fileId"
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
                    reviewer &&
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
                            await openOrder(detail.id);
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
            <Panel
              title="推进工作"
              note="状态由服务端检查。经办不能复核自己的交付。"
            >
              {["collecting", "checking"].includes(detail.status) && write && (
                <button
                  disabled={busy}
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
                  <button disabled={busy}>提交独立复核</button>
                </form>
              )}
              {detail.status === "review" && reviewer && (
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
                        detail.reopen_request && reviewer
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
                  <Field label="原因">
                    <textarea name="reason" required />
                  </Field>
                  <button disabled={busy}>
                    {detail.reopen_request && reviewer
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
          <Panel
            title="原始资料与成果版本"
            note="上传同名文件会形成新版本。复核后更换成果将退回处理阶段，必须重新复核。"
          >
            <div className="filelist">
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
            {write && detail.status !== "archived" && (
              <form
                className="formgrid"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const b = new FormData(form);
                  const file = b.get("file") as File;
                  void run(async () => {
                    const upload = new FormData();
                    upload.set("file", file);
                    await api(
                      `/orders/${detail.id}/files?kind=${b.get("kind")}&category=${encodeURIComponent(String(b.get("category")))}&version=${detail.version}`,
                      upload,
                    );
                    form.reset();
                    await openOrder(detail.id);
                  }, "文件已保存");
                }}
              >
                <Field label="文件用途">
                  <select name="kind">
                    <option value="source">原始资料</option>
                    <option value="result">处理成果</option>
                    <option value="evidence">交付证据</option>
                  </select>
                </Field>
                <Field label="资料类别" name="category" value="其他" />
                <Field label="选择文件（单个50MB以内）">
                  <input
                    name="file"
                    type="file"
                    required
                    accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.txt,.docx"
                  />
                </Field>
                <button disabled={busy}>上传并保存版本</button>
              </form>
            )}
          </Panel>
          <Panel
            title="WorkBuddy 任务交接"
            note="下载任务包 → 在 WorkBuddy 处理 → 上传成果 → 回传任务。复制提示词不代表任务完成。"
          >
            {detail.status === "processing" && write && (
              <form
                className="formgrid"
                onSubmit={(e) => {
                  const b = values(e),
                    inputIds = new FormData(
                      e.currentTarget as HTMLFormElement,
                    ).getAll("inputFile");
                  void run(async () => {
                    await api(`/orders/${detail.id}/runs`, {
                      version: detail.version,
                      workflowId: b.workflowId,
                      fileIds: inputIds,
                    });
                    await openOrder(detail.id);
                  });
                }}
              >
                <Field label="选择工作流">
                  <select name="workflowId">
                    {workflows.map((w) => (
                      <option value={w.id}>{w.title}</option>
                    ))}
                  </select>
                </Field>
                <fieldset>
                  <legend>选择本次输入版本</legend>
                  {detail.files
                    .filter((f: any) => f.kind === "source")
                    .map((f: any) => (
                      <label className="check">
                        <input type="checkbox" name="inputFile" value={f.id} />
                        {f.name} · v{f.version}
                      </label>
                    ))}
                </fieldset>
                <button
                  disabled={
                    busy || !detail.files.some((f: any) => f.kind === "source")
                  }
                >
                  建立执行记录
                </button>
              </form>
            )}
            {detail.runs.map((r: any) => (
              <div className="run">
                <div>
                  <strong>
                    {workflows.find((w) => w.id === r.workflow_id)?.title}
                  </strong>{" "}
                  <Badge value={r.status} />
                </div>
                <small>任务编号 {r.id}</small>
                {r.status === "external" && write && (
                  <>
                    <button
                      className="secondary"
                      onClick={() =>
                        void run(
                          () =>
                            enqueue(
                              "run_export",
                              { runId: r.id },
                              detail.company_id,
                            ),
                          "任务包生成中",
                        )
                      }
                    >
                      生成 WorkBuddy 任务包
                    </button>
                    <form
                      onSubmit={(e) => {
                        const b = values(e);
                        void run(async () => {
                          const manifest = JSON.parse(String(b.manifest));
                          if (manifest.runId !== r.id)
                            throw new Error("回传清单不属于此任务");
                          await api("/runs/" + r.id + "/return", {
                            version: r.version,
                            inputHashes: manifest.inputHashes,
                            resultFileIds: detail.files
                              .filter((f: any) => f.kind === "result")
                              .map((f: any) => f.id),
                            summary: b.summary,
                          });
                          await openOrder(detail.id);
                        });
                      }}
                    >
                      <Field label="任务包中的 return-manifest.json">
                        <textarea
                          name="manifest"
                          required
                          placeholder="粘贴任务包里的回传清单"
                        />
                      </Field>
                      <Field label="成果与校验说明">
                        <textarea name="summary" required />
                      </Field>
                      <button disabled={busy}>关联已上传成果并回传</button>
                    </form>
                  </>
                )}
              </div>
            ))}
          </Panel>
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
                    await openOrder(detail.id);
                  });
                }}
              >
                <Field label="经办">
                  <select name="assigneeId" defaultValue={detail.assignee_id}>
                    {users
                      .filter((u) => u.active && u.role !== "viewer")
                      .map((u) => (
                        <option value={u.id}>{u.name}</option>
                      ))}
                  </select>
                </Field>
                <Field label="复核">
                  <select name="reviewerId" defaultValue={detail.reviewer_id}>
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
          <Panel title="历次复核记录">
            {detail.reviews.length ? (
              detail.reviews.map((r: any) => (
                <article className="record">
                  <strong>
                    {r.action === "approve" ? "通过" : "退回"} · 第 {r.revision}{" "}
                    版
                  </strong>
                  <p>{r.reason}</p>
                  <small>{new Date(r.created_at).toLocaleString()}</small>
                </article>
              ))
            ) : (
              <p className="muted">尚未提交复核</p>
            )}
          </Panel>
        </>
      )}
      {page === "companies" && (
        <>
          <h1>客户公司</h1>
          <form
            className="toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              setOffset(0);
              void run(refresh, "");
            }}
          >
            <input
              aria-label="搜索客户公司"
              placeholder="公司名称或编号"
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <button>搜索</button>
          </form>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>公司名称</th>
                  <th>编号</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr>
                    <td>{c.name}</td>
                    <td>{c.code}</td>
                    <td>
                      <button
                        className="ghost"
                        onClick={() => {
                          setCid(c.id);
                          if (!companies.some((x) => x.id === c.id))
                            setCompanies([...companies, c]);
                          navigate("orders");
                        }}
                      >
                        进入工作区
                      </button>
                      {owner && (
                        <button
                          className="ghost"
                          onClick={() =>
                            void run(async () => {
                              setCid(c.id);
                              if (!companies.some((x) => x.id === c.id))
                                setCompanies([...companies, c]);
                              setMembers(
                                await api("/companies/" + c.id + "/members"),
                              );
                            }, "")
                          }
                        >
                          管理授权
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {owner && (
            <Panel title="新增客户公司">
              <form
                className="formgrid"
                onSubmit={(e) => {
                  const b = values(e);
                  void run(async () => {
                    await api("/companies", b);
                    await refresh();
                    await loadCompanies();
                  });
                }}
              >
                <Field label="公司名称" name="name" />
                <Field label="内部公司编号" name="code" />
                <button disabled={busy}>创建公司</button>
              </form>
            </Panel>
          )}
          {owner && cid && (
            <Panel
              title={"公司授权 · " + (current?.name || "当前公司")}
              note="撤销授权后，即使员工尚未退出登录，也不能继续访问该公司。"
            >
              <p>
                {members.map((m) => m.name).join("、") ||
                  "点击公司列表的“管理授权”查看现有成员"}
              </p>
              <form
                className="formgrid"
                onSubmit={(e) => {
                  const b = values(e);
                  void run(async () => {
                    await api("/companies/" + cid + "/members", {
                      userId: b.userId,
                      enabled: b.enabled === "true",
                    });
                    setMembers(await api("/companies/" + cid + "/members"));
                  });
                }}
              >
                <Field label="员工">
                  <select name="userId">
                    {users.map((u) => (
                      <option value={u.id}>
                        {u.name} · {roleNames[u.role]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="操作">
                  <select name="enabled">
                    <option value="true">授予访问</option>
                    <option value="false">撤销访问</option>
                  </select>
                </Field>
                <button disabled={busy}>保存授权</button>
              </form>
            </Panel>
          )}
          {reviewer && current && (
            <Panel
              title="后续月份资料模板"
              note="一行一项必需资料；不会修改已经创建的工作单。"
            >
              <form
                key={cid}
                onSubmit={(e) => {
                  const b = values(e);
                  void run(async () => {
                    await api("/companies/" + cid + "/template", {
                      version: current.version,
                      checklist: String(b.items)
                        .split("\n")
                        .filter(Boolean)
                        .map((name) => ({ name: name.trim(), required: true })),
                    });
                    await loadCompanies();
                  });
                }}
              >
                <Field label="必需资料">
                  <textarea
                    name="items"
                    required
                    defaultValue={current.template
                      .map((i: any) => i.name)
                      .join("\n")}
                  />
                </Field>
                <button disabled={busy}>保存模板</button>
              </form>
            </Panel>
          )}
        </>
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
                      await api("/preferences", {
                        theme,
                        favorites: next,
                        recent,
                      });
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
              {j.result && <pre>{JSON.stringify(j.result, null, 2)}</pre>}
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
      {page === "users" && (
        <>
          <h1>团队成员</h1>
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th>姓名</th>
                  <th>账号</th>
                  <th>角色</th>
                  <th>状态</th>
                  <th>管理</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr>
                    <td>{u.name}</td>
                    <td>{u.username}</td>
                    <td>{roleNames[u.role]}</td>
                    <td>{u.active ? "启用" : "停用"}</td>
                    <td>
                      {owner && u.id !== user.id && (
                        <button
                          className="ghost"
                          onClick={() =>
                            void run(async () => {
                              await api("/users/" + u.id, {
                                version: u.version,
                                active: !u.active,
                                role: u.role,
                              });
                              await refresh();
                            })
                          }
                        >
                          {u.active ? "停用账号" : "启用账号"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {owner && (
            <>
              <Panel title="创建员工账号">
                <form
                  className="formgrid"
                  onSubmit={(e) => {
                    const b = values(e);
                    const form = e.currentTarget;
                    void run(async () => {
                      await api("/users", b);
                      form.reset();
                      await refresh();
                      setUsers(await api("/users"));
                    });
                  }}
                >
                  <Field label="姓名" name="name" />
                  <Field label="登录账号" name="username" />
                  <Field
                    label="初始密码（至少12位）"
                    name="password"
                    type="password"
                  />
                  <Field label="角色">
                    <select name="role">
                      {Object.entries(roleNames).map(([k, v]) => (
                        <option value={k}>{v}</option>
                      ))}
                    </select>
                  </Field>
                  <button disabled={busy}>创建账号</button>
                </form>
              </Panel>
              <Panel title="角色与密码管理">
                <form
                  className="formgrid"
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(async () => {
                      const u = rows.find((x) => x.id === b.userId);
                      await api("/users/" + u.id, {
                        version: u.version,
                        active: u.active,
                        role: b.role,
                      });
                      await refresh();
                    });
                  }}
                >
                  <Field label="员工">
                    <select name="userId">
                      {rows
                        .filter((u) => u.id !== user.id)
                        .map((u) => (
                          <option value={u.id}>{u.name}</option>
                        ))}
                    </select>
                  </Field>
                  <Field label="新角色">
                    <select name="role">
                      {Object.entries(roleNames).map(([k, v]) => (
                        <option value={k}>{v}</option>
                      ))}
                    </select>
                  </Field>
                  <button disabled={busy}>变更角色</button>
                </form>
                <form
                  className="formgrid"
                  onSubmit={(e) => {
                    const b = values(e);
                    void run(() =>
                      api("/users/" + b.userId + "/reset-password", {
                        password: b.password,
                      }),
                    );
                  }}
                >
                  <Field label="员工">
                    <select name="userId">
                      {rows.map((u) => (
                        <option value={u.id}>{u.name}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="新初始密码" name="password" type="password" />
                  <button className="secondary" disabled={busy}>
                    重置并撤销旧会话
                  </button>
                </form>
              </Panel>
            </>
          )}
        </>
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
              <pre>{JSON.stringify(health.backup, null, 2)}</pre>
            </Panel>
          </div>
          <Panel title="失败任务">
            {health.failedJobs?.length ? (
              <pre>{JSON.stringify(health.failedJobs, null, 2)}</pre>
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
      {["orders", "review", "companies", "audit"].includes(page) && !detail && (
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
            if (
              storageIssueSnapshot().startsWith("保存") &&
              !window.confirm(
                "刷新会放弃当前未保存的草稿。请先导出草稿，确认继续刷新？",
              )
            )
              return;
            setDeskReady("");
            const saved = cid
              ? await api(`/companies/${cid}/workspace/${period}`)
              : { version: 0, state: {} };
            const prefs = await api("/preferences");
            configureStore({
              key: deskKey,
              companyId: cid,
              period,
              saved,
              prefs,
              profile: {
                name: user.name,
                entity: current?.name || "请选择公司",
                role: roleNames[user.role],
                period,
              },
              readOnly: !write || !cid,
              request: api,
              onNotice: setNotice,
            });
            if (cid)
              setWorkspaceFiles(
                await api(`/companies/${cid}/files?period=${period}`),
              );
            setDeskEpoch((x) => x + 1);
            setDeskReady(deskKey);
          }, "已从服务器刷新")
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
            });
            await enqueue("run_export", { runId: r.id }, cid);
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
            generation.current++;
            setPage(v.startsWith("team:") ? v.slice(5) : "finance");
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
                    placeholder="输入名称后按回车"
                    onKeyDown={(e) => {
                      if (e.key === "Enter")
                        void run(
                          () => loadCompanies(e.currentTarget.value),
                          "",
                        );
                    }}
                  />
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
                        setCid(next);
                        setDetail(null);
                        setPreview(null);
                        setOffset(0);
                      }, "");
                    }}
                  >
                    <option value="">全部授权公司</option>
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
                      void run(async () => {
                        await flushStore();
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
