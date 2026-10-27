import { useEffect, useRef, useState } from "preact/hooks";
const stages: any = {
  collecting: "待收集",
  checking: "整理核对",
  processing: "经办处理",
  review: "待复核",
  delivery: "待交付",
  archived: "已归档",
};
const roles: any = {
  owner: "负责人",
  reviewer: "复核",
  operator: "经办",
  viewer: "只读",
};
const defaults = [
  { name: "银行流水", required: true },
  { name: "账务明细", required: true },
  { name: "票据资料", required: true },
];
function Feedback({ error }: any) {
  return error ? (
    <p className="agency-error" role="alert" tabIndex={-1}>
      {error}
    </p>
  ) : null;
}
function Pager({ offset, total, onChange }: any) {
  return (
    <div className="agency-pager">
      <span>
        共 {total} 条 · {total ? offset + 1 : 0}–{Math.min(offset + 30, total)}
      </span>
      <button
        className="secondary"
        disabled={!offset}
        onClick={() => onChange(offset - 30)}
      >
        上一页
      </button>
      <button
        className="secondary"
        disabled={offset + 30 >= total}
        onClick={() => onChange(offset + 30)}
      >
        下一页
      </button>
    </div>
  );
}
function ClientForm({ client, users, period, onSave, onCancel }: any) {
  const [first, setFirst] = useState(!client),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const ref = useRef<HTMLParagraphElement>(null);
  async function submit(e: any) {
    e.preventDefault();
    const v: any = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      const checklist = [
        ...String(v.requiredItems || "")
          .split("\n")
          .filter((v) => v.trim())
          .map((name) => ({ name: name.trim(), required: true })),
        ...String(v.optionalItems || "")
          .split("\n")
          .filter((v) => v.trim())
          .map((name) => ({ name: name.trim(), required: false })),
      ];
      if (v.assigneeId === v.reviewerId)
        throw Error("经办与复核必须是不同人员。");
      if (!checklist.length) throw Error("请至少填写一项资料要求。");
      await onSave({
        name: v.name,
        code: v.code,
        profile: {
          contactName: v.contactName,
          contactPhone: v.contactPhone,
          serviceNotes: v.serviceNotes,
        },
        checklist,
        assigneeId: v.assigneeId,
        reviewerId: v.reviewerId,
        ...(client
          ? { version: client.version }
          : first
            ? { firstMonth: { period: v.period, dueDate: v.dueDate } }
            : {}),
      });
    } catch (e: any) {
      setError(e.message);
      queueMicrotask(() => ref.current?.focus());
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel agency-form">
      <header>
        <h2>{client ? "修改客户档案与默认分工" : "客户建档与首月安排"}</h2>
        <p>
          一次填写客户、人员和资料要求。保存时同时授予所选经办与复核人员本公司访问权限。
        </p>
      </header>
      <form onSubmit={submit}>
        {error && (
          <p ref={ref} role="alert" tabIndex={-1} className="agency-error">
            {error}
          </p>
        )}
        <fieldset disabled={busy}>
          <legend>1 · 客户信息</legend>
          <div className="formgrid">
            <label>
              公司名称
              <input
                name="name"
                required
                maxLength={200}
                defaultValue={client?.name}
              />
            </label>
            <label>
              内部客户编号
              <input
                name="code"
                required
                maxLength={200}
                defaultValue={client?.code}
              />
            </label>
            <label>
              客户联系人（选填）
              <input
                name="contactName"
                maxLength={100}
                defaultValue={client?.profile?.contactName}
              />
            </label>
            <label>
              联系电话（选填）
              <input
                name="contactPhone"
                maxLength={100}
                defaultValue={client?.profile?.contactPhone}
              />
            </label>
          </div>
          <label>
            服务约定与交接备注（选填）
            <textarea
              name="serviceNotes"
              maxLength={2000}
              defaultValue={client?.profile?.serviceNotes}
              placeholder="记录资料交接方式、服务范围或注意事项"
            />
          </label>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>2 · 持续分工</legend>
          <div className="formgrid">
            <label>
              默认经办
              <select
                name="assigneeId"
                required
                defaultValue={client?.default_assignee_id || ""}
              >
                <option value="">请选择经办</option>
                {users
                  .filter((u: any) => u.active && u.role !== "viewer")
                  .map((u: any) => (
                    <option value={u.id}>
                      {u.name} · {roles[u.role]}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              默认复核
              <select
                name="reviewerId"
                required
                defaultValue={client?.default_reviewer_id || ""}
              >
                <option value="">请选择复核</option>
                {users
                  .filter(
                    (u: any) =>
                      u.active && ["owner", "reviewer"].includes(u.role),
                  )
                  .map((u: any) => (
                    <option value={u.id}>
                      {u.name} · {roles[u.role]}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <p className="muted">
            默认分工用于新月份。已有工作单请在该月份的“分工与记录”调整，历史经办记录会保留。
          </p>
        </fieldset>
        <fieldset disabled={busy}>
          <legend>3 · 每月资料要求</legend>
          <div className="formgrid">
            <label>
              必需资料（一行一项）
              <textarea
                name="requiredItems"
                rows={4}
                defaultValue={(client?.template || defaults)
                  .filter((i: any) => i.required)
                  .map((i: any) => i.name)
                  .join("\n")}
              />
            </label>
            <label>
              可选资料（一行一项）
              <textarea
                name="optionalItems"
                rows={4}
                defaultValue={(client?.template || [])
                  .filter((i: any) => !i.required)
                  .map((i: any) => i.name)
                  .join("\n")}
              />
            </label>
          </div>
          <p className="muted">
            模板修改只影响之后建立的月份，不改动已开始的资料清单。
          </p>
        </fieldset>
        {!client && (
          <fieldset disabled={busy}>
            <legend>4 · 首月工作</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={first}
                onChange={(e) => setFirst(e.currentTarget.checked)}
              />
              同时安排首月工作
            </label>
            {first && (
              <div className="formgrid">
                <label>
                  首月会计期间
                  <input
                    type="month"
                    name="period"
                    required
                    defaultValue={period}
                  />
                </label>
                <label>
                  首月截止日期
                  <input type="date" name="dueDate" required />
                </label>
              </div>
            )}
          </fieldset>
        )}
        <div className="agency-actions">
          <button disabled={busy}>
            {busy
              ? "正在保存…"
              : client
                ? "保存档案与分工"
                : first
                  ? "建档并安排首月"
                  : "保存客户档案"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      </form>
    </section>
  );
}

export function ClientWorkspace({
  api,
  period,
  companyId,
  owner,
  reviewer,
  users,
  onChanged,
  onOpen,
}: any) {
  const [data, setData] = useState<any>({
      rows: [],
      total: 0,
      unstaffed: 0,
      unstarted: 0,
      filtered_total: 0,
    }),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [attention, setAttention] = useState("all"),
    [offset, setOffset] = useState(0),
    [client, setClient] = useState<any>(null),
    [editing, setEditing] = useState(false),
    [creating, setCreating] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const generation = useRef(0);
  const detailGeneration = useRef(0);
  const currentScope = useRef("");
  currentScope.current = companyId + "|" + period;
  const workspaceRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    workspaceRef.current?.scrollIntoView({ block: "start" });
  }, [client?.id, editing, creating]);
  const refresh = async () => {
    const g = ++generation.current;
    setBusy(true);
    setData((d: any) => ({ ...d, rows: [] }));
    setError("");
    try {
      const d = await api(
        "/clients?" +
          new URLSearchParams({
            period,
            companyId,
            search,
            attention,
            offset: String(offset),
          }),
      );
      if (g === generation.current) {
        setData(d);
        if (offset && offset >= d.filtered_total)
          setOffset(Math.max(0, Math.ceil(d.filtered_total / 30) - 1) * 30);
      }
    } catch (e: any) {
      if (g === generation.current) setError(e.message);
    } finally {
      if (g === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
    };
  }, [period, companyId, search, attention, offset]);
  useEffect(() => {
    detailGeneration.current++;
    setClient(null);
    setCreating(false);
    setEditing(false);
    setOffset(0);
  }, [period, companyId]);
  useEffect(
    () => () => {
      detailGeneration.current++;
    },
    [],
  );
  const execute = async (fn: any) => {
    const g = detailGeneration.current;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e: any) {
      if (g === detailGeneration.current) setError(e.message);
    } finally {
      if (g === detailGeneration.current) setBusy(false);
    }
  };
  const open = async (id: string) => {
    const g = ++detailGeneration.current;
    const scope = currentScope.current;
    await execute(async () => {
      const next = await api(
        `/clients/${id}?period=${encodeURIComponent(period)}`,
      );
      if (g !== detailGeneration.current || scope !== currentScope.current)
        return;
      setClient(next);
      setEditing(false);
      setCreating(false);
    });
  };
  const refreshClient = async () => {
    const g = detailGeneration.current;
    const scope = currentScope.current;
    const next = await api(
      `/clients/${client.id}?period=${encodeURIComponent(period)}`,
    );
    if (g === detailGeneration.current && scope === currentScope.current)
      setClient(next);
  };
  const currentOrder =
    client?.current_order ||
    client?.orders.find((o: any) => o.period === period);
  if (creating || editing)
    return (
      <>
        <Feedback error={error} />
        <ClientForm
          key={client?.id || "new"}
          client={editing ? client : null}
          users={users}
          period={period}
          onCancel={() => {
            setCreating(false);
            setEditing(false);
          }}
          onSave={async (b: any) => {
            const g = detailGeneration.current;
            const scope = currentScope.current;
            const result = await api(
              editing ? `/clients/${client.id}/profile` : "/clients/onboard",
              b,
            );
            await onChanged();
            const next = await api(
              `/clients/${result.id}?period=${encodeURIComponent(period)}`,
            );
            if (
              g !== detailGeneration.current ||
              scope !== currentScope.current
            )
              return;
            setClient(next);
            setCreating(false);
            setEditing(false);
            setMessage(
              result.orderId
                ? "客户、授权和首月工作已一并保存，可直接开始收集资料。"
                : "客户档案已保存，现有月份保持原分工。",
            );
            void refresh();
          }}
        />
      </>
    );
  if (client)
    return (
      <div className="agency-workspace" ref={workspaceRef}>
        <button
          className="secondary"
          onClick={() => {
            detailGeneration.current++;
            setBusy(false);
            setClient(null);
            setMessage("");
            void refresh();
          }}
        >
          ← 返回客户清单
        </button>
        <Feedback error={error} />
        {message && (
          <p role="status" className="agency-success">
            {message}
          </p>
        )}
        <div className="agency-heading">
          <div>
            <small>{client.code}</small>
            <h1>{client.name}</h1>
            <p>
              {client.profile?.contactName || "未填写联系人"}
              {client.profile?.contactPhone
                ? " · " + client.profile.contactPhone
                : ""}
            </p>
          </div>
          {owner && (
            <button disabled={busy} onClick={() => setEditing(true)}>
              修改档案与分工
            </button>
          )}
        </div>
        <div className="agency-columns">
          <section className="panel">
            <h2>客户交接</h2>
            <p>
              {client.profile?.serviceNotes ||
                "暂无服务约定，负责人可在档案中补充。"}
            </p>
            <dl className="agency-facts">
              <dt>默认经办</dt>
              <dd>
                {client.members.find(
                  (u: any) => u.id === client.default_assignee_id,
                )?.name || "待安排"}
              </dd>
              <dt>默认复核</dt>
              <dd>
                {client.members.find(
                  (u: any) => u.id === client.default_reviewer_id,
                )?.name || "待安排"}
              </dd>
            </dl>
            <h3>每月资料要求</h3>
            <ul>
              {client.template.map((i: any) => (
                <li>
                  {i.name} <small>{i.required ? "必需" : "可选"}</small>
                </li>
              ))}
            </ul>
          </section>
          <section className="panel">
            <h2>{period} 月度工作</h2>
            {currentOrder ? (
              <>
                <p>本月已建立 · {stages[currentOrder.status]}</p>
                <button onClick={() => onOpen(currentOrder.id)}>
                  进入本月工作
                </button>
              </>
            ) : reviewer ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const v: any = Object.fromEntries(
                    new FormData(e.currentTarget),
                  );
                  void execute(async () => {
                    const result = await api(
                      `/clients/${client.id}/start-month`,
                      { version: client.version, period, dueDate: v.dueDate },
                    );
                    await refreshClient();
                    onOpen(result.id);
                  });
                }}
              >
                <p>沿用客户默认分工和资料要求；重复安排会打开已有月份。</p>
                <label>
                  本月截止日期
                  <input type="date" name="dueDate" required />
                </label>
                <button disabled={busy || !client.staffed}>
                  安排并开始收集
                </button>
                {!client.staffed && (
                  <p>请负责人先检查默认人员、在职状态及公司授权。</p>
                )}
              </form>
            ) : (
              <p>本月尚未安排，请联系负责人或主管。</p>
            )}
            <h3>最近 24 个月份记录</h3>
            <div className="agency-months">
              {client.orders.map((o: any) => (
                <button className="secondary" onClick={() => onOpen(o.id)}>
                  {o.period} · {stages[o.status]}
                </button>
              ))}
              {!client.orders.length && <p>尚无月度记录。</p>}
            </div>
          </section>
        </div>
        {reviewer && !owner && (
          <section className="panel">
            <h2>调整后续月份资料要求</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v: any = Object.fromEntries(
                  new FormData(e.currentTarget),
                );
                void execute(async () => {
                  await api(`/companies/${client.id}/template`, {
                    version: client.version,
                    checklist: [
                      ...String(v.requiredItems || "")
                        .split("\n")
                        .filter((x) => x.trim())
                        .map((name) => ({ name: name.trim(), required: true })),
                      ...String(v.optionalItems || "")
                        .split("\n")
                        .filter((x) => x.trim())
                        .map((name) => ({
                          name: name.trim(),
                          required: false,
                        })),
                    ],
                  });
                  await refreshClient();
                  setMessage("资料模板已保存，仅用于之后建立的月份。");
                });
              }}
            >
              <div className="formgrid">
                <label>
                  必需资料（一行一项）
                  <textarea
                    name="requiredItems"
                    defaultValue={client.template
                      .filter((i: any) => i.required)
                      .map((i: any) => i.name)
                      .join("\n")}
                  />
                </label>
                <label>
                  可选资料（一行一项）
                  <textarea
                    name="optionalItems"
                    defaultValue={client.template
                      .filter((i: any) => !i.required)
                      .map((i: any) => i.name)
                      .join("\n")}
                  />
                </label>
              </div>
              <button disabled={busy}>保存后续月份资料要求</button>
            </form>
          </section>
        )}
        <section className="panel">
          <h2>可访问此客户的人员</h2>
          <p className="muted">
            负责人可访问全部客户。撤销授权即时生效；默认分工不会自动转交，请同步安排接手人员。
          </p>
          <div className="agency-members">
            {client.members.map((u: any) => (
              <div>
                <span>
                  <strong>{u.name}</strong> · {roles[u.role]}
                  {!u.active ? " · 已停用" : ""}
                </span>
                {owner && u.role !== "owner" && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void execute(async () => {
                        await api(`/companies/${client.id}/members`, {
                          userId: u.id,
                          enabled: false,
                        });
                        await refreshClient();
                        await onChanged();
                        setMessage(
                          "已撤销访问；如该员工仍在月度分工中，请到对应月份安排接手。",
                        );
                      })
                    }
                  >
                    撤销访问
                  </button>
                )}
              </div>
            ))}
          </div>
          {owner && (
            <form
              className="toolbar"
              onSubmit={(e) => {
                e.preventDefault();
                const v: any = Object.fromEntries(
                  new FormData(e.currentTarget),
                );
                void execute(async () => {
                  await api(`/companies/${client.id}/members`, {
                    userId: v.userId,
                    enabled: true,
                  });
                  await refreshClient();
                  setMessage("协作人员已授权。");
                });
              }}
            >
              <label>
                增加协作人员
                <select name="userId" required>
                  <option value="">请选择员工</option>
                  {users
                    .filter(
                      (u: any) =>
                        u.active &&
                        u.role !== "owner" &&
                        !client.members.some((m: any) => m.id === u.id),
                    )
                    .map((u: any) => (
                      <option value={u.id}>
                        {u.name} · {roles[u.role]}
                      </option>
                    ))}
                </select>
              </label>
              <button disabled={busy}>授予此公司访问</button>
            </form>
          )}
        </section>
      </div>
    );
  return (
    <div className="agency-workspace" ref={workspaceRef}>
      <div className="agency-heading">
        <div>
          <small>客户运营 · {period}</small>
          <h1>客户公司</h1>
          <p>先完成建档与分工，再开始客户月份；每一步都有下一步入口。</p>
        </div>
        {owner && (
          <button
            onClick={() => {
              detailGeneration.current++;
              setBusy(false);
              setCreating(true);
              setClient(null);
            }}
          >
            ＋ 客户建档
          </button>
        )}
      </div>
      <Feedback error={error} />
      <div className="agency-stats">
        {[
          ["all", "授权客户", data.total],
          ["unstaffed", "分工待完善", data.unstaffed],
          ["unstarted", "本月未安排", data.unstarted],
        ].map(([key, title, n]) => (
          <button
            className="secondary"
            aria-pressed={attention === key}
            onClick={() => {
              setAttention(String(key));
              setOffset(0);
            }}
          >
            <span>{title}</span>
            <strong>{n}</strong>
          </button>
        ))}
      </div>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query);
            setOffset(0);
          }}
        >
          <input
            aria-label="搜索客户档案"
            maxLength={100}
            placeholder="搜索客户名称或内部编号"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button disabled={busy}>搜索客户</button>
          <button
            type="button"
            className="secondary"
            onClick={() => void refresh()}
            disabled={busy}
          >
            刷新
          </button>
        </form>
        <p className="muted">
          分工待完善包含人员未安排、已停用或权限已撤销。统计限于当前授权及搜索范围。
        </p>
        <div className="agency-client-list">
          {data.rows.map((c: any) => (
            <article>
              <div>
                <button className="agency-link" onClick={() => void open(c.id)}>
                  {c.name}
                </button>
                <small>{c.code}</small>
              </div>
              <div>
                <span>经办 · {c.assignee_name || "未安排"}</span>
                <small>复核 · {c.reviewer_name || "未安排"}</small>
                {!c.staffed && (
                  <span className="agency-warning">需完善分工</span>
                )}
              </div>
              <div>
                <span>
                  {c.order_id ? stages[c.order_status] : "本月未安排"}
                </span>
                <small>
                  {c.due_date ? "截止 " + c.due_date : "先安排月份，再收集资料"}
                </small>
              </div>
              <div className="agency-actions">
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void open(c.id)}
                >
                  客户档案
                </button>
                {c.order_id && (
                  <button disabled={busy} onClick={() => onOpen(c.order_id)}>
                    进入本月
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
        {!busy && !data.rows.length && (
          <p className="agency-empty">
            当前没有匹配客户。可调整筛选，或由负责人开始客户建档。
          </p>
        )}
        <Pager
          offset={offset}
          total={data.filtered_total}
          onChange={setOffset}
        />
      </section>
    </div>
  );
}

export function ReviewCenter({
  api,
  period,
  companyId,
  onOpen,
  refreshKey,
}: any) {
  const [queue, setQueue] = useState("actionable"),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [offset, setOffset] = useState(0),
    [data, setData] = useState<any>({ rows: [] }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    setBusy(true);
    setData((d: any) => ({ ...d, rows: [] }));
    setError("");
    void api(
      "/reviews/queue?" +
        new URLSearchParams({
          period,
          companyId,
          queue,
          search,
          offset: String(offset),
        }),
    )
      .then((d: any) => {
        if (current) {
          setData(d);
          if (offset && offset >= d.total)
            setOffset(Math.max(0, Math.ceil(d.total / 30) - 1) * 30);
        }
      })
      .catch((e: any) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [period, companyId, queue, search, offset, reload, refreshKey]);
  useEffect(() => {
    setOffset(0);
  }, [period, companyId]);
  const tabs = [
    ["actionable", "我可复核"],
    ["review", "全部待复核"],
    ["returned", "退回跟进"],
    ["delivery", "待交付"],
    ["reopen", "重开申请"],
  ];
  return (
    <div className="agency-workspace">
      <div className="agency-heading">
        <div>
          <small>审核中心 · {period}</small>
          <h1>复核与交付</h1>
          <p>先看送审版本和校验说明，再进入具体月份作出独立复核结论。</p>
        </div>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => setReload(reload + 1)}
        >
          刷新队列
        </button>
      </div>
      <Feedback error={error} />
      <div className="agency-stats agency-review-tabs">
        {tabs.map(([key, title]) => (
          <button
            className="secondary"
            aria-pressed={queue === key}
            onClick={() => {
              setQueue(key);
              setOffset(0);
            }}
          >
            <span>{title}</span>
            <strong>{data[key] || 0}</strong>
          </button>
        ))}
      </div>
      <section className="panel">
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(query);
            setOffset(0);
          }}
        >
          <input
            aria-label="搜索审核客户"
            maxLength={100}
            placeholder="客户名称或编号"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
          <button disabled={busy}>搜索</button>
        </form>
        <p className="muted">
          “我可复核”已排除本人经办及本人送审的批次；统计限于授权公司、当前期间与搜索条件。
        </p>
        <div className="agency-review-list">
          {data.rows.map((o: any) => (
            <article>
              <div className="agency-heading">
                <div>
                  <h2>{o.company_name}</h2>
                  <small>
                    {o.company_code} · {o.period} · 第 {o.revision} 版 · 截止{" "}
                    {o.due_date}
                  </small>
                </div>
                <span className={"badge " + o.status}>{stages[o.status]}</span>
              </div>
              <div className="agency-facts-inline">
                <span>经办 {o.assignee_name}</span>
                <span>复核 {o.reviewer_name}</span>
                {o.submission && (
                  <span>
                    送审 {o.submitter_name} ·{" "}
                    {new Date(o.submission.at).toLocaleString("zh-CN", {
                      timeZone: "Asia/Shanghai",
                      hour12: false,
                    })}
                  </span>
                )}
              </div>
              {o.submission && (
                <p>
                  <strong>{o.result_count} 份送审成果：</strong>
                  {o.submission.files
                    .map((f: any) => `${f.name}（v${f.version}）`)
                    .join("、")}
                  <br />
                  {o.submission.checks?.summary}
                </p>
              )}
              {queue === "returned" && (
                <p className="agency-warning">
                  退回原因：{o.last_review_reason}
                </p>
              )}
              {queue === "reopen" && <p>重开原因：{o.reopen_request.reason}</p>}
              {["review", "reopen"].includes(queue) && !o.independent && (
                <p className="agency-warning">
                  你参与过经办或不是指定复核人员，可查看记录，不能审核此批次。
                </p>
              )}
              <button disabled={busy} onClick={() => onOpen(o.id)}>
                {queue === "delivery"
                  ? "登记交付与证据"
                  : queue === "returned"
                    ? "查看整改与再次送审"
                    : queue === "reopen"
                      ? "查看重开申请"
                      : o.independent
                        ? "进入复核"
                        : "查看工作单"}
              </button>
            </article>
          ))}
        </div>
        {!busy && !data.rows.length && (
          <p className="agency-empty">
            当前队列没有工作单。可切换“全部待复核”或其他队列查看后续事项。
          </p>
        )}
        <Pager offset={offset} total={data.total || 0} onChange={setOffset} />
      </section>
    </div>
  );
}
