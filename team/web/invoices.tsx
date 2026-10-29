import {
  AccountingRulePanel,
  InvoiceAccounting,
} from "./invoice-accounting.js";
import {
  InvoiceAuthorizations,
  AuthorizationSelect,
  InvoiceResults,
} from "./invoice-agency.js";
import { useEffect, useRef, useState } from "preact/hooks";
import { FilePicker } from "./file-picker.js";

const stages: any = {
  draft: "草稿",
  awaiting_authorization: "待有效授权",
  result_pending_review: "回录待核验",
  result_rejected: "回录驳回待修正",
  recorded_issued: "成功回录已核验",
  result_unknown: "结果不明",
  result_failed: "失败回录已核验",
  needs_materials: "待补资料",
  awaiting_review: "待核验",
  ready: "申请已核验",
  withdrawn: "已撤回",
  stale: "依据已变化",
};
const blankLine = () => ({
  name: "",
  specification: "",
  unit: "",
  quantity: "",
  taxCode: "",
  taxRate: "",
  net: "",
  tax: "",
  gross: "",
  evidenceNote: "",
});
const blankPayload = () => ({
  sellerName: "",
  sellerTaxId: "",
  buyerName: "",
  buyerTaxId: "",
  buyerKind: "unknown",
  invoiceType: "unknown",
  businessDescription: "",
  remark: "",
  lines: [blankLine()],
});
const lineFields = [
  ["name", "项目名称", 200],
  ["specification", "规格型号", 100],
  ["unit", "单位", 30],
  ["quantity", "数量", 21],
  ["taxCode", "税收分类编码", 30],
  ["taxRate", "税率（如 0.13）", 8],
  ["net", "不含税金额", 15],
  ["tax", "税额", 15],
  ["gross", "价税合计", 15],
  ["evidenceNote", "业务依据说明", 500],
] as const;

export function InvoiceRequests({
  detail,
  api,
  onRefresh,
  write,
  continuation,
}: any) {
  const [rows, setRows] = useState<any[]>([]),
    [offset, setOffset] = useState(0),
    [selected, setSelected] = useState<any>(null),
    [editing, setEditing] = useState(false),
    [payload, setPayload] = useState<any>(blankPayload),
    [businessRef, setBusinessRef] = useState(""),
    [fileIds, setFileIds] = useState<string[]>([]),
    [reason, setReason] = useState(""),
    [authorization, setAuthorization] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [refresh, setRefresh] = useState(0),
    [history, setHistory] = useState<any[] | null>(null);
  const request = useRef({ signature: "", key: "" }),
    alive = useRef(true),
    selection = useRef(0);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    let current = true;
    setRows([]);
    if (write && !continuation)
      void api(
        `/orders/${detail.id}/invoice-requests?limit=20&offset=${offset}`,
      )
        .then((x: any) => {
          if (current) setRows(x);
        })
        .catch((e: any) => {
          if (current) setNotice(e.message);
        });
    return () => {
      current = false;
    };
  }, [detail.id, detail.version, offset, refresh, write]);
  const act = async (fn: any) => {
    setBusy(true);
    setNotice("");
    try {
      await fn();
    } catch (e: any) {
      if (alive.current) setNotice(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const open = async (id: string) => {
    const token = ++selection.current;
    const data = await api(`/invoice-requests/${id}`);
    if (alive.current && token === selection.current) {
      setSelected(data);
      setEditing(false);
      setHistory(null);
      setReason("");
    }
  };
  const edit = (row: any) => {
    ++selection.current;
    setSelected(row);
    setPayload(row ? structuredClone(row.payload) : blankPayload());
    setBusinessRef(row?.business_ref || "");
    setAuthorization(
      row?.authorization_id
        ? { id: row.authorization_id, version: row.authorization_version }
        : null,
    );
    setFileIds(row?.source_files.map((f: any) => f.id) || []);
    setReason("");
    setEditing(true);
    setHistory(null);
    setNotice("");
  };
  useEffect(() => {
    if (!continuation) return;
    const item = continuation.item;
    edit(item.request || null);
    if (!item.request) {
      setPayload(structuredClone(item.payload.payload));
      setBusinessRef(item.payload.businessRef);
      setFileIds(item.payload.sourceFileIds);
      setAuthorization(item.payload.authorization);
    }
    if (continuation.initialChanges) {
      const changes = structuredClone(continuation.initialChanges);
      setPayload(changes.payload);
      setFileIds(changes.sourceFileIds);
      setAuthorization(changes.authorization);
    }
    setReason(continuation.initialReason || "");
  }, [continuation?.item.id]);
  const field = (key: string, label: string, max: number) => (
    <label>
      {label}
      <input
        value={payload[key]}
        maxLength={max}
        disabled={busy}
        onInput={(e) =>
          setPayload({ ...payload, [key]: e.currentTarget.value })
        }
      />
    </label>
  );
  const saved = async (data: any) => {
    if (alive.current) {
      setSelected(data);
      setEditing(false);
      setRefresh((x) => x + 1);
      setNotice("申请已保存；未提交外部开票渠道。");
    }
    await onRefresh();
  };
  if (!write) return <p>开票申请由经办与复核人员管理。</p>;
  return (
    <section className="ops-handoff">
      {!continuation && (
        <>
          <InvoiceAuthorizations
            api={api}
            detail={detail}
            onRefresh={onRefresh}
          />
          <AccountingRulePanel api={api} detail={detail} />
          <h3>开票申请与进度</h3>
          <p>
            记录业务依据、补齐缺项、独立核验和追踪修改。本阶段不连接开票厂商，不开具发票。
          </p>
          <div className="ops-inline">
            <button
              type="button"
              disabled={busy || detail.status !== "processing"}
              onClick={() => edit(null)}
            >
              新建开票申请
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setRefresh((x) => x + 1);
                  if (selected) await open(selected.id);
                })
              }
            >
              刷新进度
            </button>
          </div>
          {notice && (
            <p role="status" className="ops-notice">
              {notice}
            </p>
          )}
          {!rows.length && <p className="muted">此页暂无申请。</p>}
          {rows.map((row) => (
            <article className="ops-run" key={row.id}>
              <strong>
                {row.business_ref} · {row.buyer_name || "购方待补"}
              </strong>
              <p>
                {row.status === "withdrawn"
                  ? stages.withdrawn
                  : row.stale
                    ? stages.stale
                    : row.issue_count
                      ? stages.needs_materials
                      : stages[row.status]}{" "}
                · 价税合计 {row.totals?.gross ?? "待补"} ·{" "}
                {new Date(row.created_at).toLocaleString("zh-CN")}
              </p>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void act(() => open(row.id))}
              >
                查看申请及进度
              </button>
            </article>
          ))}
          <div className="ops-inline">
            <button
              type="button"
              disabled={busy || offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一页申请
            </button>
            <span>第 {offset / 20 + 1} 页</span>
            <button
              type="button"
              disabled={busy || rows.length < 20}
              onClick={() => setOffset(offset + 20)}
            >
              下一页申请
            </button>
          </div>
        </>
      )}
      {continuation && notice && <p role="status">{notice}</p>}
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              if (!fileIds.length || fileIds.length > 50)
                throw Error("请选择 1 至 50 份当前业务依据");
              if (continuation) {
                if (!authorization || !reason.trim())
                  throw Error("请选择有效授权并填写续办说明");
                await continuation.onPrepare(
                  { sourceFileIds: fileIds, payload, authorization },
                  reason,
                );
                return;
              }
              const body: any = {
                version: selected ? selected.version : detail.version,
                sourceFileIds: fileIds,
                payload,
                ...(authorization ? { authorization } : {}),
                ...(selected ? { reason } : { businessRef }),
              };
              const signature = JSON.stringify([
                selected?.id || detail.id,
                body,
              ]);
              if (request.current.signature !== signature)
                request.current = { signature, key: crypto.randomUUID() };
              await saved(
                await api(
                  selected
                    ? `/invoice-requests/${selected.id}/revise`
                    : `/orders/${detail.id}/invoice-requests`,
                  { ...body, key: request.current.key },
                ),
              );
            });
          }}
        >
          <h4>
            {continuation
              ? "补齐本项续办内容（尚未提交）"
              : selected
                ? "修订申请（原核验将失效）"
                : "新建申请草稿"}
          </h4>
          <AuthorizationSelect
            api={api}
            companyId={detail.company_id}
            value={authorization}
            onChange={setAuthorization}
            disabled={busy}
            scope="prepare_applications"
            refreshKey={refresh}
          />
          <p>
            未知信息留空；税率和编码按业务依据填写，不根据名称猜测。保存后展示缺项和金额差异。
          </p>
          <fieldset disabled={busy} className="ops-form">
            <legend>购销双方与业务</legend>
            <label>
              业务唯一编号（分批开票加分批编号）
              <input
                required
                maxLength={100}
                value={businessRef}
                disabled={!!selected || !!continuation}
                onInput={(e) => setBusinessRef(e.currentTarget.value)}
              />
            </label>
            {field("sellerName", "销方名称", 200)}
            {field("sellerTaxId", "销方税号", 30)}
            {field("buyerName", "购方名称", 200)}
            {field("buyerTaxId", "购方税号", 30)}
            <label>
              购方类型
              <select
                value={payload.buyerKind}
                onChange={(e) =>
                  setPayload({ ...payload, buyerKind: e.currentTarget.value })
                }
              >
                <option value="unknown">待确认</option>
                <option value="enterprise">企业</option>
                <option value="individual">个人</option>
              </select>
            </label>
            <label>
              发票类型
              <select
                value={payload.invoiceType}
                onChange={(e) =>
                  setPayload({ ...payload, invoiceType: e.currentTarget.value })
                }
              >
                <option value="unknown">待确认</option>
                <option value="ordinary">普通发票</option>
                <option value="special">专用发票</option>
              </select>
            </label>
            {field("businessDescription", "真实业务说明", 2000)}
            {field("remark", "备注", 1000)}
          </fieldset>
          {payload.lines.map((line: any, index: number) => (
            <fieldset disabled={busy} className="ops-form" key={index}>
              <legend>明细 {index + 1}</legend>
              {lineFields.map(([key, label, max]) => (
                <label key={key}>
                  {label}
                  <input
                    value={line[key]}
                    maxLength={max}
                    inputMode={
                      ["quantity", "taxRate", "net", "tax", "gross"].includes(
                        key,
                      )
                        ? "decimal"
                        : "text"
                    }
                    pattern={
                      key === "taxRate"
                        ? "(0(\\.[0-9]{1,6})?|1(\\.0{1,6})?)?"
                        : ["net", "tax", "gross"].includes(key)
                          ? "([0-9]{1,12}(\\.[0-9]{1,2})?)?"
                          : key === "quantity"
                            ? "([0-9]{1,12}(\\.[0-9]{1,8})?)?"
                            : undefined
                    }
                    onInput={(e) =>
                      setPayload({
                        ...payload,
                        lines: payload.lines.map((x: any, n: number) =>
                          n === index
                            ? { ...x, [key]: e.currentTarget.value }
                            : x,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <button
                type="button"
                disabled={payload.lines.length <= 1}
                onClick={() =>
                  setPayload({
                    ...payload,
                    lines: payload.lines.filter(
                      (_: any, n: number) => n !== index,
                    ),
                  })
                }
              >
                移除此行
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            disabled={busy || payload.lines.length >= 200}
            onClick={() =>
              setPayload({ ...payload, lines: [...payload.lines, blankLine()] })
            }
          >
            添加明细
          </button>
          <FilePicker
            api={api}
            scope={{
              companyId: detail.company_id,
              period: detail.period,
              orderId: detail.id,
            }}
            purpose="source"
            latestOnly
            selectedIds={fileIds}
            onChange={setFileIds}
            maxSelection={50}
            disabled={busy}
            refreshKey={detail.version}
            title="开票业务依据"
          />
          {(selected || continuation) && (
            <label>
              修订原因
              <input
                required
                maxLength={2000}
                value={reason}
                disabled={busy}
                onInput={(e) => setReason(e.currentTarget.value)}
              />
            </label>
          )}
          <div className="ops-inline">
            <button disabled={busy}>
              {busy
                ? "保存中…"
                : continuation
                  ? "保存本项续办内容，返回批次"
                  : "保存申请并检查缺项"}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={() =>
                continuation ? continuation.onCancel() : setEditing(false)
              }
            >
              取消编辑
            </button>
          </div>
        </form>
      ) : (
        selected && (
          <section className="ops-receipt">
            <h4>
              {selected.business_ref} · {stages[selected.stage]}
            </h4>
            <p>{selected.nextAction}</p>
            <p>
              申请版本 {selected.version} ·{" "}
              {selected.recordedIssued
                ? "成功回执已回录并人工核验，未经平台在线查验"
                : "本工作台未开具发票"}
            </p>
            <p>
              销方：{selected.payload.sellerName || "待补"}（
              {selected.payload.sellerTaxId || "税号待补"}）
            </p>
            <p>
              购方：{selected.payload.buyerName || "待补"}（
              {selected.payload.buyerTaxId || "税号待补"}）
            </p>
            <p>{selected.payload.businessDescription}</p>
            <p>
              金额 {selected.currentChecks.totals?.net ?? "待补"} · 税额{" "}
              {selected.currentChecks.totals?.tax ?? "待补"} · 价税合计{" "}
              {selected.currentChecks.totals?.gross ?? "待补"}
            </p>
            <ol>
              {selected.currentChecks.issues.map((x: any) => (
                <li className="ops-error">{x.message}</li>
              ))}
            </ol>
            <details>
              <summary>申请完整明细与依据</summary>
              {selected.payload.lines.map((line: any, i: number) => (
                <dl>
                  <dt>明细 {i + 1}</dt>
                  {lineFields.map(([key, label]) => (
                    <div>
                      <dt>{label}</dt>
                      <dd>{line[key] || "待补"}</dd>
                    </div>
                  ))}
                </dl>
              ))}
              {selected.source_files.map((f: any) => (
                <p>
                  <a href={`/api/v1/files/${f.id}/download`}>
                    {f.name} · v{f.version}
                  </a>
                </p>
              ))}
            </details>
            <div className="ops-inline">
              {selected.canEdit && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => edit(selected)}
                >
                  修订申请
                </button>
              )}
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const x = await api(
                      `/invoice-requests/${selected.id}/revisions?limit=10&offset=${history?.length || 0}`,
                    );
                    if (alive.current) {
                      setHistory((h) => [...(h || []), ...x]);
                      if (x.length < 10) setNotice("历史版本已全部读取");
                    }
                  })
                }
              >
                读取更多历史版本
              </button>
            </div>
            {history?.map((h) => (
              <details key={h.version}>
                <summary>
                  修改前版本 {h.version} · {h.reason}
                </summary>
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {JSON.stringify(h.snapshot.payload, null, 2)}
                </pre>
              </details>
            ))}
            {(selected.canConfirm || selected.canWithdraw) && (
              <form onSubmit={(e) => e.preventDefault()}>
                <label>
                  核验或撤回原因
                  <input
                    value={reason}
                    maxLength={2000}
                    disabled={busy}
                    onInput={(e) => setReason(e.currentTarget.value)}
                  />
                </label>
                <div className="ops-inline">
                  {selected.canConfirm && (
                    <button
                      type="button"
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        void act(async () =>
                          saved(
                            await api(
                              `/invoice-requests/${selected.id}/confirm`,
                              { version: selected.version, reason },
                            ),
                          ),
                        )
                      }
                    >
                      确认已独立核验（不开票）
                    </button>
                  )}
                  {selected.canWithdraw && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || !reason.trim()}
                      onClick={() =>
                        void act(async () => {
                          await api(
                            `/invoice-requests/${selected.id}/withdraw`,
                            { version: selected.version, reason },
                          );
                          await open(selected.id);
                          setRefresh((x) => x + 1);
                          await onRefresh();
                        })
                      }
                    >
                      撤回申请
                    </button>
                  )}
                </div>
              </form>
            )}
            <InvoiceResults
              key={selected.id + "/" + selected.version}
              api={api}
              detail={detail}
              request={selected}
              onRefresh={async () => {
                await open(selected.id);
                await onRefresh();
              }}
            />
            <InvoiceAccounting
              key={selected.id + "/accounting"}
              api={api}
              detail={detail}
              request={selected}
              onRefresh={async () => {
                await open(selected.id);
                await onRefresh();
              }}
            />
            <h4>进度记录（最近 100 条）</h4>
            <ol>
              {selected.history.map((event: any) => (
                <li>
                  {new Date(event.created_at).toLocaleString("zh-CN")} ·{" "}
                  {(
                    {
                      invoice_request_prepared: "申请已保存",
                      invoice_request_revised: "申请已修订，重新待核验",
                      invoice_request_confirmed: "申请已人工核验",
                      invoice_request_withdrawn: "申请已撤回",
                      invoice_request_result_prepared: "实际结果已回录，待核验",
                      invoice_request_result_verify: "回录结果已人工核验",
                      invoice_request_result_reject: "回录结果已驳回",
                    } as any
                  )[event.action] || event.action}{" "}
                  ·{" "}
                  {event.details.reason ||
                    `缺项 ${event.details.issueCount ?? 0} 项`}
                </li>
              ))}
            </ol>
          </section>
        )
      )}
    </section>
  );
}
