import { useEffect, useRef, useState } from "preact/hooks";
import { FilePicker } from "./file-picker.js";

const labels: Record<string, string> = {
  draft: "待核验",
  verified: "已核验",
  revoked: "已撤销",
  effective: "有效",
  expired: "已到期",
  not_started: "未到起始日",
  company_inactive: "客户已停用",
  pending: "待独立核验",
  rejected: "已驳回",
  issued: "成功回执",
  failed: "失败回执",
  unknown: "结果不明",
  prepared: "已保存申请",
  blocked: "未能保存",
  result_pending_review: "回录待核验",
  result_rejected: "回录驳回待修正",
  recorded_issued: "成功回录已核验",
  result_unknown: "结果不明",
  result_failed: "失败回录已核验",
  awaiting_authorization: "待有效授权",
  awaiting_review: "申请待核验",
  ready: "申请已核验",
  needs_materials: "申请待补资料",
  stale: "依据已变化",
  withdrawn: "已撤回",
};
function useAction() {
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const mounted = useRef(true),
    running = useRef(false),
    key = useRef({ signature: "", value: "" });
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const act = async (fn: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      if (mounted.current) setNotice(e.message);
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const stableKey = (body: any) => {
    const signature = JSON.stringify(body);
    if (key.current.signature !== signature)
      key.current = { signature, value: crypto.randomUUID() };
    return key.current.value;
  };
  const resetKey = () => {
    key.current = { signature: "", value: "" };
  };
  return { busy, notice, setNotice, act, stableKey, resetKey };
}
function Attachments({ files }: any) {
  return (
    <ul>
      {files.map((f: any) => (
        <li key={f.id}>
          <a href={`/api/v1/files/${f.id}/download`}>
            {f.name} · v{f.version}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function AuthorizationSelect({
  api,
  companyId,
  value,
  onChange,
  disabled,
  scope,
  refreshKey,
}: any) {
  const [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [more, setMore] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    setRows([]);
    setOffset(0);
  }, [companyId, refreshKey]);
  useEffect(() => {
    let alive = true;
    setError("");
    void api(
      `/companies/${companyId}/invoice-authorizations?limit=20&offset=${offset}`,
    )
      .then((x: any[]) => {
        if (alive) {
          setRows((old) =>
            offset
              ? [...old.filter((v) => !x.some((n) => n.id === v.id)), ...x]
              : x,
          );
          setMore(x.length === 20);
        }
      })
      .catch((e: any) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [companyId, offset, refreshKey]);
  return (
    <div>
      <label>
        选择已核验的逐户授权
        <select
          disabled={disabled}
          value={value?.id || ""}
          onChange={(e) => {
            const row = rows.find((x) => x.id === e.currentTarget.value);
            onChange(row ? { id: row.id, version: row.version } : null);
          }}
        >
          <option value="">请选择授权记录</option>
          {value && !rows.some((x) => x.id === value.id) && (
            <option value={value.id}>
              已绑定版本 {value.version}（请加载并核实）
            </option>
          )}
          {rows.map((x) => (
            <option
              key={x.id}
              value={x.id}
              disabled={
                x.state !== "effective" || !x.payload.scopes.includes(scope)
              }
            >
              {x.payload.agencyName} · {x.payload.validUntil} ·{" "}
              {labels[x.state] || x.state} · v{x.version}
            </option>
          ))}
        </select>
      </label>
      {more && (
        <button
          type="button"
          className="ghost"
          disabled={disabled}
          onClick={() => setOffset(offset + 20)}
        >
          加载更多授权
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function EvidencePicker({
  api,
  detail,
  ids,
  onChange,
  purpose,
  disabled,
  onRefresh,
}: any) {
  const { busy, notice, setNotice, act } = useAction(),
    [revision, setRevision] = useState(0),
    [file, setFile] = useState<File | null>(null);
  const upload = useRef({ file: null as File | null, key: "" });
  return (
    <section>
      <FilePicker
        api={api}
        scope={{
          companyId: detail.company_id,
          period: detail.period,
          orderId: detail.id,
        }}
        purpose="evidence"
        eligibleOnly
        selectedIds={ids}
        onChange={onChange}
        maxSelection={20}
        disabled={disabled || busy}
        refreshKey={`${detail.version}/${revision}`}
        title={
          purpose === "authorization" ? "授权凭证附件" : "实际开票回执附件"
        }
      />
      <label>
        上传 PDF 或图片原件
        <input
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          disabled={disabled || busy}
          onChange={(e) => setFile(e.currentTarget.files?.[0] || null)}
        />
      </label>
      <button
        type="button"
        disabled={disabled || busy || !file || ids.length >= 20}
        onClick={() =>
          void act(async () => {
            if (!file) return;
            if (
              file.size > 50 * 1024 * 1024 ||
              !/\.(pdf|png|jpe?g)$/i.test(file.name)
            )
              throw Error("请选择 50 MB 以内的 PDF 或图片");
            if (upload.current.file !== file)
              upload.current = { file, key: crypto.randomUUID() };
            const current = await api(`/orders/${detail.id}`);
            const form = new FormData();
            form.set("file", file);
            const category =
              purpose === "authorization" ? "客户开票授权凭证" : "开票结果回执";
            const result = await api(
              `/orders/${detail.id}/files?kind=evidence&version=${current.version}&key=${upload.current.key}&category=${encodeURIComponent(category)}`,
              form,
            );
            onChange([...new Set<string>([...ids, result.id])]);
            setRevision((x) => x + 1);
            setNotice("凭证已上传并选中");
            await onRefresh();
          })
        }
      >
        {busy ? "上传中…" : "上传并选用凭证"}
      </button>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function InvoiceAuthorizations({ api, detail, onRefresh }: any) {
  const { busy, notice, setNotice, act, stableKey } = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [show, setShow] = useState(false),
    [reason, setReason] = useState("");
  const [ids, setIds] = useState<string[]>([]),
    [payload, setPayload] = useState<any>({
      sellerName: "",
      sellerTaxId: "",
      agencyName: "",
      representative: "",
      region: "",
      channelLabel: "",
      validFrom: "",
      validUntil: "",
      scopes: ["prepare_applications", "record_results"],
      note: "",
    });
  useEffect(() => {
    let alive = true;
    void api(
      `/companies/${detail.company_id}/invoice-authorizations?limit=20&offset=${offset}`,
    )
      .then((x: any) => {
        if (alive) setRows(x);
      })
      .catch((e: any) => {
        if (alive) setNotice(e.message);
      });
    return () => {
      alive = false;
    };
  }, [detail.company_id, revision, offset]);
  const review = (row: any, action: string) =>
    void act(async () => {
      await api(`/invoice-authorizations/${row.id}/${action}`, {
        version: row.version,
        reason,
      });
      setRevision((x) => x + 1);
      setNotice(
        action === "verify"
          ? "本地授权记录已核验；未建立税务平台授权。"
          : "本地授权已撤销，关联申请不能继续核验。",
      );
      await onRefresh();
    });
  return (
    <details className="ops-handoff">
      <summary>客户逐户授权登记与核验</summary>
      <p>
        按实际委托文件登记代账机构、人员、范围和期限。日期按北京时间判断；本地核验不会建立税务平台授权或保存登录密码。变更资料请撤销旧记录后新建。
      </p>
      <button
        type="button"
        disabled={busy || detail.status !== "processing"}
        onClick={() => setShow(!show)}
      >
        {show ? "收起登记" : "登记授权草稿"}
      </button>
      {show && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              if (!ids.length) throw Error("请上传或选择实际授权凭证");
              const body = { payload, evidenceFileIds: ids };
              await api(`/orders/${detail.id}/invoice-authorizations`, {
                ...body,
                key: stableKey(body),
              });
              setShow(false);
              setRevision((x) => x + 1);
              setNotice("授权草稿已登记，等待另一名人员核验。");
            });
          }}
        >
          <fieldset className="ops-form" disabled={busy}>
            <legend>实际委托信息</legend>
            {(
              [
                ["sellerName", "客户法定名称", 200],
                ["sellerTaxId", "客户税号", 30],
                ["agencyName", "代账机构名称", 200],
                ["representative", "被授权经办人员", 100],
                ["region", "所属税务地区", 100],
                ["channelLabel", "授权适用渠道或办理方式", 100],
                ["validFrom", "授权起始日", 10],
                ["validUntil", "授权截止日", 10],
                ["note", "授权依据与范围说明", 2000],
              ] as const
            ).map(([key, label, max]) => (
              <label key={key}>
                {label}
                <input
                  required
                  maxLength={max}
                  {...(key.startsWith("valid")
                    ? { type: "date" as const }
                    : { type: "text" as const })}
                  value={payload[key]}
                  onInput={(e) =>
                    setPayload({ ...payload, [key]: e.currentTarget.value })
                  }
                />
              </label>
            ))}
            <label>
              操作范围
              <select
                value={payload.scopes.join(",")}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    scopes: e.currentTarget.value.split(","),
                  })
                }
              >
                <option value="prepare_applications,record_results">
                  准备申请及回录结果
                </option>
                <option value="prepare_applications">仅准备申请</option>
                <option value="record_results">仅回录结果</option>
              </select>
            </label>
          </fieldset>
          <EvidencePicker
            api={api}
            detail={detail}
            ids={ids}
            onChange={setIds}
            purpose="authorization"
            disabled={busy}
            onRefresh={onRefresh}
          />
          <button disabled={busy}>{busy ? "保存中…" : "保存授权草稿"}</button>
        </form>
      )}
      <label>
        核验或撤销说明
        <input
          maxLength={2000}
          value={reason}
          disabled={busy}
          onInput={(e) => setReason(e.currentTarget.value)}
        />
      </label>
      {rows.map((row) => (
        <details key={row.id}>
          <summary>
            {row.payload.sellerName} · {row.payload.agencyName} ·{" "}
            {labels[row.state] || row.state} · v{row.version}
          </summary>
          <p>
            {row.payload.representative} · {row.payload.region} ·{" "}
            {row.payload.channelLabel}
          </p>
          <p>
            {row.payload.validFrom} 至 {row.payload.validUntil} ·{" "}
            {row.payload.scopes
              .map((x: string) =>
                x === "prepare_applications" ? "准备申请" : "回录结果",
              )
              .join("、")}
          </p>
          <p>{row.payload.note}</p>
          <Attachments files={row.evidence} />
          <div className="ops-inline">
            {row.canVerify && (
              <button
                type="button"
                disabled={busy || !reason.trim()}
                onClick={() => review(row, "verify")}
              >
                确认已核实授权凭证
              </button>
            )}
            {row.canRevoke && (
              <button
                type="button"
                className="secondary"
                disabled={busy || !reason.trim()}
                onClick={() => review(row, "revoke")}
              >
                撤销本地授权
              </button>
            )}
          </div>
          <ul>
            {row.history.map((h: any, i: number) => (
              <li key={i}>
                {new Date(h.created_at).toLocaleString("zh-CN")} ·{" "}
                {h.details.reason || "授权凭证登记"}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {!rows.length && <p>此页暂无授权记录。</p>}
      <div className="ops-inline">
        <button
          type="button"
          disabled={busy || !offset}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页授权
        </button>
        <button
          type="button"
          disabled={busy || rows.length < 20}
          onClick={() => setOffset(offset + 20)}
        >
          下一页授权
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setRevision((x) => x + 1)}
        >
          刷新授权状态
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}

export function InvoiceResults({ api, detail, request, onRefresh }: any) {
  const { busy, notice, setNotice, act, stableKey, resetKey } = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [reason, setReason] = useState(""),
    [show, setShow] = useState(false);
  const [ids, setIds] = useState<string[]>([]),
    [authorization, setAuthorization] = useState<any>(null),
    [payload, setPayload] = useState<any>({
      outcome: "issued",
      channelLabel: "",
      externalRef: "",
      invoiceNumber: "",
      invoiceCode: "",
      invoiceDate: "",
      sellerTaxId: request.payload.sellerTaxId,
      buyerName: request.payload.buyerName,
      buyerTaxId: request.payload.buyerTaxId,
      net: "",
      tax: "",
      gross: "",
      note: "",
    });
  useEffect(() => {
    let alive = true;
    void api(
      `/invoice-requests/${request.id}/result-records?limit=20&offset=${offset}`,
    )
      .then((x: any) => {
        if (alive) setRows(x);
      })
      .catch((e: any) => {
        if (alive) setNotice(e.message);
      });
    return () => {
      alive = false;
    };
  }, [
    request.id,
    offset,
    revision,
    request.results?.pending?.id,
    request.results?.latest?.id,
  ]);
  const done = async () => {
    setRevision((x) => x + 1);
    await onRefresh();
  };
  return (
    <section className="ops-handoff">
      <h4>实际开票结果回录</h4>
      <p>
        仅登记已有渠道结果和原始凭证，成功记录经独立核验后进入回录台账。未连接开票平台、未在线查验、不会自动入账。
      </p>
      {request.status === "ready" &&
        !request.results?.pending &&
        !request.recordedIssued && (
          <button
            type="button"
            disabled={busy || request.stale || detail.status !== "processing"}
            onClick={() => setShow(!show)}
          >
            {show ? "收起回录" : "回录实际结果"}
          </button>
        )}
      {show && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              if (!authorization || !ids.length)
                throw Error("请选择有效授权和实际回执附件");
              const body = {
                version: request.version,
                authorization,
                payload,
                evidenceFileIds: ids,
              };
              await api(`/invoice-requests/${request.id}/result-records`, {
                ...body,
                key: stableKey(body),
              });
              setShow(false);
              setNotice("回录草稿已保存，等待独立核验。");
              await done();
            });
          }}
        >
          <fieldset className="ops-form" disabled={busy}>
            <legend>依据实际渠道回执填写</legend>
            <label>
              实际结果
              <select
                value={payload.outcome}
                onChange={(e) =>
                  setPayload({
                    ...payload,
                    outcome: e.currentTarget.value,
                    ...(e.currentTarget.value !== "issued"
                      ? {
                          invoiceNumber: "",
                          invoiceCode: "",
                          invoiceDate: "",
                          net: "",
                          tax: "",
                          gross: "",
                        }
                      : {}),
                  })
                }
              >
                <option value="issued">成功（有实际发票及凭证）</option>
                <option value="failed">失败（有明确失败凭证）</option>
                <option value="unknown">
                  结果不明（先核实，不能重复开票）
                </option>
              </select>
            </label>
            {(
              [
                ["channelLabel", "实际办理渠道", 100],
                ["externalRef", "渠道流水或受理编号", 100],
                ["sellerTaxId", "实际销方税号", 30],
                ["buyerName", "实际购方名称", 200],
                ["buyerTaxId", "实际购方税号", 30],
                ["invoiceNumber", "实际发票号码", 100],
                ["invoiceCode", "实际发票代码（无则留空）", 30],
                ["invoiceDate", "实际开票日期", 10],
                ["net", "实际不含税金额", 15],
                ["tax", "实际税额", 15],
                ["gross", "实际价税合计", 15],
                ["note", "结果与核对说明", 2000],
              ] as const
            )
              .filter(
                ([k]) =>
                  payload.outcome === "issued" ||
                  ![
                    "invoiceNumber",
                    "invoiceCode",
                    "invoiceDate",
                    "net",
                    "tax",
                    "gross",
                  ].includes(k),
              )
              .map(([key, label, max]) => (
                <label key={key}>
                  {label}
                  <input
                    maxLength={max}
                    {...(key === "invoiceDate"
                      ? { type: "date" as const }
                      : { type: "text" as const })}
                    required={[
                      "channelLabel",
                      "sellerTaxId",
                      "buyerName",
                      "note",
                      "invoiceNumber",
                      "invoiceDate",
                      "net",
                      "tax",
                      "gross",
                    ].includes(key)}
                    value={payload[key]}
                    onInput={(e) =>
                      setPayload({ ...payload, [key]: e.currentTarget.value })
                    }
                  />
                </label>
              ))}
          </fieldset>
          <AuthorizationSelect
            api={api}
            companyId={detail.company_id}
            value={authorization}
            onChange={setAuthorization}
            disabled={busy}
            scope="record_results"
            refreshKey={revision}
          />
          <EvidencePicker
            api={api}
            detail={detail}
            ids={ids}
            onChange={setIds}
            purpose="receipt"
            disabled={busy}
            onRefresh={onRefresh}
          />
          <button disabled={busy}>{busy ? "保存中…" : "保存回录草稿"}</button>
        </form>
      )}
      <label>
        回执核验或驳回说明
        <input
          value={reason}
          maxLength={2000}
          disabled={busy}
          onInput={(e) => setReason(e.currentTarget.value)}
        />
      </label>
      {rows.map((row) => (
        <details key={row.id}>
          <summary>
            {labels[row.payload.outcome]} · {labels[row.status]} ·{" "}
            {row.payload.invoiceNumber || "无票号"}
          </summary>
          <p>
            {row.payload.channelLabel} · {row.payload.externalRef} ·{" "}
            {row.payload.invoiceDate}
          </p>
          <p>
            销方税号 {row.payload.sellerTaxId} · 购方 {row.payload.buyerName}（
            {row.payload.buyerTaxId || "无税号"}）
          </p>
          <p>
            金额 {row.payload.net || "—"} · 税额 {row.payload.tax || "—"} · 合计{" "}
            {row.payload.gross || "—"}
          </p>
          <p>{row.payload.note}</p>
          {row.review_reason && (
            <p role="status">核验意见：{row.review_reason}</p>
          )}
          <Attachments files={row.evidence} />
          {row.status === "rejected" &&
            request.status === "ready" &&
            !request.results?.pending &&
            !request.recordedIssued && (
              <button
                type="button"
                disabled={
                  busy || detail.status !== "processing" || request.stale
                }
                onClick={() => {
                  setPayload(structuredClone(row.payload));
                  resetKey();
                  setIds(row.evidence.map((f: any) => f.id));
                  setAuthorization({
                    id: row.authorization_id,
                    version: row.authorization_version,
                  });
                  setShow(true);
                  setNotice(
                    `已带回被驳回回录的资料与附件，请按核验意见修正并核实授权，另存新草稿；原回录保留。${row.review_reason || ""}`,
                  );
                }}
              >
                沿用资料修正回录
              </button>
            )}
          {row.canReview && (
            <div className="ops-inline">
              {["verify", "reject"].map((action) => (
                <button
                  key={action}
                  type="button"
                  disabled={busy || !reason.trim()}
                  onClick={() =>
                    void act(async () => {
                      await api(`/invoice-result-records/${row.id}/${action}`, {
                        version: row.version,
                        reason,
                      });
                      setNotice(
                        action === "verify"
                          ? "回执已人工核验；未做税务平台在线查验。"
                          : "回录已驳回，原记录保留，可另存修正草稿。",
                      );
                      await done();
                    })
                  }
                >
                  {action === "verify"
                    ? "确认已核验实际回执"
                    : "驳回并保留记录"}
                </button>
              ))}
            </div>
          )}
        </details>
      ))}
      {!rows.length && <p>此页暂无结果回录。</p>}
      <div className="ops-inline">
        <button
          type="button"
          disabled={busy || !offset}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页回录
        </button>
        <button
          type="button"
          disabled={busy || rows.length < 20}
          onClick={() => setOffset(offset + 20)}
        >
          下一页回录
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void act(async () => done())}
        >
          刷新回录状态
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function InvoiceBatches({
  api,
  write,
  onOpen,
  renderContinuation,
}: any) {
  const { busy, notice, setNotice, act } = useAction(),
    [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [selected, setSelected] = useState<any>(null);
  useEffect(() => {
    let alive = true;
    if (write)
      void api(`/invoice-batches?limit=20&offset=${offset}`)
        .then((x: any) => {
          if (alive) setRows(x);
        })
        .catch((e: any) => {
          if (alive) setNotice(e.message);
        });
    return () => {
      alive = false;
    };
  }, [offset, revision, write]);
  if (!write) return <p>批量申请由经办和复核人员管理。</p>;
  return (
    <section className="ops-handoff">
      <h2>代账批量开票申请</h2>
      <p>
        可让 WorkBuddy
        按指定客户和业务依据批量准备申请，在这里逐户查看缺项、核验和回录进度。每批最多
        50 项；失败项补齐后单独补办，成功项不重复创建。
      </p>
      <p>
        例如：“为已授权的甲、乙客户准备本月这批开票申请，列出缺项并返回批次编号。”
      </p>
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            setRevision((x) => x + 1);
            if (selected)
              setSelected(await api(`/invoice-batches/${selected.id}`));
          })
        }
      >
        刷新批次进度
      </button>
      {rows.map((row) => (
        <article key={row.id}>
          <h3>{row.title}</h3>
          <p>
            {new Date(row.created_at).toLocaleString("zh-CN")} · 当前可见{" "}
            {row.visible_items} 项 · 初始未保存 {row.blocked} 项（续办现状见逐户进度）
          </p>
          <button
            disabled={busy}
            onClick={() =>
              void act(async () =>
                setSelected(await api(`/invoice-batches/${row.id}`)),
              )
            }
          >
            查看逐户进度
          </button>
        </article>
      ))}
      {!rows.length && <p>此页暂无批量申请。</p>}
      <div className="ops-inline">
        <button
          disabled={busy || !offset}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页批次
        </button>
        <button
          disabled={busy || rows.length < 20}
          onClick={() => setOffset(offset + 20)}
        >
          下一页批次
        </button>
      </div>
      {selected && (
        <section className="ops-receipt">
          <h3>{selected.title}</h3>
          <p>
            已保存申请 {selected.prepared} 项 · 未能保存 {selected.blocked} 项 ·
            成功回录已核验 {selected.recordedIssued} 项
          </p>
          <p>{selected.note}</p>
          {renderContinuation
            ? renderContinuation(selected, async () =>
                setSelected(
                  await api(`/invoice-batches/${selected.id}/actions`),
                ),
              )
            : selected.items.map((item: any) => (
                <article key={item.id}>
                  <h4>
                    {item.company_name} · {item.payload.businessRef}
                  </h4>
                  <p>
                    {item.request
                      ? labels[item.request.stage] || item.request.stage
                      : labels[item.status]}
                  </p>
                  <p>{item.error || item.request?.nextAction}</p>
                  {item.request?.currentChecks.issues.map(
                    (x: any, i: number) => (
                      <p key={i} className="ops-error">
                        {x.message}
                      </p>
                    ),
                  )}
                  <button
                    disabled={busy}
                    onClick={() => void act(() => onOpen(item.order_id))}
                  >
                    进入工作单处理
                  </button>
                </article>
              ))}
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
