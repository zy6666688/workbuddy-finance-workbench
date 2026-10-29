import { readBatchActions } from "./invoice-continuation.js";
import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
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
  independent,
  touch,
} from "./core.js";
import {
  authorizationRef,
  authorizationState,
  checkAuthorization,
  evidenceFiles,
  resultState,
  chinaDay,
} from "./invoice-agency.js";
import {
  prepareInvoice,
  requestBody,
  readRequest,
  checks,
} from "./invoice-routes.js";

const text = (n: number) => z.string().trim().min(1).max(n);
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const reviewBody = z
  .object({ version: z.number().int().positive(), reason: text(2000) })
  .strict();
const evidenceIds = z.array(uuid).min(1).max(20);
const authorizationPayload = z
  .object({
    sellerName: text(200),
    sellerTaxId: text(30),
    agencyName: text(200),
    representative: text(100),
    region: text(100),
    channelLabel: text(100),
    validFrom: z.iso.date(),
    validUntil: z.iso.date(),
    scopes: z
      .array(z.enum(["prepare_applications", "record_results"]))
      .min(1)
      .max(2),
    note: text(2000),
  })
  .strict()
  .refine((x) => x.validFrom <= x.validUntil, "授权截止日期不得早于起始日期");
const money = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/);
const resultPayload = z
  .object({
    outcome: z.enum(["issued", "failed", "unknown"]),
    channelLabel: text(100),
    externalRef: z.string().trim().max(100).default(""),
    invoiceNumber: z.string().trim().max(100).default(""),
    invoiceCode: z.string().trim().max(30).default(""),
    invoiceDate: z.union([z.iso.date(), z.literal("")]).default(""),
    sellerTaxId: text(30),
    buyerName: text(200),
    buyerTaxId: z.string().trim().max(30).default(""),
    net: z.union([money, z.literal("")]).default(""),
    tax: z.union([money, z.literal("")]).default(""),
    gross: z.union([money, z.literal("")]).default(""),
    note: text(2000),
  })
  .strict();

async function requestLock(db: any, actor: any, area: string, key: string) {
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `${actor.org_id}/${actor.id}/${area}/${key}`,
  ]);
}
async function readAuthorization(db: any, id: string, actor: any) {
  const row = await one(
    db,
    "SELECT * FROM invoice_authorizations WHERE id=$1",
    [id],
  );
  const active = (await company(db, row.company_id)).active;
  return {
    ...row,
    state: active ? authorizationState(row) : "company_inactive",
    platformAuthorized: false,
    canVerify:
      active &&
      ["owner", "reviewer"].includes(actor.role) &&
      row.actor_id !== actor.id &&
      row.payload.validUntil >= chinaDay() &&
      row.status === "draft",
    canRevoke:
      row.status !== "revoked" &&
      (actor.role === "owner" ||
        actor.id === row.actor_id ||
        actor.id === row.reviewed_by),
    history: (
      await db.query(
        "SELECT action,actor_id,details,created_at FROM audit_events WHERE company_id=$1 AND target_id=$2 ORDER BY created_at,id",
        [row.company_id, id],
      )
    ).rows,
  };
}
async function readBatch(db: any, id: string, actor: any) {
  return readBatchActions(db, id, actor);
}
async function validateResult(
  db: any,
  draft: any,
  o: any,
  payload: any,
  authorization: any,
) {
  if (
    !(await company(db, o.company_id)).active ||
    o.status !== "processing" ||
    draft.status !== "ready" ||
    draft.input_revision !== o.input_revision
  )
    fail(409, "申请须已独立核验，且客户、工作单和原始资料版本仍有效");
  await checkAuthorization(
    db,
    o.company_id,
    authorization,
    draft.payload,
    "record_results",
    true,
  );
  const report = await checks(db, o, draft.payload);
  if (report.issues.length) fail(409, "申请当前资料有缺项或身份差异，请先核实");
  if (
    payload.sellerTaxId !== draft.payload.sellerTaxId ||
    payload.buyerName !== draft.payload.buyerName ||
    payload.buyerTaxId !== draft.payload.buyerTaxId
  )
    fail(409, "回录的购销方与已核验申请不一致，请核实回执归属");
  if (payload.outcome === "issued") {
    if (
      !payload.invoiceNumber ||
      !payload.invoiceDate ||
      payload.invoiceDate > chinaDay()
    )
      fail(400, "成功回录需填写实际发票号码及不晚于今日（北京时间）的开票日期");
    for (const k of ["net", "tax", "gross"] as const)
      if (
        !payload[k] ||
        !report.totals ||
        !new Decimal(payload[k]).equals(report.totals[k])
      )
        fail(
          409,
          "回录金额必须与申请逐项一致；差额、部分开票或红冲须另行核实，不能标记成功",
        );
  } else if (
    payload.invoiceNumber ||
    payload.invoiceCode ||
    payload.invoiceDate ||
    payload.net ||
    payload.tax ||
    payload.gross
  )
    fail(
      400,
      "失败或结果不明时请将票号、开票日期和金额留空，在说明及凭证中记录实际情况",
    );
}

export function invoiceAgencyRoutes(get: any, post: any) {
  get(
    "/api/v1/companies/:id/invoice-authorizations",
    "逐户授权登记及有效状态",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        await company(db, uuid.parse(r.params.id));
        const q = pagination.parse(r.query);
        const rows = (
          await db.query(
            "SELECT id FROM invoice_authorizations WHERE company_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
            [r.params.id, q.limit, q.offset],
          )
        ).rows;
        return Promise.all(
          rows.map((x) => readAuthorization(db, x.id, r.actor)),
        );
      }),
  );
  get(
    "/api/v1/invoice-authorizations/:id",
    "客户授权记录及留痕",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        return readAuthorization(db, uuid.parse(r.params.id), r.actor);
      }),
  );
  post(
    "/api/v1/orders/:id/invoice-authorizations",
    z
      .object({
        key: uuid,
        payload: authorizationPayload,
        evidenceFileIds: evidenceIds,
      })
      .strict(),
    "登记客户授权草稿，不建立税务平台授权",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const o = await order(db, r.params.id);
        const fingerprint = sha(
          canonical({
            payload: b.payload,
            evidenceFileIds: [...new Set(b.evidenceFileIds)].sort(),
          }),
        );
        const prior = (
          await db.query(
            "SELECT id,fingerprint FROM invoice_authorizations WHERE order_id=$1 AND actor_id=$2 AND request_key=$3",
            [o.id, r.actor.id, b.key],
          )
        ).rows[0];
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(409, "请求标识已用于不同授权资料");
          return readAuthorization(db, prior.id, r.actor);
        }
        if (
          !(await company(db, o.company_id)).active ||
          o.status !== "processing"
        )
          fail(409, "请在有效客户的处理中工作单登记授权");
        // Identity comes from the fixed client dossier; monetary completeness is irrelevant here.
        const dossier = await one(
          db,
          "SELECT d.payload FROM client_dossier_bindings b JOIN client_dossier_revisions d ON d.id=b.revision_id WHERE b.company_id=$1 AND b.period=$2",
          [o.company_id, o.period],
        );
        if (
          dossier.payload.legalName !== b.payload.sellerName ||
          dossier.payload.creditCode !== b.payload.sellerTaxId
        )
          fail(409, "授权主体必须与本月固定客户档案一致");
        const files = await evidenceFiles(db, o.id, b.evidenceFileIds),
          id = randomUUID();
        await db.query(
          "INSERT INTO invoice_authorizations(id,org_id,company_id,order_id,actor_id,request_key,fingerprint,payload,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            id,
            r.actor.org_id,
            o.company_id,
            o.id,
            r.actor.id,
            b.key,
            fingerprint,
            JSON.stringify(b.payload),
            JSON.stringify(files),
          ],
        );
        await audit(
          db,
          r.actor,
          "invoice_authorization_prepared",
          id,
          o.company_id,
          { digest: fingerprint },
          r.id,
        );
        return readAuthorization(db, id, r.actor);
      }),
  );
  for (const action of ["verify", "revoke"] as const)
    post(
      `/api/v1/invoice-authorizations/:id/${action}`,
      reviewBody,
      "人工核验或撤销本地授权记录",
      async (r: any, b: any) =>
        tx(r.actor, async (db) => {
          writer(r.actor);
          const row = await one(
            db,
            "SELECT * FROM invoice_authorizations WHERE id=$1 FOR UPDATE",
            [uuid.parse(r.params.id)],
          );
          if (row.version !== b.version || row.status === "revoked")
            fail(409, "授权记录已变化，请刷新");
          if (action === "verify") {
            role(r.actor, "owner", "reviewer");
            if (row.actor_id === r.actor.id)
              fail(403, "授权须由另一名人员核验");
            if (
              row.status !== "draft" ||
              !(await company(db, row.company_id)).active ||
              row.payload.validUntil < chinaDay()
            )
              fail(409, "授权状态或有效期不允许核验");
            const files = await evidenceFiles(
              db,
              row.order_id,
              row.evidence.map((x: any) => x.id),
            );
            if (
              row.evidence.some(
                (x: any) =>
                  !files.some(
                    (f: any) =>
                      f.id === x.id &&
                      f.sha256 === x.sha256 &&
                      f.version === x.version,
                  ),
              )
            )
              fail(409, "授权凭证已变化");
          } else if (
            r.actor.role !== "owner" &&
            r.actor.id !== row.actor_id &&
            r.actor.id !== row.reviewed_by
          )
            fail(403, "只有负责人、登记人或核验人可撤销授权");
          await db.query(
            "UPDATE invoice_authorizations SET status=$2,version=version+1,reviewed_by=$3,reviewed_at=now() WHERE id=$1",
            [row.id, action === "verify" ? "verified" : "revoked", r.actor.id],
          );
          await audit(
            db,
            r.actor,
            `invoice_authorization_${action}`,
            row.id,
            row.company_id,
            { reason: b.reason, fromVersion: row.version },
            r.id,
          );
          return readAuthorization(db, row.id, r.actor);
        }),
    );

  const batchItem = requestBody.extend({
    orderId: uuid,
    itemKey: uuid,
    authorization: authorizationRef,
  });
  post(
    "/api/v1/invoice-batches",
    z
      .object({
        key: uuid,
        title: text(200),
        items: z.array(batchItem).min(1).max(50),
      })
      .strict(),
    "逐户准备批量开票申请，单项缺项独立返回",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        await requestLock(db, r.actor, "invoice_batch", b.key);
        const fingerprint = sha(canonical({ title: b.title, items: b.items }));
        const prior = (
          await db.query(
            "SELECT id,fingerprint FROM invoice_batches WHERE actor_id=$1 AND request_key=$2",
            [r.actor.id, b.key],
          )
        ).rows[0];
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(409, "批次标识已用于不同内容");
          return readBatch(db, prior.id, r.actor);
        }
        if (new Set(b.items.map((x: any) => x.itemKey)).size !== b.items.length)
          fail(400, "批次内每项必须有不同的 itemKey");
        if (
          new Set(b.items.map((x: any) => `${x.orderId}/${x.key}`)).size !==
          b.items.length
        )
          fail(400, "同一工作单的每项申请须使用不同的请求 key");
        // Lock in stable order. Capture base versions before this batch's own touch() calls.
        const orders = new Map<string, any>();
        for (const id of [
          ...new Set<string>(b.items.map((x: any) => x.orderId)),
        ].sort())
          orders.set(id, await order(db, id));
        const id = randomUUID();
        await db.query(
          "INSERT INTO invoice_batches(id,org_id,actor_id,request_key,fingerprint,title) VALUES($1,$2,$3,$4,$5,$6)",
          [id, r.actor.org_id, r.actor.id, b.key, fingerprint, b.title],
        );
        for (const item of b.items) {
          const base = orders.get(item.orderId);
          let requestId = null,
            error = null;
          await db.query("SAVEPOINT invoice_item");
          try {
            if (item.version !== base.version)
              fail(409, "工作单版本已变化，请刷新后仅补办失败项");
            const current = await order(db, item.orderId);
            const prepared = await prepareInvoice(
              db,
              r.actor,
              item.orderId,
              { ...item, version: current.version },
              r.id,
            );
            requestId = prepared.id;
            await db.query("RELEASE SAVEPOINT invoice_item");
          } catch (e: any) {
            await db.query("ROLLBACK TO SAVEPOINT invoice_item");
            await db.query("RELEASE SAVEPOINT invoice_item");
            if ([400, 403, 404, 409].includes(e.statusCode)) error = e.message;
            else if (
              e.code === "23505" &&
              e.constraint === "invoice_request_business"
            )
              error = "业务申请已存在，请先查询原申请，勿重复创建";
            else throw e;
          }
          await db.query(
            "INSERT INTO invoice_batch_items(id,org_id,company_id,order_id,batch_id,item_key,request_id,status,error,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
            [
              randomUUID(),
              r.actor.org_id,
              base.company_id,
              base.id,
              id,
              item.itemKey,
              requestId,
              requestId ? "prepared" : "blocked",
              error,
              JSON.stringify(item),
            ],
          );
          await audit(
            db,
            r.actor,
            "invoice_batch_item_prepared",
            id,
            base.company_id,
            { itemKey: item.itemKey, requestId, error },
            r.id,
          );
        }
        return readBatch(db, id, r.actor);
      }),
  );
  get(
    "/api/v1/invoice-batches",
    "批量申请列表（仅当前可访问客户）",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const q = pagination
          .extend({ orderId: uuid.optional() })
          .parse(r.query);
        return (
          await db.query(
            "SELECT b.id,b.title,b.created_at,count(*)::integer AS visible_items,count(*) FILTER(WHERE i.status='blocked')::integer AS blocked FROM invoice_batches b JOIN invoice_batch_items i ON i.batch_id=b.id WHERE ($1::uuid IS NULL OR i.order_id=$1) GROUP BY b.id ORDER BY b.created_at DESC,b.id LIMIT $2 OFFSET $3",
            [q.orderId || null, q.limit, q.offset],
          )
        ).rows;
      }),
  );
  get("/api/v1/invoice-batches/:id", "批量申请逐项进度与结果", async (r: any) =>
    tx(r.actor, async (db) => {
      writer(r.actor);
      return readBatch(db, uuid.parse(r.params.id), r.actor);
    }),
  );

  get(
    "/api/v1/invoice-requests/:id/result-records",
    "分页查询实际结果回录及核验状态",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const draft = await one(
            db,
            "SELECT * FROM invoice_requests WHERE id=$1",
            [uuid.parse(r.params.id)],
          ),
          q = pagination.parse(r.query);
        const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
          draft.order_id,
        ]);
        const rows = (
          await db.query(
            `SELECT rr.*,(SELECT a.details->>'reason' FROM audit_events a
              WHERE a.company_id=rr.company_id AND a.target_id=rr.request_id::text
                AND a.action IN ('invoice_request_result_verify','invoice_request_result_reject')
                AND a.details->>'recordId'=rr.id::text ORDER BY a.created_at DESC,a.id DESC LIMIT 1) AS review_reason
              FROM invoice_result_records rr WHERE rr.request_id=$1 ORDER BY rr.record_index DESC LIMIT $2 OFFSET $3`,
            [draft.id, q.limit, q.offset],
          )
        ).rows;
        return rows.map((x) => ({
          ...x,
          canReview:
            x.status === "pending" &&
            ["owner", "reviewer"].includes(r.actor.role) &&
            x.actor_id !== r.actor.id &&
            o.assignee_id !== r.actor.id &&
            !o.contributors.includes(r.actor.id) &&
            o.submission?.submittedBy !== r.actor.id &&
            (r.actor.role === "owner" || o.reviewer_id === r.actor.id),
          taxAuthorityVerified: false,
        }));
      }),
  );
  post(
    "/api/v1/invoice-requests/:id/result-records",
    z
      .object({
        key: uuid,
        version: z.number().int().positive(),
        authorization: authorizationRef,
        payload: resultPayload,
        evidenceFileIds: evidenceIds,
      })
      .strict(),
    "保存实际开票结果及回执草稿，不执行开票",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const ref = await one(
            db,
            "SELECT order_id FROM invoice_requests WHERE id=$1",
            [uuid.parse(r.params.id)],
          ),
          o = await order(db, ref.order_id);
        const draft = await one(
          db,
          "SELECT * FROM invoice_requests WHERE id=$1 FOR UPDATE",
          [r.params.id],
        );
        const fingerprint = sha(
          canonical({
            version: b.version,
            authorization: b.authorization,
            payload: b.payload,
            evidenceFileIds: [...new Set(b.evidenceFileIds)].sort(),
          }),
        );
        const prior = (
          await db.query(
            "SELECT * FROM invoice_result_records WHERE request_id=$1 AND actor_id=$2 AND request_key=$3",
            [draft.id, r.actor.id, b.key],
          )
        ).rows[0];
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(409, "回录标识已用于不同内容");
          return prior;
        }
        if (draft.version !== b.version) fail(409, "申请版本已变化，请刷新");
        const state = await resultState(db, draft.id);
        if (state.pending || state.issued)
          fail(409, "已有待核验或成功回录；先查看现有记录，不要重复回录");
        await validateResult(db, draft, o, b.payload, b.authorization);
        const evidence = await evidenceFiles(db, o.id, b.evidenceFileIds),
          id = randomUUID();
        await db.query(
          "INSERT INTO invoice_result_records(id,org_id,company_id,order_id,request_id,actor_id,request_key,fingerprint,request_version,authorization_id,authorization_version,snapshot,payload,evidence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
          [
            id,
            r.actor.org_id,
            o.company_id,
            o.id,
            draft.id,
            r.actor.id,
            b.key,
            fingerprint,
            draft.version,
            b.authorization.id,
            b.authorization.version,
            JSON.stringify(draft),
            JSON.stringify(b.payload),
            JSON.stringify(evidence),
          ],
        );
        await touch(db, o, r.actor);
        await audit(
          db,
          r.actor,
          "invoice_request_result_prepared",
          draft.id,
          o.company_id,
          { recordId: id, digest: fingerprint, outcome: b.payload.outcome },
          r.id,
        );
        return one(db, "SELECT * FROM invoice_result_records WHERE id=$1", [
          id,
        ]);
      }),
  );
  for (const action of ["verify", "reject"] as const)
    post(
      `/api/v1/invoice-result-records/:id/${action}`,
      reviewBody,
      "独立核验实际回执，不在线查验或自动入账",
      async (r: any, b: any) =>
        tx(r.actor, async (db) => {
          role(r.actor, "owner", "reviewer");
          const ref = await one(
              db,
              "SELECT * FROM invoice_result_records WHERE id=$1",
              [uuid.parse(r.params.id)],
            ),
            o = await order(db, ref.order_id);
          const draft = await one(
            db,
            "SELECT * FROM invoice_requests WHERE id=$1 FOR UPDATE",
            [ref.request_id],
          );
          const row = await one(
            db,
            "SELECT * FROM invoice_result_records WHERE id=$1 FOR UPDATE",
            [ref.id],
          );
          independent(o, r.actor);
          if (row.actor_id === r.actor.id)
            fail(403, "回录结果须由另一名未参与经办的人员核验");
          if (row.version !== b.version || row.status !== "pending")
            fail(409, "回录已处理，请刷新");
          if (action === "verify") {
            if (draft.version !== row.request_version)
              fail(409, "申请已变化，不可核验旧回录");
            await validateResult(db, draft, o, row.payload, {
              id: row.authorization_id,
              version: row.authorization_version,
            });
            const files = await evidenceFiles(
              db,
              o.id,
              row.evidence.map((x: any) => x.id),
            );
            if (
              row.evidence.some(
                (x: any) =>
                  !files.some(
                    (f: any) =>
                      f.id === x.id &&
                      f.sha256 === x.sha256 &&
                      f.version === x.version,
                  ),
              )
            )
              fail(409, "回执凭证已变化");
          }
          await db.query(
            "UPDATE invoice_result_records SET status=$2,version=version+1,reviewed_by=$3,reviewed_at=now() WHERE id=$1",
            [row.id, action === "verify" ? "verified" : "rejected", r.actor.id],
          );
          await audit(
            db,
            r.actor,
            `invoice_request_result_${action}`,
            draft.id,
            o.company_id,
            {
              recordId: row.id,
              reason: b.reason,
              outcome: row.payload.outcome,
            },
            r.id,
          );
          return readRequest(db, draft.id, r.actor);
        }),
    );
}
