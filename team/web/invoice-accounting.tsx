import { useEffect, useRef, useState } from "preact/hooks";
import { FilePicker } from "./file-picker.js";

export function useInvoiceAction() {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const active = useRef(true),
    running = useRef(false),
    request = useRef({ body: "", key: "" });
  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );
  const act = async (fn: any) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      if (active.current) setNotice(e.message);
    } finally {
      running.current = false;
      if (active.current) setBusy(false);
    }
  };
  const keyFor = (body: any) => {
    const signature = JSON.stringify(body);
    if (request.current.body !== signature)
      request.current = { body: signature, key: crypto.randomUUID() };
    return request.current.key;
  };
  return { busy, notice, setNotice, act, keyFor };
}
export const blankAccounting = () => ({
  businessType: "",
  handlingDate: "",
  currency: "",
  businessMode: "unknown",
  decision: "hold",
  conditionsConfirmed: false,
  ruleId: null,
  ruleVersion: null,
  recognitionBasis: "",
  existingVoucher: "",
  note: "",
  evidence: [] as any[],
});
const states: any = {
  draft: "规则待核验",
  verified: "已独立核验",
  rejected: "已驳回",
  superseded: "已被新版本替代",
  blocked: "待补资料",
  pending: "草稿待复核",
};

export function AccountingFields({
  api,
  detail,
  value,
  onChange,
  disabled,
}: any) {
  const [rules, setRules] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    void api(
      `/companies/${detail.company_id}/invoice-accounting-rules?limit=20&offset=${offset}`,
    )
      .then((x: any) => {
        if (current) {
          setRules((old) => (offset ? [...old, ...x] : x));
          setMore(x.length === 20);
        }
      })
      .catch((e: any) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [detail.company_id, offset, revision]);
  const matching = rules.filter(
    (r) =>
      r.status === "verified" &&
      r.business_type === value.businessType &&
      (!value.handlingDate ||
        (r.payload.validFrom <= value.handlingDate &&
          r.payload.validUntil >= value.handlingDate)),
  );
  const rule = matching.length === 1 ? matching[0] : null;
  const set = (key: string, next: any) =>
    onChange({
      ...value,
      [key]: next,
      ...(["businessType", "handlingDate"].includes(key)
        ? { conditionsConfirmed: false, ruleId: null, ruleVersion: null }
        : {}),
    });
  const evidenceIds = [
    ...new Set<string>(value.evidence.map((e: any) => e.fileId)),
  ];
  const choose = (ids: string[]) => {
    const next = ids.flatMap((id) => {
      const old = value.evidence.filter((e: any) => e.fileId === id);
      return old.length ? old : [{ fileId: id, requirement: "", note: "" }];
    });
    if (next.length > 30) {
      setError("最多保存 30 项材料与要求对应关系，请先移除不需要的对应项");
      return;
    }
    set("evidence", next);
  };
  return (
    <fieldset disabled={disabled} className="ops-form">
      <legend>本次业务与记账依据</legend>
      <p>
        开票不等于确认收入。先明确业务与是否已入账；未知信息保留待补，不猜测。
      </p>
      <label>
        实际业务类型
        <input
          value={value.businessType}
          maxLength={100}
          onInput={(e) => set("businessType", e.currentTarget.value)}
        />
      </label>
      <label>
        选用已核验规则的业务类型
        <select
          value={
            rules.some(
              (r) =>
                r.status === "verified" &&
                r.business_type === value.businessType,
            )
              ? value.businessType
              : ""
          }
          onChange={(e) => set("businessType", e.currentTarget.value)}
        >
          <option value="">请选择，或填写实际业务类型</option>
          {rules
            .filter((r) => r.status === "verified")
            .map((r) => (
              <option key={r.id} value={r.business_type}>
                {r.business_type} · {r.payload.name} · v{r.version}
              </option>
            ))}
        </select>
      </label>
      {more && (
        <button
          type="button"
          disabled={loading}
          onClick={() => setOffset(offset + 20)}
        >
          加载更多规则
        </button>
      )}
      <button
        type="button"
        disabled={loading}
        onClick={() => {
          setOffset(0);
          setRules([]);
          setRevision((x) => x + 1);
          onChange({
            ...value,
            conditionsConfirmed: false,
            ruleId: null,
            ruleVersion: null,
          });
        }}
      >
        {loading ? "读取规则中…" : "刷新已核验规则并重新确认"}
      </button>
      {error && <p role="alert">{error}</p>}
      <label>
        处理日期
        <input
          type="date"
          value={value.handlingDate}
          onInput={(e) => set("handlingDate", e.currentTarget.value)}
        />
      </label>
      <label>
        已明确的币种
        <select
          value={value.currency}
          onChange={(e) => set("currency", e.currentTarget.value)}
        >
          <option value="">尚未确认</option>
          <option value="CNY">人民币 CNY</option>
          <option value="OTHER">其他币种，转人工处理</option>
        </select>
      </label>
      <label>
        实际业务范围
        <select
          value={value.businessMode}
          onChange={(e) => set("businessMode", e.currentTarget.value)}
        >
          <option value="unknown">尚未确认</option>
          <option value="standard_sale">本期普通蓝字销项业务</option>
          <option value="other">复杂、调整或其他业务</option>
        </select>
      </label>
      <label>
        是否已入账及本次处理
        <select
          value={value.decision}
          onChange={(e) =>
            onChange({
              ...value,
              decision: e.currentTarget.value,
              existingVoucher: "",
              conditionsConfirmed: false,
            })
          }
        >
          <option value="hold">尚未确定，暂挂起</option>
          <option value="new_entry">确认未入账，准备分录草稿</option>
          <option value="link_existing">已入账，仅关联现有凭证</option>
        </select>
      </label>
      {value.decision === "link_existing" && (
        <label>
          本期现有凭证编号
          <input
            value={value.existingVoucher}
            maxLength={60}
            onInput={(e) => set("existingVoucher", e.currentTarget.value)}
          />
        </label>
      )}
      <label>
        实际业务确认依据
        <textarea
          maxLength={2000}
          value={value.recognitionBasis}
          onInput={(e) => set("recognitionBasis", e.currentTarget.value)}
        />
      </label>
      {rule && value.decision === "new_entry" && (
        <div>
          <p>规则适用条件：{rule.payload.conditions}</p>
          <p>必需依据：{rule.payload.requiredEvidence.join("、")}</p>
          <label>
            <input
              type="checkbox"
              disabled={loading || !!error}
              checked={
                value.conditionsConfirmed &&
                value.ruleId === rule.id &&
                value.ruleVersion === rule.version
              }
              onChange={(e) =>
                onChange({
                  ...value,
                  conditionsConfirmed: e.currentTarget.checked,
                  ruleId: e.currentTarget.checked ? rule.id : null,
                  ruleVersion: e.currentTarget.checked ? rule.version : null,
                })
              }
            />
            已核实本次业务符合这些条件
          </label>
        </div>
      )}
      <FilePicker
        api={api}
        scope={{
          companyId: detail.company_id,
          period: detail.period,
          orderId: detail.id,
        }}
        purpose="source"
        latestOnly
        selectedIds={evidenceIds}
        onChange={choose}
        maxSelection={30}
        disabled={disabled}
        title="选择业务原始依据"
      />
      <details>
        <summary>选择已上传的补充凭证</summary>
        <FilePicker
          api={api}
          scope={{
            companyId: detail.company_id,
            period: detail.period,
            orderId: detail.id,
          }}
          purpose="evidence"
          latestOnly
          selectedIds={evidenceIds}
          onChange={choose}
          maxSelection={30}
          disabled={disabled}
          title="补充业务凭证"
        />
      </details>
      {value.evidence.map((item: any, index: number) => (
        <div key={`${item.fileId}/${index}`}>
          <label>
            第 {index + 1} 份依据对应的要求名称
            <input
              required
              maxLength={100}
              value={item.requirement}
              onInput={(e) =>
                set(
                  "evidence",
                  value.evidence.map((v: any, i: number) =>
                    i === index
                      ? { ...v, requirement: e.currentTarget.value }
                      : v,
                  ),
                )
              }
            />
          </label>
          <label>
            这份材料证明什么
            <input
              required
              maxLength={1000}
              value={item.note}
              onInput={(e) =>
                set(
                  "evidence",
                  value.evidence.map((v: any, i: number) =>
                    i === index ? { ...v, note: e.currentTarget.value } : v,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            disabled={value.evidence.length >= 30}
            onClick={() =>
              set("evidence", [
                ...value.evidence,
                { fileId: item.fileId, requirement: "", note: "" },
              ])
            }
          >
            同一材料补充另一项依据
          </button>
          <button
            type="button"
            onClick={() =>
              set(
                "evidence",
                value.evidence.filter((_: any, i: number) => i !== index),
              )
            }
          >
            移除此对应项
          </button>
        </div>
      ))}
      <label>
        本次处理／修订说明
        <textarea
          required
          maxLength={2000}
          value={value.note}
          onInput={(e) => set("note", e.currentTarget.value)}
        />
      </label>
    </fieldset>
  );
}

export function AccountingRulePanel({ api, detail }: any) {
  const { busy, notice, setNotice, act, keyFor } = useInvoiceAction(),
    [rows, setRows] = useState<any[]>([]),
    [accounts, setAccounts] = useState<any[]>([]),
    [revision, setRevision] = useState(0),
    [offset, setOffset] = useState(0),
    [editing, setEditing] = useState(false),
    [selected, setSelected] = useState<any>(null),
    [businessType, setBusinessType] = useState(""),
    [reason, setReason] = useState("");
  const blank = () => ({
    name: "",
    validFrom: "",
    validUntil: "",
    conditions: "",
    requiredEvidence: [] as string[],
    lines: [
      { account: "", side: "debit", amountBasis: "gross", description: "" },
      { account: "", side: "credit", amountBasis: "net", description: "" },
    ],
  });
  const [payload, setPayload] = useState<any>(blank),
    [evidenceText, setEvidenceText] = useState("");
  useEffect(() => {
    let current = true;
    void Promise.all([
      api(
        `/companies/${detail.company_id}/invoice-accounting-rules?limit=20&offset=${offset}`,
      ),
      api(
        `/companies/${detail.company_id}/invoice-accounting-context?period=${detail.period}`,
      ),
    ])
      .then(([r, c]) => {
        if (current) {
          setRows(r);
          setAccounts(c.accounts);
        }
      })
      .catch((e: any) => {
        if (current) setNotice(e.message);
      });
    return () => {
      current = false;
    };
  }, [detail.company_id, detail.period, revision, offset]);
  const edit = (row: any) => {
    setSelected(row);
    setBusinessType(row?.business_type || "");
    setPayload(row ? structuredClone(row.payload) : blank());
    setEvidenceText(row?.payload.requiredEvidence.join("\n") || "");
    setReason("");
    setEditing(true);
  };
  return (
    <details className="ops-handoff">
      <summary>客户可复用记账规则</summary>
      <p>
        规则按实际业务及本期科目表填写。新版本须由另一名人员核验；核验后替代同业务旧版本，已形成的历史成果保留。
      </p>
      <button
        disabled={busy || !accounts.length}
        type="button"
        onClick={() => edit(null)}
      >
        准备新业务规则
      </button>
      {!accounts.length && <p>本期尚无可选科目，请先保存客户账务底稿。</p>}
      {editing && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const body = {
                version: selected?.version || 0,
                period: detail.period,
                businessType,
                reason,
                payload: {
                  ...payload,
                  requiredEvidence: evidenceText
                    .split("\n")
                    .map((x) => x.trim())
                    .filter(Boolean),
                },
              };
              await api(
                `/companies/${detail.company_id}/invoice-accounting-rules`,
                { ...body, key: keyFor(body) },
              );
              setEditing(false);
              setRevision((x) => x + 1);
              setNotice("规则草稿已保存，等待独立核验。");
            });
          }}
        >
          <fieldset className="ops-form" disabled={busy}>
            <legend>{selected ? "修订规则为新版本" : "新业务规则"}</legend>
            <label>
              业务类型
              <input
                required
                maxLength={100}
                value={businessType}
                disabled={!!selected}
                onInput={(e) => setBusinessType(e.currentTarget.value)}
              />
            </label>
            <label>
              规则名称
              <input
                required
                maxLength={200}
                value={payload.name}
                onInput={(e) =>
                  setPayload({ ...payload, name: e.currentTarget.value })
                }
              />
            </label>
            <label>
              起始日
              <input
                type="date"
                required
                value={payload.validFrom}
                onInput={(e) =>
                  setPayload({ ...payload, validFrom: e.currentTarget.value })
                }
              />
            </label>
            <label>
              截止日
              <input
                type="date"
                required
                value={payload.validUntil}
                onInput={(e) =>
                  setPayload({ ...payload, validUntil: e.currentTarget.value })
                }
              />
            </label>
            <label>
              实际业务适用条件
              <textarea
                required
                maxLength={2000}
                value={payload.conditions}
                onInput={(e) =>
                  setPayload({ ...payload, conditions: e.currentTarget.value })
                }
              />
            </label>
            <label>
              必需依据名称（每行一项，最多 10 项）
              <textarea
                required
                maxLength={1010}
                value={evidenceText}
                onInput={(e) => setEvidenceText(e.currentTarget.value)}
              />
            </label>
            {payload.lines.map((line: any, index: number) => (
              <fieldset key={index}>
                <legend>分录模板第 {index + 1} 行</legend>
                <label>
                  科目
                  <select
                    required
                    value={line.account}
                    onChange={(e) =>
                      setPayload({
                        ...payload,
                        lines: payload.lines.map((l: any, i: number) =>
                          i === index
                            ? { ...l, account: e.currentTarget.value }
                            : l,
                        ),
                      })
                    }
                  >
                    <option value="">请选择实际科目</option>
                    {accounts.map((a) => (
                      <option key={a.code} value={a.code}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                {(
                  [
                    [
                      "side",
                      "方向",
                      [
                        ["debit", "借方"],
                        ["credit", "贷方"],
                      ],
                    ],
                    [
                      "amountBasis",
                      "取数",
                      [
                        ["net", "不含税金额"],
                        ["tax", "税额"],
                        ["gross", "价税合计"],
                      ],
                    ],
                  ] as const
                ).map(([key, label, options]) => (
                  <label key={key}>
                    {label}
                    <select
                      value={line[key]}
                      onChange={(e) =>
                        setPayload({
                          ...payload,
                          lines: payload.lines.map((l: any, i: number) =>
                            i === index
                              ? { ...l, [key]: e.currentTarget.value }
                              : l,
                          ),
                        })
                      }
                    >
                      {options.map(([v, n]) => (
                        <option key={v} value={v}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
                <label>
                  摘要
                  <input
                    required
                    maxLength={500}
                    value={line.description}
                    onInput={(e) =>
                      setPayload({
                        ...payload,
                        lines: payload.lines.map((l: any, i: number) =>
                          i === index
                            ? { ...l, description: e.currentTarget.value }
                            : l,
                        ),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={payload.lines.length <= 2}
                  onClick={() =>
                    setPayload({
                      ...payload,
                      lines: payload.lines.filter(
                        (_: any, i: number) => i !== index,
                      ),
                    })
                  }
                >
                  删除此行
                </button>
              </fieldset>
            ))}
            <button
              type="button"
              disabled={payload.lines.length >= 20}
              onClick={() =>
                setPayload({
                  ...payload,
                  lines: [
                    ...payload.lines,
                    {
                      account: "",
                      side: "credit",
                      amountBasis: "tax",
                      description: "",
                    },
                  ],
                })
              }
            >
              增加模板行
            </button>
            <label>
              建立／修订原因
              <textarea
                required
                maxLength={2000}
                value={reason}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            </label>
          </fieldset>
          <button disabled={busy}>保存规则草稿</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            取消
          </button>
        </form>
      )}
      {!editing && (
        <label>
          核验或驳回说明
          <input
            maxLength={2000}
            value={reason}
            onInput={(e) => setReason(e.currentTarget.value)}
          />
        </label>
      )}
      {rows.map((row) => (
        <details key={row.id}>
          <summary>
            {row.business_type} · {row.payload.name} · v{row.version} ·{" "}
            {states[row.status]}
          </summary>
          <p>
            {row.payload.validFrom} 至 {row.payload.validUntil}
          </p>
          <p>{row.payload.conditions}</p>
          <p>必需依据：{row.payload.requiredEvidence.join("、")}</p>
          <ul>
            {row.payload.lines.map((l: any, i: number) => (
              <li key={i}>
                {l.account} · {l.side === "debit" ? "借" : "贷"} ·{" "}
                {
                  (
                    { net: "不含税金额", tax: "税额", gross: "价税合计" } as any
                  )[l.amountBasis]
                }{" "}
                · {l.description}
              </li>
            ))}
          </ul>
          {row.stale && (
            <p className="ops-error">
              规则编制所用科目底稿已变化，待核验版本需先修订。
            </p>
          )}
          {row.status === "draft" && row.reviewRestriction && (
            <p>{row.reviewRestriction}</p>
          )}
          <div className="ops-inline">
            <button
              type="button"
              disabled={busy || row.version !== row.latestVersion}
              onClick={() => edit(row)}
            >
              修订为新版本
            </button>
            {row.canReview &&
              !editing &&
              ["verify", "reject"].map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={
                    busy || !reason.trim() || (action === "verify" && row.stale)
                  }
                  onClick={() =>
                    void act(async () => {
                      await api(
                        `/invoice-accounting-rules/${row.id}/${action}`,
                        { version: row.version, reason },
                      );
                      setRevision((x) => x + 1);
                      setNotice(
                        action === "verify"
                          ? "规则已核验，新业务可按适用条件复用。"
                          : "规则已驳回，记录保留。",
                      );
                    })
                  }
                >
                  {action === "verify" ? "独立核验规则" : "驳回规则"}
                </button>
              ))}
          </div>
          <p>{row.review_reason}</p>
        </details>
      ))}
      <div className="ops-inline">
        <button
          type="button"
          disabled={busy || !offset}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页规则
        </button>
        <button
          type="button"
          disabled={busy || rows.length < 20}
          onClick={() => setOffset(offset + 20)}
        >
          下一页规则
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRevision((x) => x + 1)}
        >
          刷新规则及科目
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}

export function AccountingDraftView({
  api,
  draft: sourceDraft,
  onChanged,
  onEdit,
}: any) {
  const { busy, notice, setNotice, act } = useInvoiceAction(),
    [reviewed, setReviewed] = useState<any>(null),
    [reason, setReason] = useState("");
  useEffect(() => {
    setReviewed(null);
  }, [sourceDraft]);
  const draft = reviewed?.id === sourceDraft.id ? reviewed : sourceDraft;
  return (
    <section className="ops-receipt">
      <h4>
        {draft.number} · {states[draft.status]}
      </h4>
      <p>
        未过账 ·{" "}
        {draft.context.decision === "link_existing"
          ? `关联已入账凭证 ${draft.context.existingVoucher}`
          : "记账准备草稿"}
      </p>
      <p>{draft.context.recognitionBasis}</p>
      {draft.status === "rejected" && (
        <p role="status">
          复核驳回：{draft.review_reason}。可沿用原资料修订，重新提交独立复核。
        </p>
      )}
      {draft.status === "pending" && draft.reviewRestriction && (
        <p>{draft.reviewRestriction}</p>
      )}
      {draft.stale && (
        <p className="ops-error">
          当前科目、规则、资料或业务条件与此版本不一致；历史已核验成果保留，待复核草稿须修订。
        </p>
      )}
      <ul>
        {draft.currentIssues.map((i: any, n: number) => (
          <li key={n} className="ops-error">
            {i.message}
          </li>
        ))}
      </ul>
      <div className="ops-inline">
        {draft.lines.map((l: any, i: number) => (
          <dl key={i}>
            <dt>
              {l.account} · {l.accountName}
            </dt>
            <dd>
              借 {l.debit} · 贷 {l.credit}
            </dd>
            <dd>{l.description}</dd>
          </dl>
        ))}
      </div>
      <details>
        <summary>固定依据、规则与复核记录</summary>
        <p>
          底稿版本 {draft.basis.snapshotVersion || "缺失"} · 档案版本{" "}
          {draft.basis.dossierVersion || "缺失"} · 规则版本{" "}
          {draft.basis.ruleVersion || "不适用或缺失"}
        </p>
        <p>{draft.basis.rule?.payload.conditions}</p>
        {draft.basis.files.map((f: any) => (
          <p key={f.id}>
            <a href={`/api/v1/files/${f.id}/download`}>
              {f.name} · v{f.version}
            </a>
          </p>
        ))}
        <p>本次说明：{draft.context.note}</p>
        {draft.history.map((h: any, i: number) => (
          <p key={i}>
            {new Date(h.created_at).toLocaleString("zh-CN")} ·{" "}
            {h.details.reason || "草稿生成及检查"}
          </p>
        ))}
      </details>
      {draft.canRevise && onEdit && (
        <button type="button" disabled={busy} onClick={() => onEdit(draft)}>
          补齐／修订草稿
        </button>
      )}
      {draft.canReview && (
        <div>
          <label>
            独立复核或驳回说明
            <input
              maxLength={2000}
              value={reason}
              disabled={busy}
              onInput={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          {["verify", "reject"].map((action) => (
            <button
              type="button"
              key={action}
              disabled={
                busy ||
                !reason.trim() ||
                (action === "verify" && !draft.canVerify)
              }
              onClick={() =>
                void act(async () => {
                  const result = await api(
                    `/invoice-accounting-drafts/${draft.id}/${action}`,
                    { version: draft.version, reason },
                  );
                  setReviewed(result);
                  setNotice(
                    action === "verify"
                      ? "已形成独立复核的交接成果，未过账。"
                      : "草稿已驳回，历史保留。",
                  );
                  try {
                    await onChanged();
                  } catch {
                    setNotice(
                      "复核结果已保存，但列表刷新失败；本页已显示保存回执。请刷新进度，不要重复复核。",
                    );
                  }
                })
              }
            >
              {action === "verify" ? "复核通过，形成交接成果" : "驳回草稿"}
            </button>
          ))}
        </div>
      )}
      {draft.canExport && (
        <p>
          <a
            href={`/api/v1/invoice-accounting-drafts/${draft.id}/export?format=xlsx`}
          >
            下载 XLSX 交接成果
          </a>{" "}
          ·{" "}
          <a
            href={`/api/v1/invoice-accounting-drafts/${draft.id}/export?format=json`}
          >
            下载 JSON 完整来源
          </a>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function InvoiceAccounting({ api, detail, request, onRefresh }: any) {
  const { busy, notice, setNotice, act, keyFor } = useInvoiceAction(),
    [ledger, setLedger] = useState<any>(null),
    [draft, setDraft] = useState<any>(null),
    [history, setHistory] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [editing, setEditing] = useState(false),
    [editingVersion, setEditingVersion] = useState(0),
    [context, setContext] = useState<any>(blankAccounting);
  useEffect(() => {
    let active = true;
    void api(
      `/orders/${detail.id}/invoice-ledger?requestId=${request.id}&limit=1`,
    )
      .then(async (rows: any[]) => {
        const entry = rows[0];
        if (!active) return;
        setLedger(entry || null);
        setDraft(entry?.latestDraft || null);
        if (entry) {
          const full = await api(
            `/invoice-ledger/${entry.id}?limit=20&offset=${offset}`,
          );
          if (active) setHistory(full.drafts);
        } else setHistory([]);
      })
      .catch((e: any) => {
        if (active) setNotice(e.message);
      });
    return () => {
      active = false;
    };
  }, [request.id, request.recordedIssued, detail.id, revision, offset]);
  const changed = async () => {
    setRevision((x) => x + 1);
    await onRefresh();
  };
  const edit = (d: any) => {
    setContext(d ? structuredClone(d.context) : blankAccounting());
    setEditingVersion(d?.version || 0);
    setEditing(true);
  };
  return (
    <section className="ops-handoff">
      <h4>回录台账与记账草稿</h4>
      <p>
        先明确实际业务与是否已入账。此处只准备独立的台账和交接草稿，不修改客户账务底稿。
      </p>
      {!ledger && request.recordedIssued && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await api(`/invoice-requests/${request.id}/ledger`, {
                version: request.version,
              });
              setNotice("已登记唯一销项台账，未入账。");
              await changed();
            })
          }
        >
          登记已核验回执台账
        </button>
      )}
      {!request.recordedIssued && (
        <p>实际成功回执独立核验后，才能登记台账和准备记账草稿。</p>
      )}
      {ledger && (
        <p>
          台账已登记 · 发票 {ledger.snapshot.payload.invoiceNumber} · 价税合计{" "}
          {ledger.snapshot.payload.gross}
        </p>
      )}
      {ledger && !draft && (
        <button type="button" disabled={busy} onClick={() => edit(null)}>
          准备记账草稿
        </button>
      )}
      {editing && ledger && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const body = { version: editingVersion, context };
              const result = await api(
                `/invoice-ledger/${ledger.id}/accounting-drafts`,
                { ...body, key: keyFor(body) },
              );
              setDraft(result);
              setEditing(false);
              setNotice(
                result.status === "blocked"
                  ? "草稿已保存，仍有待补事项。"
                  : "草稿已保存，等待独立复核。",
              );
              await changed();
            });
          }}
        >
          <AccountingFields
            key={ledger.id}
            api={api}
            detail={detail}
            value={context}
            onChange={setContext}
            disabled={busy}
          />
          <button disabled={busy}>
            {busy ? "保存中…" : "保存并检查记账草稿"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setEditing(false)}
          >
            取消编辑
          </button>
        </form>
      )}
      {draft && !editing && (
        <AccountingDraftView
          key={draft.id}
          api={api}
          draft={draft}
          onChanged={changed}
          onEdit={edit}
        />
      )}
      {!!history.length && (
        <details>
          <summary>草稿历史版本</summary>
          {history.map((h) => (
            <p key={h.id}>
              v{h.version} · {states[h.status]}{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    setDraft(await api(`/invoice-accounting-drafts/${h.id}`));
                    setEditing(false);
                  })
                }
              >
                查看此版本
              </button>
            </p>
          ))}
          <button
            type="button"
            disabled={busy || !offset}
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            上一页历史
          </button>
          <button
            type="button"
            disabled={busy || history.length < 20}
            onClick={() => setOffset(offset + 20)}
          >
            下一页历史
          </button>
        </details>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={() => setRevision((x) => x + 1)}
      >
        刷新台账与草稿
      </button>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
