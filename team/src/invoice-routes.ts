import {
  authorizationRef,
  checkAuthorization,
  resultState,
  assertInvoiceEditable,
} from "./invoice-agency.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  tx,
  one,
  order,
  company,
  writer,
  role,
  fail,
  uuid,
  audit,
  canonical,
  sha,
  touch,
  independent,
} from "./core.js";
import {
  checkInvoice,
  invoicePayload,
  invoiceConnection,
} from "./invoice-request.js";

export const requestBody = z
  .object({
    version: z.number().int().positive(),
    key: uuid,
    businessRef: z.string().trim().min(1).max(100),
    sourceFileIds: z.array(uuid).min(1).max(50),
    payload: invoicePayload,
    authorization: authorizationRef.optional(),
  })
  .strict();

async function sourceFiles(db: any, o: any, ids: string[]) {
  const unique = [...new Set(ids)];
  const files = (
    await db.query(
      `SELECT f.id,f.name,f.sha256,f.version FROM files f
    WHERE f.order_id=$1 AND f.id=ANY($2::uuid[]) AND f.kind='source'
    AND NOT EXISTS(SELECT 1 FROM files n WHERE n.order_id=f.order_id AND n.kind=f.kind AND n.name=f.name AND n.version>f.version)`,
      [o.id, unique],
    )
  ).rows;
  if (files.length !== unique.length)
    fail(400, "开票依据必须是当前工作单的最新原始资料");
  return files;
}
export async function checks(db: any, o: any, payload: unknown) {
  const report = checkInvoice(payload);
  const dossier = (
    await db.query(
      `SELECT d.payload FROM client_dossier_bindings b
    JOIN client_dossier_revisions d ON d.id=b.revision_id WHERE b.company_id=$1 AND b.period=$2`,
      [o.company_id, o.period],
    )
  ).rows[0];
  if (!dossier)
    report.issues.push({
      field: "seller",
      message: "本月客户档案尚未固定，需先核实销方身份",
    });
  else {
    if (!dossier.payload.creditCode || !dossier.payload.legalName)
      report.issues.push({
        field: "seller",
        message: "已固定档案缺少法定名称或信用代码",
      });
    else if (
      report.payload.sellerName !== dossier.payload.legalName ||
      report.payload.sellerTaxId !== dossier.payload.creditCode
    )
      report.issues.push({
        field: "seller",
        message: "销方名称或税号与本月固定档案不一致",
      });
  }
  return report;
}
export async function readRequest(db: any, id: string, actor?: any) {
  const row = await one(db, "SELECT * FROM invoice_requests WHERE id=$1", [id]);
  const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
    row.order_id,
  ]);
  const c = await company(db, o.company_id);
  const currentChecks = await checks(db, o, row.payload);
  const stale = row.input_revision !== o.input_revision || !c.active;
  const history = (
    await db.query(
      "SELECT action,actor_id,details,created_at FROM audit_events WHERE target_id=$1 AND company_id=$2 AND action LIKE 'invoice_request_%' ORDER BY created_at DESC,id DESC LIMIT 100",
      [id, o.company_id],
    )
  ).rows;
  const authorization = await checkAuthorization(
    db,
    o.company_id,
    row.authorization_id
      ? { id: row.authorization_id, version: row.authorization_version }
      : null,
    row.payload,
    "prepare_applications",
  );
  const results = await resultState(db, id);
  const canEdit =
    !!actor &&
    actor.role !== "viewer" &&
    (actor.role === "owner" || actor.id === row.actor_id) &&
    row.status !== "withdrawn" &&
    !results.locked &&
    results.latest?.payload.outcome !== "failed" &&
    c.active &&
    o.status === "processing";
  const canConfirm =
    !!actor &&
    ["owner", "reviewer"].includes(actor.role) &&
    row.status === "draft" &&
    !stale &&
    o.status === "processing" &&
    !currentChecks.issues.length &&
    authorization.valid &&
    actor.id !== row.actor_id &&
    actor.id !== o.assignee_id &&
    !o.contributors.includes(actor.id) &&
    o.submission?.submittedBy !== actor.id &&
    (actor.role === "owner" || actor.id === o.reviewer_id);
  const stage = results.pending
    ? "result_pending_review"
    : results.issued
      ? "recorded_issued"
      : results.latest?.payload.outcome === "unknown"
        ? "result_unknown"
        : row.status === "withdrawn"
          ? "withdrawn"
          : stale
            ? "stale"
            : currentChecks.issues.length
              ? "needs_materials"
              : !authorization.valid
                ? "awaiting_authorization"
                : row.status === "ready"
                  ? results.latest?.payload.outcome === "failed" &&
                    results.latest.request_version === row.version
                    ? "result_failed"
                    : results.rejected
                      ? "result_rejected"
                      : "ready"
                  : "awaiting_review";
  return {
    ...row,
    currentChecks,
    authorization,
    results,
    recordedIssued: !!results.issued,
    taxAuthorityVerified: false,
    stale,
    history,
    canEdit,
    canConfirm,
    canWithdraw:
      !!actor &&
      (actor.role === "owner" || actor.id === row.actor_id) &&
      row.status !== "withdrawn" &&
      !results.locked &&
      results.latest?.payload.outcome !== "failed",
    connection: invoiceConnection,
    stage,
    issued: false,
    nextAction: {
      result_pending_review: "请独立核验已回录的实际结果和附件",
      result_rejected:
        "回录已驳回，请查阅核验意见，沿用原资料修正后另存回录草稿；不重新开票",
      recorded_issued: "已回录成功结果并人工核验；未经税务平台在线查验",
      result_unknown: "实际开票结果不明，先核实渠道记录，禁止重复开票",
      withdrawn: "申请已撤回，记录保留供追溯",
      stale: "资料版本或客户状态已变化，请核实当前资料并修订申请",
      needs_materials: "修订申请，补齐并核验开票资料",
      awaiting_authorization:
        "请登记并独立核验逐户授权，再修订申请绑定有效版本",
      result_failed:
        "实际失败回执已人工核验；核实失败原因后继续处理原申请，勿重复创建业务申请",
      ready:
        "申请已人工核验；可回录已有渠道的实际结果，本工作台不提交或开具发票",
      awaiting_review: "由独立授权人员核验申请；保存草稿不等于开票",
    }[stage],
  };
}

export async function prepareInvoice(
  db: any,
  actor: any,
  orderId: string,
  b: any,
  requestId = "system",
) {
  writer(actor);
  const o = await order(db, orderId),
    c = await company(db, o.company_id);
  if (!c.active) fail(409, "客户已停用");
  const fingerprint = sha(
    canonical({
      businessRef: b.businessRef,
      sourceFileIds: [...new Set(b.sourceFileIds)].sort(),
      payload: b.payload,
      ...(b.authorization ? { authorization: b.authorization } : {}),
    }),
  );
  const prior = (
    await db.query(
      "SELECT id,fingerprint FROM invoice_requests WHERE order_id=$1 AND actor_id=$2 AND request_key=$3",
      [o.id, actor.id, b.key],
    )
  ).rows[0];
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      fail(409, "请求标识已用于另一份开票申请");
    return readRequest(db, prior.id, actor);
  }
  if (o.version !== b.version || o.status !== "processing")
    fail(409, "工作单版本或阶段已变化，请刷新后准备申请");
  const duplicate = (
    await db.query(
      "SELECT id FROM invoice_requests WHERE company_id=$1 AND business_ref=$2 AND status<>'withdrawn'",
      [o.company_id, b.businessRef],
    )
  ).rows[0];
  if (duplicate)
    fail(409, `该业务已有开票申请 ${duplicate.id}，请先查看，勿重复创建`);
  await checkAuthorization(
    db,
    o.company_id,
    b.authorization,
    b.payload,
    "prepare_applications",
    !!b.authorization,
  );
  const files = await sourceFiles(db, o, b.sourceFileIds),
    report = await checks(db, o, b.payload),
    id = randomUUID();
  await db.query(
    `INSERT INTO invoice_requests(id,org_id,company_id,order_id,business_ref,actor_id,request_key,fingerprint,input_revision,source_files,payload,checks,authorization_id,authorization_version)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      actor.org_id,
      o.company_id,
      o.id,
      b.businessRef,
      actor.id,
      b.key,
      fingerprint,
      o.input_revision,
      JSON.stringify(files),
      JSON.stringify(report.payload),
      JSON.stringify(report),
      b.authorization?.id || null,
      b.authorization?.version || null,
    ],
  );
  await touch(db, o, actor);
  await audit(
    db,
    actor,
    "invoice_request_prepared",
    id,
    o.company_id,
    {
      digest: fingerprint,
      issueCount: report.issues.length,
      fileIds: files.map((f: any) => f.id),
    },
    requestId,
  );
  return readRequest(db, id, actor);
}

export const invoiceRevisionBody = requestBody
  .omit({ businessRef: true })
  .extend({ reason: z.string().trim().min(1).max(2000) });

export async function reviseInvoice(
  db: any,
  actor: any,
  requestId: string,
  b: any,
  auditId = "system",
) {
  writer(actor);
  const ref = await one(
    db,
    "SELECT order_id FROM invoice_requests WHERE id=$1",
    [uuid.parse(requestId)],
  );
  const o = await order(db, ref.order_id);
  const draft = await one(
    db,
    "SELECT * FROM invoice_requests WHERE id=$1 FOR UPDATE",
    [requestId],
  );
  if (actor.id !== draft.actor_id && actor.role !== "owner")
    fail(403, "只有原经办或负责人可修订申请");
  const fingerprint = sha(
    canonical({
      version: b.version,
      sourceFileIds: [...new Set(b.sourceFileIds)].sort(),
      payload: b.payload,
      reason: b.reason,
      ...(b.authorization ? { authorization: b.authorization } : {}),
    }),
  );
  const prior = (
    await db.query(
      "SELECT fingerprint FROM invoice_request_revisions WHERE request_id=$1 AND actor_id=$2 AND request_key=$3",
      [draft.id, actor.id, b.key],
    )
  ).rows[0];
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      fail(409, "修订请求标识已用于不同内容");
    return readRequest(db, draft.id, actor);
  }
  if (
    draft.version !== b.version ||
    draft.status === "withdrawn" ||
    o.status !== "processing" ||
    !(await company(db, o.company_id)).active
  )
    fail(409, "申请或工作单已变化，请刷新");
  await assertInvoiceEditable(db, draft.id);
  const auth =
    b.authorization ||
    (draft.authorization_id
      ? {
          id: draft.authorization_id,
          version: draft.authorization_version,
        }
      : null);
  await checkAuthorization(
    db,
    o.company_id,
    auth,
    b.payload,
    "prepare_applications",
    !!auth,
  );
  const files = await sourceFiles(db, o, b.sourceFileIds),
    report = await checks(db, o, b.payload);
  // Keep the original application and every pre-edit snapshot, including approvals.
  await db.query(
    "INSERT INTO invoice_request_revisions(id,request_id,org_id,company_id,actor_id,request_key,fingerprint,version,snapshot,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      randomUUID(),
      draft.id,
      actor.org_id,
      o.company_id,
      actor.id,
      b.key,
      fingerprint,
      draft.version,
      JSON.stringify(draft),
      b.reason,
    ],
  );
  await db.query(
    "UPDATE invoice_requests SET payload=$1,checks=$2,source_files=$3,input_revision=$4,status='draft',version=version+1,confirmed_by=NULL,confirmed_at=NULL,authorization_id=$6,authorization_version=$7 WHERE id=$5",
    [
      JSON.stringify(report.payload),
      JSON.stringify(report),
      JSON.stringify(files),
      o.input_revision,
      draft.id,
      auth?.id || null,
      auth?.version || null,
    ],
  );
  await touch(db, o, actor);
  await audit(
    db,
    actor,
    "invoice_request_revised",
    draft.id,
    o.company_id,
    {
      reason: b.reason,
      fromVersion: draft.version,
      toVersion: draft.version + 1,
      issueCount: report.issues.length,
    },
    auditId,
  );
  return readRequest(db, draft.id, actor);
}

export function invoiceRoutes(get: any, post: any) {
  post(
    "/api/v1/invoice-requests/:id/revise",
    invoiceRevisionBody,
    "修订开票申请并重新等待独立核验",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        return reviseInvoice(db, r.actor, uuid.parse(r.params.id), b, r.id);
      }),
  );
  get(
    "/api/v1/invoice-requests/:id/revisions",
    "分页查看申请修改前快照",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const draft = await one(
          db,
          "SELECT id FROM invoice_requests WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        const q = z
          .object({
            limit: z.coerce.number().int().min(1).max(30).default(10),
            offset: z.coerce.number().int().min(0).max(1000000).default(0),
          })
          .parse(r.query);
        return (
          await db.query(
            "SELECT version,actor_id,reason,created_at,snapshot FROM invoice_request_revisions WHERE request_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3",
            [draft.id, q.limit, q.offset],
          )
        ).rows;
      }),
  );
  get(
    "/api/v1/invoicing/capabilities",
    "查看实际开票连接能力",
    async () => invoiceConnection,
  );
  get(
    "/api/v1/orders/:id/invoice-requests",
    "工作单开票申请列表",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const o = await one(db, "SELECT id FROM work_orders WHERE id=$1", [
          uuid.parse(r.params.id),
        ]);
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .default(30)
          .parse(r.query?.limit);
        const offset = z.coerce
          .number()
          .int()
          .min(0)
          .max(1000000)
          .default(0)
          .parse(r.query?.offset);
        return (
          await db.query(
            "SELECT i.id,i.business_ref,i.status,i.version,i.created_at,i.payload->>'buyerName' AS buyer_name,i.checks->'totals' AS totals,jsonb_array_length(i.checks->'issues') AS issue_count,i.input_revision<>w.input_revision AS stale FROM invoice_requests i JOIN work_orders w ON w.id=i.order_id WHERE i.order_id=$1 ORDER BY i.created_at DESC,i.id LIMIT $2 OFFSET $3",
            [o.id, limit, offset],
          )
        ).rows;
      }),
  );
  get(
    "/api/v1/invoice-requests/:id",
    "开票申请、缺项和接入状态",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        return readRequest(db, uuid.parse(r.params.id), r.actor);
      }),
  );
  post(
    "/api/v1/orders/:id/invoice-requests",
    requestBody,
    "从已有业务依据准备开票申请，不开具发票",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        return prepareInvoice(db, r.actor, uuid.parse(r.params.id), b, r.id);
      }),
  );
  post(
    "/api/v1/invoice-requests/:id/confirm",
    z.object({
      version: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2000),
    }),
    "人工核验开票申请，不提交税务平台",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        role(r.actor, "owner", "reviewer");
        const ref = await one(
          db,
          "SELECT order_id FROM invoice_requests WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        const o = await order(db, ref.order_id),
          c = await company(db, o.company_id);
        const draft = await one(
          db,
          "SELECT * FROM invoice_requests WHERE id=$1 FOR UPDATE",
          [r.params.id],
        );
        independent(o, r.actor);
        if (
          draft.actor_id === r.actor.id ||
          o.assignee_id === r.actor.id ||
          o.contributors.includes(r.actor.id)
        )
          fail(403, "开票申请须由未参与本批经办的人员核验");
        if (draft.version !== b.version || draft.status !== "draft")
          fail(409, "申请已改变，请刷新");
        if (
          !c.active ||
          o.status !== "processing" ||
          o.input_revision !== draft.input_revision
        )
          fail(409, "输入或工作单状态已改变，请重新准备申请");
        const files = await sourceFiles(
          db,
          o,
          draft.source_files.map((f: any) => f.id),
        );
        if (
          draft.source_files.some(
            (f: any) =>
              !files.some(
                (current: any) =>
                  current.id === f.id &&
                  current.version === f.version &&
                  current.sha256 === f.sha256,
              ),
          )
        )
          fail(409, "开票依据已改变");
        await checkAuthorization(
          db,
          o.company_id,
          draft.authorization_id
            ? {
                id: draft.authorization_id,
                version: draft.authorization_version,
              }
            : null,
          draft.payload,
          "prepare_applications",
          true,
        );
        const report = await checks(db, o, draft.payload);
        if (report.issues.length) fail(409, "开票资料仍有缺项或差异，不能确认");
        await db.query(
          "UPDATE invoice_requests SET status='ready',version=version+1,confirmed_by=$1,confirmed_at=now() WHERE id=$2",
          [r.actor.id, draft.id],
        );
        await audit(
          db,
          r.actor,
          "invoice_request_confirmed",
          draft.id,
          o.company_id,
          {
            reason: b.reason,
            version: draft.version,
            digest: sha(
              canonical({
                payload: draft.payload,
                sourceFiles: draft.source_files,
                inputRevision: draft.input_revision,
              }),
            ),
          },
          r.id,
        );
        return readRequest(db, draft.id, r.actor);
      }),
  );
  post(
    "/api/v1/invoice-requests/:id/withdraw",
    z.object({
      version: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2000),
    }),
    "撤回尚未提交平台的开票申请",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const ref = await one(
          db,
          "SELECT order_id FROM invoice_requests WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        const o = await order(db, ref.order_id);
        const draft = await one(
          db,
          "SELECT * FROM invoice_requests WHERE id=$1 FOR UPDATE",
          [r.params.id],
        );
        if (draft.actor_id !== r.actor.id && r.actor.role !== "owner")
          fail(403, "只有原经办或负责人可撤回申请");
        await assertInvoiceEditable(db, draft.id);
        if (draft.version !== b.version || draft.status === "withdrawn")
          fail(409, "申请已改变，请刷新");
        await db.query(
          "UPDATE invoice_requests SET status='withdrawn',version=version+1,confirmed_by=NULL,confirmed_at=NULL WHERE id=$1",
          [draft.id],
        );
        await audit(
          db,
          r.actor,
          "invoice_request_withdrawn",
          draft.id,
          o.company_id,
          { reason: b.reason },
          r.id,
        );
        return { id: draft.id, status: "withdrawn" };
      }),
  );
}
