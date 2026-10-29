import { useState } from "preact/hooks";
import { InvoiceRequests } from "./invoices.js";
import {
  AccountingFields,
  AccountingDraftView,
  blankAccounting,
  useInvoiceAction,
} from "./invoice-accounting.js";

const groups: any = {
  application_materials: "申请待补资料",
  retry_available: "失败项可补办",
  application_review: "申请待核验",
  awaiting_receipt: "待实际回执",
  receipt_review: "回录待核验",
  receipt_correction: "回录驳回待修正",
  receipt_unknown: "结果不明待核实",
  receipt_failed: "实际开票失败待处理",
  accounting_materials: "账务待补件",
  draft_review: "草稿待复核",
  handoff_ready: "交接成果已形成",
  withdrawn: "申请已撤回",
};
const actions: any = {
  repair: "补齐原申请",
  retry: "补办未保存项",
  ledger: "登记回录台账",
  accounting: "登记台账并准备记账草稿",
};
function BatchDraft({ api, summary, onRefresh }: any) {
  const { busy, notice, act } = useInvoiceAction(),
    [draft, setDraft] = useState<any>(null);
  const load = async () =>
    setDraft(await api(`/invoice-accounting-drafts/${summary.id}`));
  return (
    <section>
      <p>
        {summary.number} · {summary.currentIssues.length} 项待核实
      </p>
      <button type="button" disabled={busy} onClick={() => void act(load)}>
        读取完整草稿及复核
      </button>
      {draft && (
        <AccountingDraftView
          api={api}
          draft={draft}
          onChanged={async () => {
            await load();
            await onRefresh();
          }}
        />
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
export function InvoiceBatchContinuation({
  api,
  batch,
  onRefresh,
  onOpen,
}: any) {
  const { busy, notice, setNotice, act, keyFor } = useInvoiceAction(),
    [filter, setFilter] = useState("all"),
    [selections, setSelections] = useState<Record<string, any>>({}),
    [reason, setReason] = useState(""),
    [editing, setEditing] = useState<any>(null),
    [pendingSubmission, setPendingSubmission] = useState<any>(null),
    [receipt, setReceipt] = useState<any>(null);
  const choose = (item: any, selected: boolean) => {
    setSelections((old) => {
      const next = { ...old };
      if (selected) {
        const resume = item.resume?.canPrefill ? item.resume : null;
        const action =
          resume?.action ||
          (item.allowedActions.includes("accounting")
            ? "accounting"
            : item.allowedActions[0]);
        next[item.id] = {
          action,
          expected: structuredClone(item.expected),
          changes: resume?.changes
            ? structuredClone(resume.changes)
            : undefined,
          reason: resume?.reason || "",
          context: resume?.context
            ? structuredClone(resume.context)
            : item.accountingDraft
              ? structuredClone(item.accountingDraft.context)
              : blankAccounting(),
        };
      } else delete next[item.id];
      return next;
    });
  };
  const change = (id: string, patch: any) =>
    setSelections((old) => ({ ...old, [id]: { ...old[id], ...patch } }));
  const edit = async (item: any) => {
    const detail = await api(`/orders/${item.order_id}?compact=1`);
    setEditing({ item, detail, selection: selections[item.id] });
  };
  const refreshVersions = async () => {
    const fresh = await api(`/invoice-batches/${batch.id}/actions`);
    const updated: Record<string, any> = {};
    const conflicts: string[] = [];
    for (const [id, s] of Object.entries(selections)) {
      const item = fresh.items.find((x: any) => x.id === id);
      if (
        !item ||
        !item.allowedActions.includes(s.action) ||
        item.expected.requestVersion !== s.expected.requestVersion ||
        item.expected.draftVersion !== s.expected.draftVersion
      ) {
        updated[id] = s;
        conflicts.push(item?.company_name || "不可访问的项目");
      } else updated[id] = { ...s, expected: structuredClone(item.expected) };
    }
    setSelections(updated);
    setNotice(
      conflicts.length
        ? `填写内容已保留；${conflicts.join("、")} 的申请、草稿或权限已变化，请对照当前记录核实，未替换这些项目的预期版本。`
        : "填写内容已保留，已读取补件后的工作单和尝试版本；请核实附件与授权后再次提交。",
    );
    try {
      await onRefresh();
    } catch {
      /* Keep the confirmed versions and the user's input. */
    }
  };
  const sendSubmission = async (body: any) => {
    setPendingSubmission(body);
    let result;
    try {
      result = await api(`/invoice-batches/${batch.id}/continue`, body);
    } catch (e: any) {
      if (e.status >= 400 && e.status < 500 && !e.outcomeUnknown)
        setPendingSubmission(null);
      throw e;
    }
    if (!result?.id || !Array.isArray(result.items))
      throw Error(
        "续办回执不完整，仍保留原请求；请原样重试，不能据此认定保存成功。",
      );
    setPendingSubmission(null);
    setReceipt(result);
    const failed = new Set(
      result.items
        .filter((x: any) => x.status === "blocked")
        .map((x: any) => x.item_id),
    );
    const completed = new Set(
      result.items
        .filter((x: any) => x.status === "completed")
        .map((x: any) => x.item_id),
    );
    setSelections((old) =>
      // An invisible result after scope revocation is not a successful result.
      Object.fromEntries(
        Object.entries(old).filter(([id]) => !completed.has(id)),
      ),
    );
    setEditing(null);
    setNotice(
      result.scopeComplete === false
        ? "权限发生变化，回执仅包含部分项目。未确认项目的填写内容已保留；请核实权限和原回执，不能据此认定整批完成。"
        : failed.size
          ? "失败项的填写内容已保留。修正缺项后点击“补件后更新版本，保留填写”，再继续提交。"
          : "续办回执已保存，请逐项查看结果及待人工事项。",
    );
    try {
      await onRefresh();
    } catch {
      setNotice(
        "续办回执已保存，但当前进度刷新失败；失败项填写内容仍保留。请刷新批次进度，不要重复提交成功项。",
      );
    }
  };
  const submit = async () => {
    if (pendingSubmission)
      throw Error("上次提交结果未明，请先原样重试获取回执。");
    if (editing) throw Error("请先暂存正在编辑的补件内容，再提交续办。");
    if (
      !reason.trim() &&
      Object.values(selections).some((s: any) => !s.reason?.trim())
    )
      throw Error("请填写本次续办说明");
    const items = Object.entries(selections).map(([id, s]) => {
      const item = batch.items.find((x: any) => x.id === id);
      if (!item) throw Error("所选项目已不可访问，请刷新");
      const base = {
        itemId: id,
        action: s.action,
        expectedAttemptId: s.expected.attemptId,
        orderVersion: s.expected.orderVersion,
        reason: s.reason || reason,
      };
      if (s.action === "repair" && !s.changes)
        throw Error(`请先补齐 ${item.company_name} 的续办内容`);
      if (s.action === "repair" || s.action === "retry")
        return {
          ...base,
          ...(s.action === "repair"
            ? { requestVersion: s.expected.requestVersion }
            : {}),
          changes: s.changes || {
            payload: item.payload.payload,
            sourceFileIds: item.payload.sourceFileIds,
            authorization: item.payload.authorization,
          },
        };
      if (s.action === "accounting") {
        if (
          !s.context.note.trim() ||
          s.context.evidence.some(
            (e: any) => !e.requirement.trim() || !e.note.trim(),
          )
        )
          throw Error(`请补齐 ${item.company_name} 的处理说明及依据说明`);
        return {
          ...base,
          requestVersion: s.expected.requestVersion,
          draftVersion: s.expected.draftVersion,
          context: s.context,
        };
      }
      return { ...base, requestVersion: s.expected.requestVersion };
    });
    if (!items.length) throw Error("请明确选择需要处理的项目");
    const body = { items };
    await sendSubmission(
      structuredClone({
        ...body,
        key: keyFor(body),
      }),
    );
  };
  return (
    <section>
      <h4>批次续办</h4>
      <p>
        明确选择项目后处理。未选项目保持原状；保存草稿、形成交接成果均不代表已入账。
      </p>
      <label>
        按待办分组
        <select
          value={filter}
          disabled={busy}
          onChange={(e) => setFilter(e.currentTarget.value)}
        >
          <option value="all">全部可见项目（{batch.visibleItems}）</option>
          {Object.entries(batch.groups || {}).map(([g, count]) => (
            <option key={g} value={g}>
              {groups[g]}（{String(count)}）
            </option>
          ))}
        </select>
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void act(submit);
        }}
      >
        <fieldset disabled={busy || !!pendingSubmission}>
          <legend>所选项目续办资料</legend>
          <label>
            本次续办说明
            <textarea
              maxLength={2000}
              value={reason}
              disabled={busy}
              onInput={(e) => setReason(e.currentTarget.value)}
            />
          </label>
          {batch.items
            .filter((i: any) => filter === "all" || i.group === filter)
            .map((item: any) => {
              const selected = selections[item.id];
              return (
                <article className="ops-run" key={item.id}>
                  <h4>
                    {item.company_name} · {item.payload.businessRef}
                  </h4>
                  <p>{groups[item.group]}</p>
                  {item.accountingDraft?.status === "verified" &&
                    item.accountingDraft.stale && (
                      <p className="ops-error">
                        历史交接成果已核验，但当前依据已变化，未按新依据重新核验。
                      </p>
                    )}
                  {item.availabilityIssue && (
                    <p className="ops-error">{item.availabilityIssue}</p>
                  )}
                  <p>
                    原始结果：
                    {item.originalStatus === "prepared"
                      ? "申请已保存"
                      : "未保存"}
                    {item.error ? ` · ${item.error}` : ""}
                  </p>
                  <p>{item.nextStep?.message || item.request?.nextAction}</p>
                  {item.resume && <p>{item.resume.message}</p>}
                  {item.nextStep?.requiresHumanReview && (
                    <p>
                      待独立核验：
                      {item.group === "draft_review"
                        ? "记账草稿"
                        : item.group === "receipt_review"
                          ? "实际开票回录"
                          : "开票申请"}
                      。进入工作单交由独立人员处理，完成后刷新本批次。
                    </p>
                  )}
                  {item.latestAttempt && (
                    <p>
                      最近尝试：
                      {item.latestAttempt.status === "blocked"
                        ? item.latestAttempt.error
                        : item.latestAttempt.payload.outcome.message}
                    </p>
                  )}
                  {item.feedback?.map((x: any, i: number) => (
                    <p className="ops-error" key={i}>
                      {x.message}
                    </p>
                  ))}
                  {(!!item.allowedActions.length || selected) && (
                    <label>
                      <input
                        type="checkbox"
                        checked={!!selected}
                        disabled={busy}
                        onChange={(e) => choose(item, e.currentTarget.checked)}
                      />
                      选择此项续办
                    </label>
                  )}
                  {selected && (
                    <label>
                      本项操作
                      <select
                        disabled={busy}
                        value={selected.action}
                        onChange={(e) =>
                          change(item.id, { action: e.currentTarget.value })
                        }
                      >
                        {!item.allowedActions.includes(selected.action) && (
                          <option value={selected.action}>
                            {actions[selected.action]}（当前不可执行，请核实）
                          </option>
                        )}
                        {item.allowedActions.map((a: string) => (
                          <option key={a} value={a}>
                            {actions[a]}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {selected &&
                    ["repair", "retry"].includes(selected.action) && (
                      <div>
                        <p>
                          {selected.changes
                            ? "本项补充内容已暂存，提交所选项目后生效。"
                            : "可先补齐本项内容；直接补办将使用原失败项的业务资料。"}
                        </p>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void act(() => edit(item))}
                        >
                          补齐本项内容
                        </button>
                      </div>
                    )}
                  {selected?.action === "accounting" && (
                    <AccountingFields
                      api={api}
                      detail={{
                        id: item.order_id,
                        company_id: item.company_id,
                        period:
                          item.request?.period ||
                          item.accountingDraft?.period ||
                          item.orderPeriod,
                      }}
                      value={selected.context}
                      onChange={(context: any) => change(item.id, { context })}
                      disabled={busy}
                    />
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void act(() => onOpen(item.order_id))}
                  >
                    进入工作单处理及核验
                  </button>
                  <details>
                    <summary>续办历史（最近 30 次）</summary>
                    {item.attempts.map((a: any) => (
                      <p key={a.id}>
                        {new Date(a.created_at).toLocaleString("zh-CN")} ·{" "}
                        {actions[a.action]} ·{" "}
                        {a.error || a.payload.outcome.message}
                      </p>
                    ))}
                    {item.attemptsTruncated && (
                      <p>更早记录仍保留，可按续办回执编号查询。</p>
                    )}
                  </details>
                </article>
              );
            })}
          <p>
            已明确选择 {Object.keys(selections).length}{" "}
            项；筛选不会自动取消已选项目。
          </p>
          <button disabled={busy || !Object.keys(selections).length}>
            {busy ? "处理中…" : "提交所选项目续办"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setSelections({})}
          >
            清空选择
          </button>
          <button
            type="button"
            disabled={busy || !Object.keys(selections).length || !!editing}
            onClick={() => void act(refreshVersions)}
          >
            补件后更新版本，保留填写
          </button>
        </fieldset>
      </form>
      {pendingSubmission && (
        <section role="status">
          <p>
            上次提交尚未取得明确回执，原请求与填写内容已保留。请先原样重试，确认结果后再修改。
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => sendSubmission(pendingSubmission))}
          >
            原样重试上次提交
          </button>
        </section>
      )}
      {editing && (
        <InvoiceRequests
          key={editing.item.id}
          api={api}
          detail={editing.detail}
          write
          onRefresh={onRefresh}
          continuation={{
            item: editing.item,
            initialChanges: editing.selection?.changes,
            initialReason: editing.selection?.reason || reason,
            onCancel: () => setEditing(null),
            onPrepare: async (changes: any, itemReason: string) => {
              setSelections((old) => ({
                ...old,
                [editing.item.id]: {
                  ...old[editing.item.id],
                  action: editing.item.request ? "repair" : "retry",
                  expected: structuredClone(
                    editing.selection?.expected || editing.item.expected,
                  ),
                  changes,
                  reason: itemReason,
                },
              }));
              setEditing(null);
              setNotice("本项内容已暂存；请提交所选项目续办。");
            },
          }}
        />
      )}
      {batch.items
        .filter((i: any) => i.accountingDraft)
        .map((item: any) => (
          <details key={item.id}>
            <summary>{item.company_name} · 记账草稿及复核</summary>
            <BatchDraft
              key={
                item.accountingDraft.id +
                "/" +
                item.accountingDraft.status +
                "/" +
                item.accountingDraft.stale
              }
              api={api}
              summary={item.accountingDraft}
              onRefresh={onRefresh}
            />
          </details>
        ))}
      {receipt && (
        <section className="ops-receipt">
          <h4>本次续办回执</h4>
          <p>回执编号：{receipt.id}</p>
          <p role={receipt.scopeComplete === false ? "alert" : "status"}>
            当前可见 {receipt.visibleItems} / {receipt.totalItems} 项。
            {receipt.note}
          </p>
          {receipt.items.map((r: any) => (
            <p key={r.id}>
              {batch.items.find((i: any) => i.id === r.item_id)?.company_name} ·{" "}
              {r.error || r.payload.outcome.message}
              {r.payload.outcome.issues
                ?.map((x: any) => `；${x.message}`)
                .join("")}
            </p>
          ))}
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
