import { useEffect, useRef, useState } from "preact/hooks";
import { FilePicker, FileSnapshotList } from "./file-picker.js";
const roles: any = {
  owner: "负责人",
  reviewer: "主管 / 复核",
  operator: "经办",
  viewer: "只读",
};
const stages: any = {
  collecting: "待收集",
  checking: "整理核对",
  processing: "经办处理中",
  review: "待复核",
  delivery: "待交付",
};
const when = (v: any) => (v ? new Date(v).toLocaleString("zh-CN") : "—");
function Notice({ text }: any) {
  return text ? (
    <div className="ops-notice" role="status">
      {text}
    </div>
  ) : null;
}
function useAction() {
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  return {
    busy,
    message,
    act: async (fn: any, success = "已保存") => {
      setBusy(true);
      setMessage("");
      try {
        await fn();
        setMessage(success);
      } catch (e: any) {
        setMessage(e.message);
      } finally {
        setBusy(false);
      }
    },
  };
}

export function BatchUpload({
  detail,
  api,
  onRefresh,
  defaultKind = "source",
  run,
}: any) {
  const [queue, setQueue] = useState<any[]>([]),
    [kind, setKind] = useState(run ? "result" : defaultKind),
    [busy, setBusy] = useState(false),
    [note, setNote] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    if (!queue.length) setKind(run ? "result" : defaultKind);
  }, [defaultKind]);
  const patch = (key: string, data: any) =>
    setQueue((q) => q.map((x) => (x.key === key ? { ...x, ...data } : x)));
  async function upload() {
    setBusy(true);
    setNote("");
    let version = run ? run.version : detail.version;
    for (const item of queue.filter((q) => q.status !== "success")) {
      if (!alive.current) break;
      patch(item.key, { status: "uploading", error: "" });
      try {
        const data = new FormData();
        data.set("file", item.file);
        const result = await api(
          run
            ? `/runs/${run.id}/files?version=${version}&key=${item.key}&category=任务成果`
            : `/orders/${detail.id}/files?kind=${item.kind}${item.kind === "result" ? "&origin=manual" : ""}&category=${encodeURIComponent(item.index === "" ? "其他" : detail.checklist[Number(item.index)].name)}&version=${version}&key=${item.key}${item.index === "" ? "" : `&materialIndex=${item.index}`}`,
          data,
        );
        version = run ? result.runVersion : result.orderVersion;
        patch(item.key, { status: "success", id: result.id });
      } catch (e: any) {
        patch(item.key, { status: "failed", error: e.message });
        // A conflict or lost response requires an explicit refreshed snapshot before retry.
        if (e.status === 409 || !e.status) {
          setNote("上传已暂停。已成功文件保留；刷新工作单后可重试剩余项。");
          break;
        }
      }
    }
    try {
      if (alive.current) await onRefresh();
    } catch {
      setNote(
        "文件请求已结束，但刷新失败。网络恢复后请刷新工作单，再重试未确认项。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ops-upload">
      <div className="ops-title">
        <div>
          <h3>{run ? "上传此任务的成果" : "批量上传"}</h3>
          <p>每批最多 30 个、合计 200 MB；单个 50 MB。同名保留版本。</p>
        </div>
        <span>
          {queue.filter((x) => x.status === "success").length} / {queue.length}{" "}
          已保存
        </span>
      </div>
      <div className="ops-inline">
        <label>
          文件用途
          <select
            value={kind}
            disabled={busy || !!run}
            onChange={(e) => setKind(e.currentTarget.value)}
          >
            <option value="source">原始资料</option>
            <option value="result">
              {run ? "当前任务成果" : "人工处理成果"}
            </option>
            <option value="evidence">交付证据</option>
          </select>
        </label>
        <label className="ops-picker">
          选择多个文件
          <input
            type="file"
            multiple
            disabled={busy}
            accept=".csv,.xlsx,.pdf,.png,.jpg,.jpeg,.txt,.docx"
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files || []);
              e.currentTarget.value = "";
              if (
                queue.length + files.length > 30 ||
                queue.reduce((n, x) => n + x.file.size, 0) +
                  files.reduce((n, x) => n + x.size, 0) >
                  200 * 1024 * 1024
              ) {
                setNote("请分批上传：最多 30 个、合计 200 MB。");
                return;
              }
              setQueue((q) => [
                ...q,
                ...files.map((file) => ({
                  key: crypto.randomUUID(),
                  file,
                  kind,
                  index: "",
                  status: "waiting",
                })),
              ]);
              setNote("");
            }}
          />
        </label>
      </div>
      {queue.map((item) => (
        <div className="ops-upload-row" key={item.key}>
          <div>
            <strong>{item.file.name}</strong>
            <small>
              {(item.file.size / 1024).toFixed(1)} KB ·{" "}
              {
                (
                  {
                    source: "原始资料",
                    result: "处理成果",
                    evidence: "交付证据",
                  } as any
                )[item.kind]
              }
            </small>
            {item.error && <small className="ops-error">{item.error}</small>}
          </div>
          {item.kind === "source" && detail.status === "collecting" && (
            <label>
              关联资料项
              <select
                disabled={
                  busy || item.status === "success" || item.status === "failed"
                }
                value={item.index}
                onChange={(e) =>
                  patch(item.key, { index: e.currentTarget.value })
                }
              >
                <option value="">仅保存文件</option>
                {detail.checklist.map((m: any, i: number) => (
                  <option value={i}>
                    {m.name}
                    {m.fileId ? " · 已有资料" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className={"ops-state " + item.status}>
            {
              (
                {
                  waiting: "待上传",
                  uploading: "上传中",
                  success: "已保存",
                  failed: "未完成",
                } as any
              )[item.status]
            }
          </span>
          {!busy && item.status !== "success" && (
            <button
              className="ghost"
              onClick={() =>
                setQueue((q) => q.filter((x) => x.key !== item.key))
              }
            >
              移除
            </button>
          )}
        </div>
      ))}
      <Notice text={note} />
      {queue.length > 0 && (
        <div className="ops-inline">
          <button
            disabled={busy || queue.every((x) => x.status === "success")}
            onClick={() => void upload()}
          >
            {busy
              ? "正在逐个保存…"
              : queue.some((x) => x.status === "failed")
                ? "重试未完成项"
                : "开始上传"}
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              setQueue((q) => q.filter((x) => x.status !== "success"))
            }
          >
            清除已完成
          </button>
        </div>
      )}
      {!run && kind === "result" && (
        <p className="ops-notice">
          这里只登记人工处理成果。WorkBuddy
          成果请在对应任务中上传，避免混入其他任务。
        </p>
      )}
      <small>
        上传成功的资料已保存到服务器；尚未上传的本地队列在离开页面后不会保留。重试不会重复保存同一项。
      </small>
    </section>
  );
}

export function Followups({ detail, api, onRefresh, write }: any) {
  const action = useAction(),
    missing = detail.checklist
      .map((x: any, i: number) => ({ ...x, index: i }))
      .filter((x: any) => !x.fileId && !x.waiver);
  return (
    <section className="ops-followups">
      <div className="ops-title">
        <div>
          <h3>缺件跟进</h3>
          <p>记录实际联系结果和下次跟进日期，不自动给客户发送消息。</p>
        </div>
        <span>{missing.length} 项待补</span>
      </div>
      {missing.length === 0 ? (
        <p className="ops-good">资料已齐备或完成豁免。</p>
      ) : (
        missing.map((m: any) => {
          const last = detail.followups?.find(
            (f: any) => f.material_index === m.index,
          );
          return (
            <div className="ops-missing">
              <strong>
                {m.name}
                {m.required ? " · 必需" : ""}
              </strong>
              <p>
                {last
                  ? `${last.actor_name} · ${last.channel} · ${when(last.created_at)}：${last.note}`
                  : "尚无跟进记录"}
              </p>
              {last?.next_date && <small>下次跟进：{last.next_date}</small>}
            </div>
          );
        })
      )}
      {write && detail.status !== "archived" && missing.length > 0 && (
        <form
          className="ops-form"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget,
              b = new FormData(form);
            void action.act(async () => {
              await api(`/orders/${detail.id}/followups`, {
                version: detail.version,
                index: Number(b.get("index")),
                note: b.get("note"),
                channel: b.get("channel"),
                ...(b.get("nextDate") ? { nextDate: b.get("nextDate") } : {}),
              });
              form.reset();
              await onRefresh();
            }, "跟进已保存");
          }}
        >
          <label>
            待补资料
            <select name="index">
              {missing.map((m: any) => (
                <option value={m.index}>{m.name}</option>
              ))}
            </select>
          </label>
          <label>
            联系渠道
            <select name="channel">
              {["微信", "电话", "邮件", "其他"].map((s) => (
                <option>{s}</option>
              ))}
            </select>
          </label>
          <label>
            下次跟进日期
            <input type="date" name="nextDate" />
          </label>
          <label className="ops-wide">
            联系结果
            <textarea
              name="note"
              required
              maxLength={4000}
              placeholder="例如：客户确认明天补发银行流水，还缺 2 张回单。"
            />
          </label>
          <button disabled={action.busy}>保存跟进</button>
        </form>
      )}
      <Notice text={action.message} />
      {!!detail.followups?.length && (
        <details>
          <summary>查看跟进历史（最近 {detail.followups.length} 条）</summary>
          {detail.followups.map((f: any) => (
            <div className="ops-history">
              <strong>
                {detail.checklist[f.material_index]?.name} ·{" "}
                {detail.checklist[f.material_index]?.fileId ||
                detail.checklist[f.material_index]?.waiver
                  ? "已解决"
                  : "待补"}
              </strong>
              <small>
                {when(f.created_at)} · {f.actor_name} · {f.channel}
              </small>
              <p>{f.note}</p>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}

function ReturnForm({ run, detail, api, onRefresh }: any) {
  const action = useAction(),
    [manifest, setManifest] = useState(""),
    [parseError, setParseError] = useState(""),
    [resultIds, setResultIds] = useState<string[]>([]);
  return (
    <details className="ops-return">
      <summary>上传并回传此任务的成果</summary>
      <BatchUpload
        key={run.id}
        detail={detail}
        api={api}
        onRefresh={onRefresh}
        run={run}
        defaultKind="result"
      />
      <form
        className="ops-form"
        onSubmit={(e) => {
          e.preventDefault();
          const b = new FormData(e.currentTarget);
          void action.act(async () => {
            const m = JSON.parse(manifest);
            if (m.runId !== run.id) throw Error("回传清单不属于当前任务");
            await api(`/runs/${run.id}/return`, {
              version: run.version,
              inputHashes: m.inputHashes,
              resultFileIds: resultIds,
              summary: b.get("summary"),
            });
            await onRefresh();
          }, "成果已回传，仍需独立复核");
        }}
      >
        <label className="ops-wide">
          读取任务包中的 return-manifest.json
          <input
            type="file"
            accept=".json"
            onChange={async (e) => {
              const f = e.currentTarget.files?.[0];
              if (!f) return;
              try {
                if (f.size > 65536) throw Error("回传清单不能超过 64 KB");
                const text = await f.text(),
                  m = JSON.parse(text);
                if (m.runId !== run.id) throw Error("回传清单不属于当前任务");
                setManifest(text);
                setParseError("");
              } catch (e: any) {
                setManifest("");
                setParseError(e.message);
              }
            }}
          />
        </label>
        <Notice text={parseError} />
        <details className="ops-wide">
          <summary>或粘贴回传清单</summary>
          <textarea
            aria-label="回传清单内容"
            value={manifest}
            onInput={(e) => setManifest(e.currentTarget.value)}
          />
        </details>
        {manifest && (
          <p className="ops-good">已读取清单，提交时核对输入文件摘要。</p>
        )}
        <div className="ops-wide">
          <FilePicker
            api={api}
            scope={{
              companyId: detail.company_id,
              period: detail.period,
              orderId: detail.id,
            }}
            purpose="result"
            runId={run.id}
            eligibleOnly
            latestOnly
            selectedIds={resultIds}
            onChange={setResultIds}
            refreshKey={run.version}
            disabled={action.busy}
            title="选择此任务成果（可跨页，固定文件版本）"
          />
        </div>
        <label className="ops-wide">
          成果、校验与未解决事项
          <textarea
            name="summary"
            required
            maxLength={4000}
            placeholder="填写行数、金额核对结果和未解决问题；没有异常也请明确说明。"
          />
        </label>
        <button disabled={action.busy || !manifest || !resultIds.length}>
          确认所选成果并回传
        </button>
        <Notice text={action.message} />
      </form>
    </details>
  );
}

function RunActions({ run, detail, api, onRefresh }: any) {
  const action = useAction(),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    [replaceInputs, setReplaceInputs] = useState(false);
  const request = useRef({ key: crypto.randomUUID(), signature: "" });
  const stale =
    run.status === "stale" || run.input_revision !== detail.input_revision;
  return (
    <details className="ops-run-actions">
      <summary>修订或取消任务</summary>
      <form
        className="ops-form"
        onSubmit={(e) => {
          e.preventDefault();
          const b = new FormData(e.currentTarget),
            reason = String(b.get("reason") || "");
          const mode = (e as any).submitter?.value || "revise";
          void action.act(
            async () => {
              if (mode === "cancel")
                await api(`/runs/${run.id}/cancel`, {
                  version: run.version,
                  reason,
                });
              else {
                if ((stale || replaceInputs) && !sourceIds.length)
                  throw Error("请重新选择本次输入版本");
                const body = {
                  version: run.version,
                  reason,
                  ...(stale || replaceInputs ? { fileIds: sourceIds } : {}),
                };
                const signature = JSON.stringify(body);
                if (request.current.signature !== signature)
                  request.current = { key: crypto.randomUUID(), signature };
                await api(`/runs/${run.id}/revise`, {
                  ...body,
                  key: request.current.key,
                });
              }
              await onRefresh();
            },
            mode === "cancel"
              ? "任务已取消，原记录仍保留"
              : "已建立修订任务，请下载新任务包重新处理",
          );
        }}
      >
        <p className="ops-wide muted">
          修订会建立新任务并保留旧记录；取消或修订后须重新提交独立复核。
        </p>
        <label className="ops-wide">
          原因
          <textarea
            name="reason"
            required
            maxLength={2000}
            placeholder="说明修订或取消的原因"
          />
        </label>
        {!stale && (
          <label className="check ops-wide">
            <input
              type="checkbox"
              checked={replaceInputs}
              onChange={(e) => setReplaceInputs(e.currentTarget.checked)}
            />
            重新选择输入文件
          </label>
        )}
        {(stale || replaceInputs) && (
          <div className="ops-wide">
            <FilePicker
              api={api}
              scope={{
                companyId: detail.company_id,
                period: detail.period,
                orderId: detail.id,
              }}
              purpose="source"
              selectedIds={sourceIds}
              onChange={setSourceIds}
              refreshKey={detail.version}
              disabled={action.busy}
              title="修订任务的输入"
            />
          </div>
        )}
        <div className="ops-inline ops-wide">
          <button name="action" value="revise" disabled={action.busy}>
            建立修订任务
          </button>
          <button
            name="action"
            value="cancel"
            className="secondary"
            disabled={action.busy}
          >
            取消此任务
          </button>
        </div>
        <Notice text={action.message} />
      </form>
    </details>
  );
}

export function ResultOrigins({ detail, api, onRefresh, write }: any) {
  const [page, setPage] = useState(0),
    [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [choices, setChoices] = useState<Record<string, string>>({});
  const action = useAction();
  useEffect(() => {
    let alive = true;
    setData(null);
    setError("");
    setChoices({});
    if (detail.status !== "archived")
      void api(`/orders/${detail.id}/result-origins?limit=50&offset=${page}`)
        .then((v: any) => {
          if (alive) {
            if (!v.rows.length && page && v.total <= page) setPage(0);
            else setData(v);
          }
        })
        .catch((e: any) => {
          if (alive) setError(e.message);
        });
    return () => {
      alive = false;
    };
  }, [detail.id, detail.version, page]);
  if (detail.status === "archived" || (!error && !data?.total)) return null;
  return (
    <section className="ops-origins">
      <h4>历史成果归属待确认</h4>
      <p className="muted">
        仅处理尚未归档的历史文件。确认属于某个 WorkBuddy
        任务、人工处理成果，或从本次送审中排除。
      </p>
      <Notice text={error} />
      {data && (
        <form
          className="ops-form"
          onSubmit={(e) => {
            e.preventDefault();
            const b = new FormData(e.currentTarget);
            void action.act(async () => {
              const assignments = Object.entries(choices)
                .filter(([, value]) => !!value)
                .map(([fileId, value]) =>
                  value.startsWith("run:")
                    ? { fileId, origin: "workbuddy", runId: value.slice(4) }
                    : { fileId, origin: value },
                );
              if (!assignments.length) throw Error("请至少确认一份文件的归属");
              await api(`/orders/${detail.id}/result-origins`, {
                version: detail.version,
                assignments,
                reason: b.get("reason"),
              });
              await onRefresh();
            }, "已确认所选历史成果归属");
          }}
        >
          <div className="ops-wide">
            {data.rows.map((f: any) => (
              <div className="ops-file-row" key={f.id}>
                <span className="ops-file-name">
                  {f.name}
                  <small>
                    v{f.version} · {f.id.slice(0, 8)}
                  </small>
                </span>
                <select
                  aria-label={`确认 ${f.name} 归属`}
                  disabled={!write || !data.canResolve || action.busy}
                  value={choices[f.id] || ""}
                  onChange={(e) =>
                    setChoices((v) => ({ ...v, [f.id]: e.currentTarget.value }))
                  }
                >
                  <option value="">待确认</option>
                  <option value="manual">人工处理成果</option>
                  <option value="excluded">排除本次送审</option>
                  {(f.candidateRuns || data.candidateRuns || []).map(
                    (r: any) => (
                      <option value={`run:${r.id}`} key={r.id}>
                        任务 {r.id.slice(0, 8)} ·{" "}
                        {r.workflow_id || r.workflowId}
                        {r.priorReference ? " · 原记录引用" : ""}
                      </option>
                    ),
                  )}
                </select>
              </div>
            ))}
          </div>
          <div className="ops-file-pager ops-wide">
            <span>待确认 {data.total} 份</span>
            <button
              type="button"
              className="secondary"
              disabled={!page || action.busy}
              onClick={() => setPage((p) => Math.max(0, p - 50))}
            >
              上一页
            </button>
            <button
              type="button"
              className="secondary"
              disabled={page + 50 >= data.total || action.busy}
              onClick={() => setPage((p) => p + 50)}
            >
              下一页
            </button>
          </div>
          {write && data.canResolve && (
            <>
              <label className="ops-wide">
                确认依据
                <textarea name="reason" required maxLength={2000} />
              </label>
              <button
                disabled={action.busy || !Object.values(choices).some(Boolean)}
              >
                确认当前页所选归属
              </button>
            </>
          )}
          <Notice text={action.message} />
        </form>
      )}
    </section>
  );
}

export function WorkBuddyHandoff({
  detail,
  api,
  onRefresh,
  write,
  workflows,
}: any) {
  const action = useAction(),
    [jobs, setJobs] = useState<any[]>([]),
    [jobError, setJobError] = useState(""),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    request = useRef({ key: crypto.randomUUID(), body: "" });
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const data = await api(`/jobs?orderId=${detail.id}`);
        if (alive) {
          setJobs(data);
          setJobError("");
        }
      } catch (e: any) {
        if (alive) setJobError("任务包状态暂时无法刷新：" + e.message);
      }
    };
    void poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [detail.id]);
  async function pack(id: string) {
    const j = await api("/jobs", {
      kind: "run_export",
      key: "run-export-" + id,
      companyId: detail.company_id,
      payload: { runId: id },
    });
    setJobs(await api(`/jobs?orderId=${detail.id}`));
    return j;
  }
  return (
    <section className="ops-handoff">
      <div className="ops-title">
        <div>
          <h3>WorkBuddy 任务交接</h3>
          <p>
            ① 选择输入并打包　② 下载到 WorkBuddy 处理　③ 上传成果并回传　④
            提交独立复核
          </p>
        </div>
      </div>
      {write && detail.status === "processing" && (
        <details
          open={
            !detail.runs.some(
              (r: any) =>
                r.status === "external" &&
                r.input_revision === detail.input_revision,
            )
          }
        >
          <summary>新建交接任务</summary>
          <form
            className="ops-form"
            onSubmit={(e) => {
              e.preventDefault();
              const b = new FormData(e.currentTarget);
              const body = {
                workflowId: b.get("workflowId"),
                fileIds: sourceIds,
                taskBrief: { requirements: String(b.get("brief") || "") },
              };
              const signature = JSON.stringify({
                ...body,
                revision: detail.revision,
              });
              if (request.current.body !== signature)
                request.current = { key: crypto.randomUUID(), body: signature };
              void action.act(async () => {
                if (!body.fileIds.length)
                  throw Error("请至少选择一份本次输入资料");
                const r = await api(`/orders/${detail.id}/runs`, {
                  ...body,
                  version: detail.version,
                  key: request.current.key,
                });
                await onRefresh();
                await pack(r.id);
              }, "任务已建立，任务包生成中，可在下方直接下载");
            }}
          >
            <label>
              工作流
              <select name="workflowId">
                {workflows.map((w: any) => (
                  <option value={w.id}>{w.title}</option>
                ))}
              </select>
            </label>
            <label className="ops-wide">
              处理要求
              <textarea
                name="brief"
                maxLength={2000}
                placeholder="说明范围、处理口径和需要交回的成果。"
              />
            </label>
            <div className="ops-wide">
              <FilePicker
                api={api}
                scope={{
                  companyId: detail.company_id,
                  period: detail.period,
                  orderId: detail.id,
                }}
                purpose="source"
                selectedIds={sourceIds}
                onChange={setSourceIds}
                refreshKey={detail.version}
                disabled={action.busy}
                title="本次输入版本（可跨页选择）"
              />
            </div>
            <button disabled={action.busy || !sourceIds.length}>
              建立任务并生成任务包
            </button>
          </form>
        </details>
      )}
      <ResultOrigins
        detail={detail}
        api={api}
        onRefresh={onRefresh}
        write={write}
      />
      <Notice text={action.message || jobError} />
      {!detail.runs.length && (
        <p className="muted">
          尚无交接任务。进入经办阶段后，选择输入文件建立任务。
        </p>
      )}
      {detail.runs.map((r: any) => {
        const job = jobs.find(
          (j) => j.kind === "run_export" && j.run_id === r.id,
        );
        const current =
          r.active !== false &&
          r.status === "external" &&
          r.input_revision === detail.input_revision &&
          detail.status === "processing";
        return (
          <article className="ops-run" key={r.id}>
            <div className="ops-title">
              <div>
                <strong>
                  {workflows.find((w: any) => w.id === r.workflow_id)?.title ||
                    r.workflow_id}
                </strong>
                <small>
                  {when(r.created_at)} · 任务 {r.id.slice(0, 8)}
                </small>
              </div>
              <span className="ops-state">
                {
                  (
                    {
                      external: "外部处理中",
                      returned: "成果已回传",
                      stale: "输入已失效",
                      cancelled: "已取消",
                      superseded: "已有修订任务",
                    } as any
                  )[
                    r.active === false && r.status !== "cancelled"
                      ? "superseded"
                      : r.status
                  ]
                }
              </span>
            </div>
            <details>
              <summary>本次输入 · {r.input_files.length} 份</summary>
              {r.input_files.map((f: any) => (
                <p>
                  {f.name} · v{f.version}
                </p>
              ))}
            </details>
            {write && current && (
              <>
                <div className="ops-inline">
                  {!job && (
                    <button
                      className="secondary"
                      disabled={action.busy}
                      onClick={() =>
                        void action.act(() => pack(r.id), "任务包生成中")
                      }
                    >
                      生成我的任务包
                    </button>
                  )}
                  {job && (
                    <>
                      <span>
                        {
                          (
                            {
                              pending: "等待打包",
                              running: "正在打包",
                              completed: "任务包已就绪",
                              failed: "打包失败",
                            } as any
                          )[job.status]
                        }
                      </span>
                      {job.status === "completed" && (
                        <a
                          className="ops-link"
                          href={`/api/v1/jobs/${job.id}/download`}
                        >
                          下载任务包
                        </a>
                      )}
                      {job.status === "failed" && (
                        <>
                          <small className="ops-error">{job.error}</small>
                          <button
                            disabled={action.busy}
                            onClick={() =>
                              void action.act(async () => {
                                await api(`/jobs/${job.id}/retry`, {});
                                setJobs(
                                  await api(`/jobs?orderId=${detail.id}`),
                                );
                              }, "已重新排队")
                            }
                          >
                            重新打包
                          </button>
                        </>
                      )}
                    </>
                  )}
                </div>
                <ReturnForm
                  run={r}
                  detail={detail}
                  api={api}
                  onRefresh={onRefresh}
                />
              </>
            )}
            {write && !current && job?.status === "completed" && (
              <a className="ops-link" href={`/api/v1/jobs/${job.id}/download`}>
                下载该任务的历史输入包
              </a>
            )}
            {r.status === "returned" && (
              <div className="ops-receipt">
                <strong>回传记录</strong>
                <FileSnapshotList
                  api={api}
                  scope={{
                    companyId: detail.company_id,
                    period: detail.period,
                    orderId: detail.id,
                  }}
                  ids={r.result_files || []}
                  title="回传时的固定成果版本"
                />
                <p>{r.check_result?.summary}</p>
                <small>结构检查完成，财务判断以独立复核为准。</small>
              </div>
            )}
            {write &&
              r.active !== false &&
              !["archived", "collecting", "checking"].includes(detail.status) &&
              !["cancelled", "superseded"].includes(r.status) && (
                <RunActions
                  run={r}
                  detail={detail}
                  api={api}
                  onRefresh={onRefresh}
                />
              )}
            {r.status === "stale" && (
              <small>
                原输入或批次已变化，请依据当前资料重新建立任务。历史记录保留。
              </small>
            )}
          </article>
        );
      })}
    </section>
  );
}

export function TeamManagement({ api, user, onChanged }: any) {
  const [people, setPeople] = useState<any[]>([]),
    [search, setSearch] = useState(""),
    [filter, setFilter] = useState("active"),
    [selected, setSelected] = useState(""),
    [work, setWork] = useState<any>(null),
    [companyId, setCompanyId] = useState("");
  const action = useAction(),
    generation = useRef(0),
    [loadError, setLoadError] = useState("");
  const load = async () => setPeople(await api("/team/directory"));
  useEffect(() => {
    void load().catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => {
    const n = ++generation.current;
    setWork(null);
    setCompanyId("");
    if (selected)
      void api(`/team/users/${selected}/workload`)
        .then((v: any) => {
          if (n === generation.current) {
            setWork(v);
            setLoadError("");
          }
        })
        .catch((e: any) => {
          if (n === generation.current) setLoadError(e.message);
        });
  }, [selected]);
  const u = people.find((p) => p.id === selected),
    c = work?.companies.find((c: any) => c.id === companyId),
    orders = work?.orders.filter((o: any) => o.company_id === companyId) || [];
  const reload = async () => {
    await load();
    if (selected) setWork(await api(`/team/users/${selected}/workload`));
    await onChanged();
  };
  return (
    <div className="ops-team">
      <div className="agency-heading">
        <div>
          <p className="agency-eyebrow">团队管理</p>
          <h1>人员、客户与交接</h1>
          <p>先安排客户和在办月份的接手人员，再停用离职账号。</p>
        </div>
        <span>{people.filter((p) => p.active).length} 位在职成员</span>
      </div>
      <Notice text={action.message || loadError} />
      <div className="ops-team-layout">
        <section>
          <div className="ops-inline">
            <input
              aria-label="搜索团队成员"
              value={search}
              placeholder="搜索姓名或账号"
              onInput={(e) => setSearch(e.currentTarget.value)}
            />
            <select
              aria-label="成员状态"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            >
              <option value="active">在职成员</option>
              <option value="all">全部成员</option>
              <option value="inactive">已停用</option>
            </select>
          </div>
          <div className="ops-people">
            {people
              .filter(
                (p) =>
                  (filter === "all" || p.active === (filter === "active")) &&
                  (p.name + p.username)
                    .toLowerCase()
                    .includes(search.toLowerCase()),
              )
              .map((p) => (
                <button
                  className={
                    "ops-person " + (p.id === selected ? "selected" : "")
                  }
                  onClick={() => setSelected(p.id)}
                >
                  <span className="ops-avatar">{p.name.slice(-2)}</span>
                  <span>
                    <strong>
                      {p.name} {p.id === user.id ? "（我）" : ""}
                    </strong>
                    <small>
                      {roles[p.role]} · {p.active ? "在职" : "已停用"}
                      {p.must_change_password ? " · 待改初始密码" : ""}
                    </small>
                    <small>
                      {p.companies} 家客户 · 经办 {p.handling} · 复核{" "}
                      {p.reviewing}
                    </small>
                  </span>
                </button>
              ))}
          </div>
        </section>
        <section className="ops-staff-detail">
          {!u ? (
            <div className="empty">
              选择一位成员，查看客户范围、在办工作和交接操作。
            </div>
          ) : (
            <>
              <h2>{u.name}</h2>
              <p>
                {u.username} · {roles[u.role]} ·{" "}
                {u.active ? "账号启用" : "账号停用"}
              </p>
              {!work ? (
                <p>正在读取客户分工…</p>
              ) : (
                <>
                  <h3>客户范围与工作交接</h3>
                  <p>
                    {work.companies.length} 家已授权或有分工客户；
                    {work.orders.length} 个月份待完成。
                    {u.role === "owner" ? "负责人另有全部客户访问权。" : ""}
                  </p>
                  <label>
                    选择交接客户
                    <select
                      value={companyId}
                      onChange={(e) => setCompanyId(e.currentTarget.value)}
                    >
                      <option value="">选择客户查看交接范围</option>
                      {work.companies.map((c: any) => (
                        <option value={c.id}>{c.name}</option>
                      ))}
                    </select>
                  </label>
                  {c && (
                    <>
                      <div className="ops-receipt">
                        <strong>{c.name}</strong>
                        <p>
                          默认经办：
                          {people.find((p) => p.id === c.default_assignee_id)
                            ?.name || "未设置"}{" "}
                          · 默认复核：
                          {people.find((p) => p.id === c.default_reviewer_id)
                            ?.name || "未设置"}
                        </p>
                        {orders.map((o: any) => (
                          <p>
                            {o.period} · {stages[o.status]} ·{" "}
                            {o.assignee_id === u.id ? "经办" : "复核"}
                          </p>
                        ))}
                        {!orders.length && <p>没有该员工负责的未归档月份。</p>}
                      </div>
                      <form
                        className="ops-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const b = new FormData(e.currentTarget);
                          void action.act(async () => {
                            await api("/team/handoff", {
                              sourceId: u.id,
                              targetId: b.get("targetId"),
                              companyId: c.id,
                              sourceVersion: work.user.version,
                              companyVersion: c.version,
                              orders: orders.map((o: any) => ({
                                id: o.id,
                                version: o.version,
                              })),
                              reason: b.get("reason"),
                              revokeSource: b.has("revoke"),
                            });
                            await reload();
                          }, "客户分工和在办月份已交接，历史责任保留");
                        }}
                      >
                        <label>
                          接手员工
                          <select name="targetId" required>
                            <option value="">选择接手员工</option>
                            {people
                              .filter((p) => p.active && p.id !== u.id)
                              .map((p) => (
                                <option value={p.id}>
                                  {p.name} · {roles[p.role]}
                                </option>
                              ))}
                          </select>
                        </label>
                        <label className="ops-wide">
                          交接原因
                          <textarea name="reason" required maxLength={4000} />
                        </label>
                        {u.role !== "owner" && (
                          <label className="check ops-wide">
                            <input type="checkbox" name="revoke" />
                            交接成功后，撤销原员工对此客户的访问权
                          </label>
                        )}
                        <small className="ops-wide">
                          将转交以上默认职责与未归档月份，并授权接手员工。已归档月份与历史经办责任保留；参与过经办的人不能接手复核。
                        </small>
                        <button disabled={action.busy}>
                          确认交接 {orders.length} 个月份
                        </button>
                      </form>
                    </>
                  )}
                </>
              )}
              {u.id !== user.id && (
                <details>
                  <summary>账号状态、角色和密码</summary>
                  <form
                    className="ops-form"
                    key={u.id + u.version}
                    onSubmit={(e) => {
                      e.preventDefault();
                      const b = new FormData(e.currentTarget);
                      void action.act(async () => {
                        await api(`/users/${u.id}`, {
                          version: u.version,
                          role: b.get("role"),
                          active: b.get("active") === "true",
                        });
                        await reload();
                      }, "账号已更新，旧会话已撤销");
                    }}
                  >
                    <label>
                      角色
                      <select name="role" defaultValue={u.role}>
                        {Object.entries(roles).map(([k, v]: any) => (
                          <option value={k}>{v}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      状态
                      <select name="active" defaultValue={String(u.active)}>
                        <option value="true">启用</option>
                        <option value="false">停用</option>
                      </select>
                    </label>
                    <button disabled={action.busy}>保存账号设置</button>
                  </form>
                  <form
                    className="ops-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = e.currentTarget,
                        b = new FormData(f);
                      void action.act(async () => {
                        await api(`/users/${u.id}/reset-password`, {
                          password: b.get("password"),
                        });
                        f.reset();
                        await reload();
                      }, "初始密码已重置，员工下次登录必须修改");
                    }}
                  >
                    <label>
                      为 {u.name} 设置新初始密码
                      <input
                        name="password"
                        type="password"
                        minLength={12}
                        maxLength={128}
                        required
                        autoComplete="new-password"
                      />
                    </label>
                    <button className="secondary" disabled={action.busy}>
                      重置并撤销旧会话
                    </button>
                  </form>
                </details>
              )}
            </>
          )}
        </section>
      </div>
      <details className="ops-new-person">
        <summary>新增团队成员</summary>
        <form
          className="ops-form"
          onSubmit={(e) => {
            e.preventDefault();
            const f = e.currentTarget,
              b = Object.fromEntries(new FormData(f));
            void action.act(async () => {
              await api("/users", b);
              f.reset();
              await reload();
            }, "员工已创建，请分配客户或通过交接安排工作");
          }}
        >
          <label>
            姓名
            <input name="name" required maxLength={200} />
          </label>
          <label>
            登录账号
            <input name="username" required autoComplete="off" />
          </label>
          <label>
            角色
            <select name="role" defaultValue="operator">
              {Object.entries(roles).map(([k, v]: any) => (
                <option value={k}>{v}</option>
              ))}
            </select>
          </label>
          <label>
            初始密码（至少 12 位）
            <input
              name="password"
              type="password"
              required
              minLength={12}
              maxLength={128}
              autoComplete="new-password"
            />
          </label>
          <button disabled={action.busy}>创建成员</button>
        </form>
      </details>
    </div>
  );
}
