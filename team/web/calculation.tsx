import { useRef, useState, useEffect } from "preact/hooks";

export function CalculationReturn({ api, run, onRefresh, canReturn }: any) {
  const [data, setData] = useState<any>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [section, setSection] = useState("issues"),
    [summary, setSummary] = useState("");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const act = async (fn: any) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const load = async (offset = 0) => {
    const result = await api(
      `/workflow-tasks/${run.id}/calculation?section=${section}&limit=30&offset=${offset}`,
    );
    if (alive.current) setData(result);
  };
  return (
    <section className="ops-receipt">
      <h4>程序内工作流结果</h4>
      <p>
        读取固定计算结果，补充经办说明后一次回传原件。异常仍需修订重算，财务判断由独立人员复核。
      </p>
      <label>
        查看内容
        <select
          value={section}
          disabled={busy}
          onChange={(e) => {
            setSection(e.currentTarget.value);
            setData(null);
          }}
        >
          <option value="issues">异常清单</option>
          {run.execution_mode === "embedded_rules" ? (
            <option value="rows">处理明细与草稿</option>
          ) : (
            <option value="trial">试算明细</option>
          )}
        </select>
      </label>
      <button
        type="button"
        className="secondary"
        disabled={busy}
        onClick={() => void act(() => load())}
      >
        读取计算结果与异常
      </button>
      {error && (
        <p role="alert" className="ops-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <p>{data.metadata.scope}</p>
          {data.metadata.manual?.length > 0 && (
            <ul>
              {data.metadata.manual.map((note: string) => (
                <li>{note}</li>
              ))}
            </ul>
          )}
          <p role="status">
            异常 {data.metadata.issueCount} 项 · 当前内容 {data.total} 条 ·{" "}
            {data.stale ? "输入已失效，请修订任务" : "输入版本一致"} ·
            待财务复核
          </p>
          <dl>
            {Object.entries(data.metadata.summary || {}).map(([key, value]) => (
              <div key={key}>
                <dt>
                  {(
                    {
                      assets: "资产",
                      liabilities: "负债",
                      equity: "权益",
                      revenues: "收入",
                      expenses: "费用",
                      profit: "利润",
                      balanceDifference: "平衡差额",
                      workflowId: "工作流",
                      workbookCount: "输入工作簿数",
                      inputRows: "输入行数",
                      excludedRows: "未通过输入校验行数",
                      outputRows: "输出行数",
                      issueCount: "异常数",
                      parameters: "本次明确参数",
                      totalsScope: "计算范围",
                    } as any
                  )[key] || key}
                </dt>
                <dd>
                  {typeof value === "object"
                    ? JSON.stringify(value)
                    : String(value)}
                </dd>
              </div>
            ))}
          </dl>
          <ol start={data.offset + 1}>
            {data.rows.map((x: any, i: number) => (
              <li key={i}>
                {typeof x === "string"
                  ? x
                  : x.message || x.description || JSON.stringify(x)}
              </li>
            ))}
          </ol>
          <div className="ops-inline">
            <button
              type="button"
              disabled={busy || data.offset === 0}
              onClick={() =>
                void act(() => load(Math.max(0, data.offset - 30)))
              }
            >
              上一页
            </button>
            <button
              type="button"
              disabled={busy || data.offset + 30 >= data.total}
              onClick={() => void act(() => load(data.offset + 30))}
            >
              下一页
            </button>
          </div>
          {canReturn && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api(`/workflow-tasks/${run.id}/return-calculation`, {
                    version: data.runVersion,
                    jobId: data.jobId,
                    summary,
                  });
                  await onRefresh();
                });
              }}
            >
              <label>
                经办说明（口径、校验及未解决事项）
                <textarea
                  required
                  maxLength={4000}
                  value={summary}
                  disabled={busy}
                  onInput={(e) => setSummary(e.currentTarget.value)}
                />
              </label>
              <button disabled={busy || data.stale || !summary.trim()}>
                {busy ? "正在保存…" : "回传计算成果与说明"}
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
