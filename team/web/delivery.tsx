import { useState } from "preact/hooks";
export const deliveryStages = [
  "collecting",
  "checking",
  "processing",
  "review",
  "delivery",
  "archived",
];
export const deliveryNames: Record<string, string> = {
  collecting: "待收集",
  checking: "整理核对",
  processing: "经办处理",
  review: "待复核",
  delivery: "待交付",
  archived: "已归档",
};
export type DeliveryQuery = {
  scope: string;
  attention: string;
  search: string;
  sort: string;
};
export const defaultDeliveryQuery: DeliveryQuery = {
  scope: "all",
  attention: "",
  search: "",
  sort: "deadline",
};
const nextSteps: Record<string, string> = {
  collecting: "收集并关联资料",
  checking: "核对资料完整性",
  processing: "处理任务与上传成果",
  review: "核对成果，给出意见",
  delivery: "登记交付与证据",
  archived: "查看归档与交付记录",
};
const emptyStats = {
  total: 0,
  overdue: 0,
  due_soon: 0,
  missing: 0,
  review: 0,
  delivery: 0,
  archived: 0,
  filtered_total: 0,
  stages: {} as Record<string, number>,
};
function Status({ value }: { value: string }) {
  return (
    <span className={"delivery-status is-" + value}>
      <i />
      {deliveryNames[value]}
    </span>
  );
}
function MaterialCount({ order: o }: { order: any }) {
  return (
    <div className="delivery-materialCount">
      <span>
        {o.received_count} / {o.required_count} 项齐备
      </span>
      <small className={o.missing_count ? "is-warning" : ""}>
        {o.missing_count
          ? `缺 ${o.missing_count} 项必需资料`
          : "必需资料已齐备 / 豁免"}
      </small>
    </div>
  );
}
export function DeliveryOverview({
  rows,
  stats,
  period,
  company,
  reviewOnly,
  query,
  filter,
  offset,
  busy,
  canCreate,
  onQuery,
  onFilter,
  onOffset,
  onOpen,
  onRefresh,
  onCreate,
  onNavigate,
}: any) {
  const s = stats || emptyStats;
  const [view, setView] = useState("list"),
    [search, setSearch] = useState(query.search);
  const change = (patch: Partial<DeliveryQuery>) =>
    onQuery({ ...query, ...patch });
  const selectMetric = (key: string) => {
    onFilter(
      key === "review" || key === "delivery" || key === "archived" ? key : "",
    );
    change({
      attention: ["missing", "overdue", "dueSoon"].includes(key) ? key : "",
    });
  };
  return (
    <div className="delivery-workspace">
      <header className="delivery-heading">
        <div>
          <span className="delivery-eyebrow">
            {period} · {company || "全部授权客户"}
          </span>
          <h1>{reviewOnly ? "审核中心" : "月度交付工作台"}</h1>
          <p>
            {reviewOnly
              ? "按截止日期安排复核，确认每一版成果。"
              : "先处理逾期与缺件，再推进本月客户交付。"}
          </p>
        </div>
        <div className="delivery-actions">
          <button className="secondary" disabled={busy} onClick={onRefresh}>
            刷新
          </button>
          {canCreate && !reviewOnly && (
            <button disabled={busy} onClick={onCreate}>
              ＋ 安排月度工作
            </button>
          )}
        </div>
      </header>
      <div className="delivery-metrics" aria-label="当前授权范围工作统计">
        {[
          ["", "本期工作单", s.total, "客户月份"],
          ["missing", "待补件", s.missing, "需跟进资料"],
          ["overdue", "已逾期", s.overdue, "优先处理"],
          ["review", "待复核", s.review, "等待独立复核"],
          ["delivery", "待交付", s.delivery, "待登记交付"],
          ["archived", "已归档", s.archived, "本期已完成"],
        ].map(([key, label, n, note]) => (
          <button
            key={String(key)}
            disabled={busy || reviewOnly}
            onClick={() => selectMetric(String(key))}
            className={
              "delivery-metric " +
              (key === "overdue"
                ? "is-danger"
                : key === "archived"
                  ? "is-success"
                  : "")
            }
          >
            <span>{label}</span>
            <strong>{stats ? n : "—"}</strong>
            <small>{note}</small>
          </button>
        ))}
      </div>
      <div className="delivery-surface">
        <div className="delivery-toolbar">
          <div className="delivery-segments" aria-label="工作范围">
            {[
              ["all", "全部工作"],
              ["handling", "我经办"],
              ["reviewing", "我复核"],
            ].map(([key, label]) => (
              <button
                disabled={busy}
                aria-pressed={query.scope === key}
                className={query.scope === key ? "is-active" : ""}
                onClick={() => change({ scope: key })}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="delivery-viewSwitch" aria-label="展示方式">
            {[
              ["list", "列表"],
              ["board", "阶段看板"],
            ].map(([key, label]) => (
              <button
                aria-pressed={view === key}
                className={view === key ? "is-active" : ""}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {!reviewOnly && (
          <nav className="delivery-stageFilters" aria-label="阶段筛选">
            {[
              ["", "全部"],
              ...deliveryStages.map((k) => [k, deliveryNames[k]]),
            ].map(([key, label]) => (
              <button
                disabled={busy}
                aria-pressed={filter === key}
                onClick={() => onFilter(key)}
              >
                {label}
                <span>{key ? s.stages[key] || 0 : s.total}</span>
              </button>
            ))}
          </nav>
        )}
        <div className="delivery-filters">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              change({ search });
            }}
          >
            <input
              aria-label="搜索工作单客户"
              placeholder="搜索客户名称或编号"
              value={search}
              onInput={(e) => setSearch(e.currentTarget.value)}
              maxLength={100}
            />
            <button className="secondary" disabled={busy}>
              搜索
            </button>
          </form>
          <select
            aria-label="关注事项"
            value={query.attention}
            onChange={(e) => change({ attention: e.currentTarget.value })}
          >
            <option value="">全部关注事项</option>
            <option value="missing">缺少必需资料</option>
            <option value="overdue">已逾期</option>
            <option value="dueSoon">未来 7 天到期</option>
          </select>
          <select
            aria-label="工作单排序"
            value={query.sort}
            onChange={(e) => change({ sort: e.currentTarget.value })}
          >
            <option value="deadline">截止日期优先</option>
            <option value="updated">最近更新优先</option>
            <option value="company">客户名称排序</option>
          </select>
          {(query.search ||
            query.attention ||
            query.scope !== "all" ||
            filter) && (
            <button
              className="ghost"
              onClick={() => {
                setSearch("");
                onQuery(defaultDeliveryQuery);
                onFilter("");
              }}
            >
              清除筛选
            </button>
          )}
        </div>
        <div className="delivery-resultInfo">
          <span>
            {reviewOnly ? "复核队列" : "工作清单"} ·{" "}
            {stats ? s.filtered_total : "…"} 单
          </span>
          <small>统计按当前期间、客户、搜索与工作范围计算</small>
        </div>
        {!rows.length ? (
          <div className="delivery-empty">
            <span className="delivery-emptyMark">{s.total ? "⌕" : "01"}</span>
            <h2>
              {busy
                ? "正在读取工作单…"
                : s.total
                  ? "没有符合筛选的工作单"
                  : "从安排第一个客户月份开始"}
            </h2>
            <p>
              {s.total
                ? "试着清除阶段、关注事项或客户搜索。"
                : "先建客户、分配经办和复核，再建立月度任务。"}
            </p>
            {!s.total && canCreate && !reviewOnly && (
              <div className="delivery-onboarding">
                <button
                  className="secondary"
                  onClick={() => onNavigate("companies")}
                >
                  1. 建立客户与授权
                </button>
                <button className="secondary" onClick={onCreate}>
                  2. 安排月度工作
                </button>
              </div>
            )}
          </div>
        ) : view === "list" ? (
          <div className="delivery-tablewrap">
            <table className="delivery-table">
              <thead>
                <tr>
                  {[
                    "客户 / 期间",
                    "交付阶段",
                    "资料进度",
                    "责任分工",
                    "截止日期",
                    "下一步",
                  ].map((h) => (
                    <th>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((o: any) => (
                  <tr key={o.id}>
                    <td>
                      <button
                        className="delivery-companyButton"
                        onClick={() => onOpen(o.id)}
                      >
                        {o.company_name}
                      </button>
                      <small>
                        {o.company_code} · {o.period}
                      </small>
                    </td>
                    <td>
                      <Status value={o.status} />
                    </td>
                    <td>
                      <MaterialCount order={o} />
                    </td>
                    <td>
                      <span>{o.assignee_name || "未分配经办"}</span>
                      <small>复核 · {o.reviewer_name || "未分配"}</small>
                    </td>
                    <td>
                      <span className={o.overdue ? "delivery-overdue" : ""}>
                        {String(o.due_date).slice(0, 10)}
                      </span>
                      <small>
                        {o.status === "archived"
                          ? "已完成"
                          : o.overdue
                            ? "已逾期"
                            : o.due_soon
                              ? "7 天内到期"
                              : "按计划推进"}
                      </small>
                    </td>
                    <td>
                      <button
                        className="delivery-open"
                        onClick={() => onOpen(o.id)}
                      >
                        {nextSteps[o.status]} <span aria-hidden="true">→</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="delivery-board" aria-label="本页工作单阶段看板">
            {(reviewOnly ? ["review"] : deliveryStages).map((stage) => (
              <section className={"delivery-lane is-" + stage}>
                <header>
                  <Status value={stage} />
                  <span>
                    {rows.filter((o: any) => o.status === stage).length}
                  </span>
                </header>
                {rows
                  .filter((o: any) => o.status === stage)
                  .map((o: any) => (
                    <button
                      className="delivery-boardCard"
                      onClick={() => onOpen(o.id)}
                    >
                      <strong>{o.company_name}</strong>
                      <small>
                        {o.period} · {o.assignee_name || "未分配"}
                      </small>
                      <MaterialCount order={o} />
                      <footer className={o.overdue ? "delivery-overdue" : ""}>
                        {o.due_date} 截止{o.overdue ? " · 已逾期" : ""}
                      </footer>
                    </button>
                  ))}
                {!rows.some((o: any) => o.status === stage) && <p>本页暂无</p>}
              </section>
            ))}
          </div>
        )}
        <footer className="delivery-pagination">
          <span>
            {view === "board" ? "看板显示本页任务 · " : ""}共 {s.filtered_total}{" "}
            单
            {rows.length ? ` · 当前 ${offset + 1}–${offset + rows.length}` : ""}
          </span>
          <div>
            <button
              className="secondary"
              disabled={!offset || busy}
              onClick={() => onOffset(Math.max(0, offset - 30))}
            >
              上一页
            </button>
            <span>{Math.floor(offset / 30) + 1}</span>
            <button
              className="secondary"
              disabled={busy || offset + rows.length >= s.filtered_total}
              onClick={() => onOffset(offset + 30)}
            >
              下一页
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

export function DeliveryDetailHeader({ order: o, tab, onTab, onBack }: any) {
  const complete = o.checklist.filter(
      (i: any) => i.required && (i.fileId || i.waiver),
    ).length,
    required = o.checklist.filter((i: any) => i.required).length;
  const nextTab = ["collecting", "checking"].includes(o.status)
    ? "materials"
    : o.status === "processing"
      ? "processing"
      : "review";
  return (
    <div className="delivery-detailHeader">
      <button className="ghost" onClick={onBack}>
        ← 返回工作清单
      </button>
      <div className="delivery-heading">
        <div>
          <span className="delivery-eyebrow">
            {o.company_code} · {o.period} · 第 {o.revision} 版交付
          </span>
          <h1>{o.company_name}</h1>
        </div>
        <Status value={o.status} />
      </div>
      <div className="delivery-detailMeta">
        <span>
          经办 <strong>{o.assignee_name || "未分配"}</strong>
        </span>
        <span>
          复核 <strong>{o.reviewer_name || "未分配"}</strong>
        </span>
        <span>
          截止 <strong>{o.due_date}</strong>
        </span>
        <span>
          必需资料{" "}
          <strong>
            {complete}/{required}
          </strong>
        </span>
      </div>
      <ol className="delivery-progress">
        {deliveryStages.map((stage, i) => (
          <li
            className={i <= deliveryStages.indexOf(o.status) ? "is-done" : ""}
          >
            <span>{i + 1}</span>
            {deliveryNames[stage]}
          </li>
        ))}
      </ol>
      <div className="delivery-next">
        <div>
          <strong>下一步：{nextSteps[o.status]}</strong>
          <small>
            {o.status === "collecting" && complete < required
              ? `还有 ${required - complete} 项必需资料待补充。上传后记得关联到清单。`
              : o.status === "processing"
                ? "在处理区创建任务、回传成果，完成后到「复核与交付」提交。"
                : "按当前阶段完成检查，系统会保留每次操作记录。"}
          </small>
        </div>
        <button className="secondary" onClick={() => onTab(nextTab)}>
          去处理 →
        </button>
      </div>
      <nav className="delivery-detailTabs" aria-label="工作单分区">
        {[
          ["materials", "资料收集"],
          ["processing", "经办处理"],
          ["review", "复核与交付"],
          ["history", "分工与记录"],
        ].map(([key, label]) => (
          <button
            aria-pressed={tab === key}
            className={tab === key ? "is-active" : ""}
            onClick={() => onTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export function DeliveryActivity({ items, files = [] }: any) {
  const names: Record<string, string> = {
    order_created: "建立工作单",
    assigned: "调整分工",
    order_assigned: "调整分工",
    material_receive: "关联资料",
    material_waive: "豁免缺件",
    finish_collection: "完成资料收集",
    start_processing: "进入经办处理",
    submit: "提交复核",
    approve: "通过复核",
    reject: "退回经办",
    deliver: "登记交付并归档",
    request_reopen: "申请重开",
    reopen: "批准重开",
  };
  return (
    <ol className="delivery-activity">
      {items?.map((x: any) => (
        <li>
          <i />
          <div>
            <strong>{names[x.action] || x.action}</strong>
            {x.delivery?.channel && (
              <p>
                交付方式：{x.delivery.channel} · 证据：
                {files.find((f: any) => f.id === x.delivery.evidenceFileId)
                  ?.name || "已记录"}
              </p>
            )}
            <small>
              {x.actor_name || "系统"} ·{" "}
              {new Date(x.created_at).toLocaleString("zh-CN", {
                timeZone: "Asia/Shanghai",
              })}
            </small>
          </div>
        </li>
      ))}
      {!items?.length && <p>暂无工作单操作记录</p>}
    </ol>
  );
}
