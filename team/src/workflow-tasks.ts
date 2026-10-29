import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  tx,
  one,
  order,
  company,
  writer,
  fail,
  sha,
  canonical,
  touch,
  audit,
  uuid,
  type Actor,
} from "./core.js";
import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";
import { assertEmbeddedInput } from "./embedded-workflows.js";

export const runRequest = z.object({
  version: z.number().int().positive(),
  workflowId: z.string().max(100),
  taskBrief: z.record(z.string().max(50), z.string().max(2000)).default({}),
  fileIds: z.array(uuid).min(1).max(100),
  key: uuid.optional(),
});
// Caller owns the transaction: a new workflow and its export job commit together.
export async function createRun(
  db: any,
  actor: Actor,
  orderId: string,
  b: z.infer<typeof runRequest>,
  requestId: string,
  executionMode = "workbuddy",
) {
  writer(actor);
  const o = await order(db, orderId);
  const fingerprint = sha(
    canonical({
      workflowId: b.workflowId,
      ...(executionMode !== "workbuddy" ? { executionMode } : {}),
      taskBrief: b.taskBrief,
      fileIds: [...b.fileIds].sort(),
    }),
  );
  if (b.key) {
    const previous = (
      await db.query(
        "SELECT id,client_fingerprint FROM runs WHERE order_id=$1 AND created_by=$2 AND client_key=$3",
        [o.id, actor.id, b.key],
      )
    ).rows[0];
    if (previous) {
      if (previous.client_fingerprint !== fingerprint)
        fail(409, "任务标识已用于不同输入");
      return { id: previous.id };
    }
  }
  if (o.version !== b.version) fail(409, "记录已被修改，请刷新后重试");
  if (!(await company(db, o.company_id)).active) fail(409, "客户已停用");
  if (o.status !== "processing") fail(409, "请先进入经办处理阶段");
  if (!FINANCE_WORKFLOWS.some((w: any) => w.id === b.workflowId))
    fail(400, "工作流不存在");
  const fs = (
    await db.query(
      "SELECT f.id,f.name,f.sha256,f.version,f.size FROM files f WHERE f.id=ANY($1::uuid[]) AND f.order_id=$2 AND f.kind='source' AND NOT EXISTS(SELECT 1 FROM files n WHERE n.order_id=f.order_id AND n.kind=f.kind AND n.name=f.name AND n.version>f.version)",
      [b.fileIds, o.id],
    )
  ).rows;
  if (fs.length !== new Set(b.fileIds).size)
    fail(400, "输入文件不属于本工作单");
  const id = randomUUID();
  await db.query(
    "INSERT INTO runs(id,org_id,company_id,order_id,workflow_id,input_files,revision,created_by,task_brief,client_key,client_fingerprint,input_revision,execution_mode) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
    [
      id,
      actor.org_id,
      o.company_id,
      o.id,
      b.workflowId,
      JSON.stringify(fs),
      o.revision,
      actor.id,
      JSON.stringify(b.taskBrief),
      b.key || null,
      fingerprint,
      o.input_revision,
      executionMode,
    ],
  );
  await touch(db, o, actor);
  await audit(db, actor, "run_created", id, o.company_id, {}, requestId);
  return { id };
}

export function workflowProgress(run: any, o: any, job: any) {
  const embedded =
    ["embedded_accounting", "embedded_rules"].includes(run.execution_mode) ||
    ["embedded_accounting", "embedded_rules"].includes(job?.kind);
  let state = "queued",
    nextAction = embedded
      ? "后台计算已排队，稍后查询任务进度"
      : "稍后查询任务包状态";
  const included =
    run.result_files.length > 0 &&
    run.result_files.every((id: string) =>
      o.submission?.files?.some((f: any) => f.id === id && f.run_id === run.id),
    );
  if (!run.active || run.status === "cancelled") {
    state = "cancelled";
    nextAction = "任务已停用，请查看工作单中的当前任务";
  } else if (
    run.status === "stale" ||
    run.input_revision !== o.input_revision
  ) {
    state = "stale";
    nextAction = "输入资料已变更，请刷新工作单并建立修订任务";
  } else if (run.status === "returned") {
    state =
      included && ["review", "delivery", "archived"].includes(o.status)
        ? o.status
        : run.check_result?.unresolvedIssues > 0
          ? "returned_with_issues"
          : "returned";
    nextAction = (
      {
        review: "等待指定人员独立复核",
        delivery: "已通过复核，等待员工交付并登记证据",
        archived: "成果已归档",
        returned: "成果已回传，等待经办核验并在网页送审",
        returned_with_issues:
          "成果已回传但仍有计算异常；修正依据并修订重算后方可送审",
      } as any
    )[state];
  } else if (o.status !== "processing") {
    state = "blocked";
    nextAction = "工作单当前不在经办阶段，请在网页核实";
  } else if (!job) {
    state = "unavailable";
    nextAction = "当前账号无法查看该任务包，或此旧任务尚未创建任务包";
  } else if (job.status === "failed") {
    state = "failed";
    nextAction = "查看后台任务错误，在工作台重试原任务；不要重复新建任务";
  } else if (job.status === "completed") {
    state = embedded ? "calculated" : "ready";
    nextAction = embedded
      ? "读取计算摘要和全部异常，补充经办说明后回传计算成果；尚未入账或通过复核"
      : "下载任务包并处理资料，然后上传和回传成果；任务包就绪不代表财务处理完成";
  } else if (job.status === "running") {
    state = embedded ? "calculating" : "packaging";
  }
  return {
    runId: run.id,
    orderId: o.id,
    companyId: o.company_id,
    period: o.period,
    workflowId: run.workflow_id,
    runVersion: run.version,
    orderVersion: o.version,
    inputRevision: run.input_revision,
    currentInputRevision: o.input_revision,
    state,
    nextAction,
    orderStatus: o.status,
    resultFileIds: run.result_files,
    executionMode:
      run.execution_mode || (embedded ? "embedded_accounting" : "workbuddy"),
    calculation: embedded ? job?.result?.calculation || null : null,
    package: job
      ? {
          id: job.id,
          status: job.status,
          fileId: job.result?.fileId || null,
          error: job.error || null,
          updatedAt: job.updated_at,
        }
      : null,
  };
}

export async function readProgress(db: any, runId: string) {
  // All three reads stay behind company RLS; no privileged job lookup.
  const { run, o, job } = await one(
    db,
    `SELECT to_jsonb(r) AS run,to_jsonb(w) AS o,to_jsonb(j) AS job
    FROM runs r JOIN work_orders w ON w.id=r.order_id
    LEFT JOIN jobs j ON j.actor_id=r.created_by AND j.kind IN ('run_export','embedded_accounting','embedded_rules') AND j.idempotency_key='workflow-task:'||r.id::text
    WHERE r.id=$1`,
    [runId],
  );
  return workflowProgress(run, o, job);
}

export async function startWorkflowTask(
  db: any,
  actor: Actor,
  orderId: string,
  b: any,
  requestId: string,
) {
  const { id } = await createRun(
    db,
    actor,
    orderId,
    b,
    requestId,
    b.executionMode,
  );
  const run = await one(db, "SELECT * FROM runs WHERE id=$1", [id]);
  const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
    run.order_id,
  ]);
  const key = `workflow-task:${id}`;
  const kind = b.executionMode !== "workbuddy" ? b.executionMode : "run_export";
  const existing = (
    await db.query(
      "SELECT id,kind FROM jobs WHERE actor_id=$1 AND kind IN ('run_export','embedded_accounting','embedded_rules') AND idempotency_key=$2",
      [actor.id, key],
    )
  ).rows[0];
  if (existing && existing.kind !== kind)
    fail(409, "此任务标识已用于另一执行方式，请保留原执行方式");
  if (!existing) {
    if (
      !run.active ||
      run.status !== "external" ||
      run.input_revision !== o.input_revision ||
      o.status !== "processing"
    )
      fail(409, "此任务已不可打包，请刷新工作单查看当前任务");
    if (kind !== "run_export")
      assertEmbeddedInput(run.workflow_id, run.input_files, kind);
    const jobId = randomUUID();
    await db.query(
      "INSERT INTO jobs(id,org_id,company_id,actor_id,kind,idempotency_key,payload) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        jobId,
        actor.org_id,
        o.company_id,
        actor.id,
        kind,
        key,
        JSON.stringify({ runId: id }),
      ],
    );
    await audit(
      db,
      actor,
      "workflow_task_started",
      id,
      o.company_id,
      { jobId, executionMode: b.executionMode },
      requestId,
    );
  }
  return readProgress(db, id);
}

export function workflowTaskRoutes(get: any, post: any) {
  post(
    "/api/v1/orders/:id/workflow-tasks",
    runRequest.extend({
      key: uuid,
      executionMode: z
        .enum(["workbuddy", "embedded_accounting", "embedded_rules"])
        .default("workbuddy"),
    }),
    "一次创建任务并安排资料包或内嵌计算",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        return startWorkflowTask(db, r.actor, r.params.id, b, r.id);
      }),
  );
  get(
    "/api/v1/workflow-tasks/:id",
    "按任务编号查看进度和下一步",
    async (r: any) =>
      tx(r.actor, async (db) => {
        // One statement gives a consistent snapshot without a write lock, including for viewers.
        return readProgress(db, uuid.parse(r.params.id));
      }),
  );
}
