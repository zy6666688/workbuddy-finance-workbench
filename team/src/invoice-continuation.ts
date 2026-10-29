import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  tx,
  one,
  order,
  company,
  writer,
  uuid,
  fail,
  audit,
  canonical,
  sha,
} from "./core.js";
import {
  requestBody,
  readRequest,
  prepareInvoice,
  reviseInvoice,
} from "./invoice-routes.js";
import { authorizationRef } from "./invoice-agency.js";
import {
  accountingContext,
  registerInvoiceLedger,
  prepareAccountingDraft,
  readAccountingDraft,
  lockAccountingCompany,
} from "./invoice-accounting.js";

const base = {
  itemId: uuid,
  expectedAttemptId: uuid.nullable(),
  orderVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(2000),
};
const changes = requestBody
  .pick({ sourceFileIds: true, payload: true })
  .extend({ authorization: authorizationRef })
  .strict();
export const continuationItem = z.discriminatedUnion("action", [
  z
    .object({
      ...base,
      action: z.literal("repair"),
      requestVersion: z.number().int().positive(),
      changes,
    })
    .strict(),
  z.object({ ...base, action: z.literal("retry"), changes }).strict(),
  z
    .object({
      ...base,
      action: z.literal("ledger"),
      requestVersion: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      ...base,
      action: z.literal("accounting"),
      requestVersion: z.number().int().positive(),
      draftVersion: z.number().int().min(0),
      context: accountingContext,
    })
    .strict(),
]);
export const continuationBody = z
  .object({ key: uuid, items: z.array(continuationItem).min(1).max(50) })
  .strict();

export async function itemReferences(db: any, item: any) {
  const latest =
    (
      await db.query(
        "SELECT * FROM invoice_continuation_items WHERE item_id=$1 ORDER BY attempt_index DESC LIMIT 1",
        [item.id],
      )
    ).rows[0] || null;
  const linked = (
    await db.query(
      "SELECT request_id FROM invoice_continuation_items WHERE item_id=$1 AND request_id IS NOT NULL ORDER BY attempt_index DESC LIMIT 1",
      [item.id],
    )
  ).rows[0];
  return { latest, requestId: linked?.request_id || item.request_id || null };
}
export async function readBatchActions(db: any, batchId: string, actor: any) {
  const batch = await one(db, "SELECT * FROM invoice_batches WHERE id=$1", [
    batchId,
  ]);
  const items = (
    await db.query(
      "SELECT i.*,c.name AS company_name,c.active AS company_active FROM invoice_batch_items i JOIN companies c ON c.id=i.company_id WHERE i.batch_id=$1 ORDER BY i.created_at,i.id",
      [batchId],
    )
  ).rows;
  for (const item of items) {
    const refs = await itemReferences(db, item);
    const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
      item.order_id,
    ]);
    const request = refs.requestId
      ? await readRequest(db, refs.requestId, actor)
      : null;
    const ledger = request?.results.issued
      ? (
          await db.query("SELECT * FROM invoice_ledger WHERE result_id=$1", [
            request.results.issued.id,
          ])
        ).rows[0] || null
      : null;
    const d = ledger
      ? (
          await db.query(
            "SELECT id FROM invoice_accounting_drafts WHERE ledger_id=$1 ORDER BY version DESC LIMIT 1",
            [ledger.id],
          )
        ).rows[0]
      : null;
    const draft = d ? await readAccountingDraft(db, d.id, actor) : null;
    let group = "retry_available",
      allowed: string[] = ["retry"];
    if (request) {
      allowed = [];
      if (request.results.pending) group = "receipt_review";
      else if (request.results.issued) {
        group =
          draft?.status === "verified"
            ? "handoff_ready"
            : draft?.status === "pending" && !draft.stale
              ? "draft_review"
              : "accounting_materials";
        if (!ledger) allowed.push("ledger");
        if (!draft || draft.canRevise) allowed.push("accounting");
      } else if (request.results.latest?.payload.outcome === "unknown")
        group = "receipt_unknown";
      else if (request.results.latest?.payload.outcome === "failed")
        group = "receipt_failed";
      else if (request.status === "withdrawn") group = "withdrawn";
      else if (
        request.stale ||
        request.currentChecks.issues.length ||
        !request.authorization.valid
      ) {
        group = "application_materials";
        if (request.canEdit) allowed.push("repair");
      } else if (request.status === "draft") group = "application_review";
      else if (request.results.rejected) group = "receipt_correction";
      else group = "awaiting_receipt";
    }
    if (o.status !== "processing" || !item.company_active) allowed = [];
    item.availabilityIssue = !item.company_active
      ? "客户已停用，只保留历史查询"
      : o.status !== "processing"
        ? "工作单不在经办阶段，本页仅查看历史及成果"
        : "";
    item.orderPeriod = o.period;
    item.originalStatus = item.status;
    item.request = request;
    item.ledger = ledger
      ? {
          id: ledger.id,
          result_id: ledger.result_id,
          created_at: ledger.created_at,
        }
      : null;
    // Batch progress must not repeat a complete 2 MB chart/source snapshot for every item.
    item.accountingDraft = draft
      ? {
          id: draft.id,
          number: draft.number,
          version: draft.version,
          period: draft.period,
          status: draft.status,
          context: draft.context,
          stale: draft.stale,
          currentIssues: draft.currentIssues,
          review_reason: draft.review_reason,
          canRevise: draft.canRevise,
          canReview: draft.canReview,
          canExport: draft.canExport,
        }
      : null;
    item.group = group;
    item.allowedActions = allowed;
    const feedback: { field: string; message: string }[] = [];
    if (request?.results.rejected)
      feedback.push({
        field: "receiptReview",
        message: `回录已驳回：${request.results.rejected.reason || "请查阅核验意见"}。沿用原回录资料修正，原记录保留，不是重新开票。`,
      });
    if (group === "application_materials") {
      feedback.push(...request.currentChecks.issues);
      if (request.stale)
        feedback.push({
          field: "requestVersion",
          message: "申请依据版本已变化，请核实新资料并修订选中的原申请。",
        });
      if (!request.authorization.valid)
        feedback.push({
          field: "authorization",
          message:
            "客户授权缺失、失效或版本不符；先在工作单核实授权，再修订原申请绑定有效版本。",
        });
    }
    if (!request && (refs.latest?.error || item.error))
      feedback.push({
        field: "application",
        message: refs.latest?.error || item.error,
      });
    if (draft && draft.status !== "verified") {
      feedback.push(...draft.currentIssues);
      if (draft.status === "rejected" && draft.review_reason)
        feedback.push({
          field: "review",
          message: `复核驳回：${draft.review_reason}。原业务资料仍保留，请针对意见修订。`,
        });
      if (draft.stale)
        feedback.push({
          field: "draftVersion",
          message:
            "当前依据与草稿版本不一致或仍有缺项，请补齐并生成新版本后送独立复核。",
        });
    }
    item.feedback = feedback;
    // Failed attempts already store the user's input behind company RLS. Reuse
    // it only while the application/draft version has not been replaced.
    const previous =
      refs.latest?.status === "blocked" ? refs.latest.payload.input : null;
    const sameBusinessVersion =
      previous &&
      (previous.requestVersion === undefined ||
        previous.requestVersion === request?.version) &&
      (previous.draftVersion === undefined ||
        previous.draftVersion === (draft?.version || 0));
    item.resume =
      previous && allowed.includes(previous.action)
        ? {
            attemptId: refs.latest.id,
            action: previous.action,
            reason: previous.reason,
            changes: previous.changes || null,
            context: previous.context || null,
            canPrefill: !!sameBusinessVersion,
            message: sameBusinessVersion
              ? "上次失败前填写的内容已保留；核对补件、授权及最新版本后可继续，无需重填。"
              : "申请或账务草稿已有新版本，上次填写仍可查阅；请对照当前记录核实，不能直接覆盖。",
          }
        : null;
    const steps: Record<string, string> = {
      retry_available:
        "补齐本项缺项，读取最新预期版本后补办；发现同业务原申请时沿用原记录。",
      application_materials:
        "按缺项清单补件；上传资料后重新查询待办，仅修订明确选中的原申请。",
      application_review:
        "请独立人员进入本工作单核验开票申请；核验后再查批次待办。",
      awaiting_receipt:
        "等待实际开票结果；有真实回执后回录，本程序不会自动开具发票。",
      receipt_correction:
        "读取被驳回的回录及核验意见，沿用原资料补正后另存回录草稿，再由独立人员核验；不是重复开票。",
      receipt_review:
        "请独立人员进入本工作单核验实际回录；成功回录通过后才能登记台账。",
      receipt_unknown: "核实原渠道实际结果并继续回录原申请，不能重复申请。",
      receipt_failed:
        "核实失败原因并继续跟踪原申请，不能用申请补办触发重新开具。",
      accounting_materials:
        "核实本期科目、业务依据和是否已入账；缺规则时准备规则并交独立人员核验，再准备或修订草稿。",
      draft_review: "请独立人员复核本记账草稿；通过后可下载交接成果。",
      handoff_ready: "可下载已核验的 XLSX 或 JSON 交接成果；不代表已过账。",
      withdrawn: "申请已撤回，保留历史；需人工核实后续安排。",
    };
    item.nextStep = {
      kind: group,
      message:
        group === "handoff_ready"
          ? steps[group]
          : item.availabilityIssue || steps[group],
      orderId: o.id,
      requestId: request?.id || null,
      resultId:
        request?.results.pending?.id ||
        request?.results.issued?.id ||
        request?.results.rejected?.id ||
        null,
      draftId: draft?.id || null,
      requiresHumanReview: [
        "application_review",
        "receipt_review",
        "draft_review",
      ].includes(group),
      canContinue: allowed.length > 0,
      progressTool: "team_invoice_batch_actions",
      batchId,
    };
    item.handoff = draft?.canExport
      ? {
          draftId: draft.id,
          tool: "team_download_invoice_accounting",
          formats: ["xlsx", "json"],
          stale: draft.stale,
          posted: false,
        }
      : null;
    item.latestAttempt = refs.latest;
    item.expected = {
      attemptId: refs.latest?.id || null,
      orderVersion: o.version,
      requestVersion: request?.version || null,
      draftVersion: draft?.version || 0,
    };
    item.attempts = (
      await db.query(
        "SELECT a.*,c.actor_id FROM invoice_continuation_items a JOIN invoice_continuations c ON c.id=a.continuation_id WHERE a.item_id=$1 ORDER BY a.attempt_index DESC LIMIT 30",
        [item.id],
      )
    ).rows;
    item.attemptsTruncated = item.attempts.length === 30;
  }
  return {
    ...batch,
    items,
    visibleItems: items.length,
    prepared: items.filter((i: any) => !!i.request).length,
    blocked: items.filter((i: any) => !i.request).length,
    recordedIssued: items.filter((i: any) => i.request?.recordedIssued).length,
    groups: Object.fromEntries(
      [...new Set<string>(items.map((i: any) => i.group))].map((g) => [
        g,
        items.filter((i: any) => i.group === g).length,
      ]),
    ),
    canIssue: false,
    posted: false,
    note: "仅统计当前可访问项目；补办成功表示申请保存成功，交接成果不代表已过账。",
  };
}

async function readContinuation(db: any, id: string) {
  const row = await one(db, "SELECT * FROM invoice_continuations WHERE id=$1", [
    id,
  ]);
  const items = (
    await db.query(
      "SELECT * FROM invoice_continuation_items WHERE continuation_id=$1 ORDER BY attempt_index",
      [id],
    )
  ).rows;
  // Header visibility does not grant access to a customer's item payload.
  // Replays must preserve RLS filtering without presenting a partial receipt as complete.
  const scopeComplete = items.length === row.item_count;
  return {
    ...row,
    items,
    totalItems: row.item_count,
    visibleItems: items.length,
    scopeComplete,
    progressQuery: {
      tool: "team_invoice_batch_actions",
      batchId: row.batch_id,
    },
    note: scopeComplete
      ? "本回执记录原操作结果，当前业务进度请查询批次待办；操作完成不代表已开票、已复核或已入账。"
      : "部分项目当前无权访问，仅返回可访问结果；不能据此判断整批完成，也不要重新补办不可见项目。",
    posted: false,
  };
}
export function invoiceContinuationRoutes(get: any, post: any) {
  get(
    "/api/v1/invoice-batches/:id/actions",
    "逐项续办待办、版本及历史",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        return readBatchActions(db, uuid.parse(r.params.id), r.actor);
      }),
  );
  get(
    "/api/v1/invoice-continuations/:id",
    "读取原续办结果，不重复处理",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        return readContinuation(db, uuid.parse(r.params.id));
      }),
  );
  post(
    "/api/v1/invoice-batches/:id/continue",
    continuationBody,
    "对明确选中的项目补件、补办或准备账务草稿",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const batch = await one(
          db,
          "SELECT * FROM invoice_batches WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `invoice-continue/${batch.id}/${r.actor.id}/${b.key}`,
        ]);
        const fingerprint = sha(canonical(b.items));
        const prior = (
          await db.query(
            "SELECT id,fingerprint FROM invoice_continuations WHERE batch_id=$1 AND actor_id=$2 AND request_key=$3",
            [batch.id, r.actor.id, b.key],
          )
        ).rows[0];
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(409, "续办标识已用于其他内容，请勿修改原请求后重试");
          return readContinuation(db, prior.id);
        }
        if (new Set(b.items.map((x: any) => x.itemId)).size !== b.items.length)
          fail(400, "同一次续办不能重复选中同一批次项");
        const targets = (
          await db.query(
            "SELECT * FROM invoice_batch_items WHERE batch_id=$1 AND id=ANY($2::uuid[])",
            [batch.id, b.items.map((x: any) => x.itemId)],
          )
        ).rows;
        if (targets.length !== b.items.length)
          fail(404, "所选项目不存在、不属于该批次或无权访问");
        for (const cid of [
          ...new Set<string>(targets.map((x: any) => x.company_id)),
        ].sort())
          await lockAccountingCompany(db, cid);
        const orders = new Map<string, any>();
        for (const oid of [
          ...new Set<string>(targets.map((x: any) => x.order_id)),
        ].sort())
          orders.set(oid, await order(db, oid));
        const id = randomUUID();
        await db.query(
          "INSERT INTO invoice_continuations(id,org_id,batch_id,actor_id,request_key,fingerprint,item_count) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            r.actor.org_id,
            batch.id,
            r.actor.id,
            b.key,
            fingerprint,
            b.items.length,
          ],
        );
        for (const input of b.items) {
          const item = targets.find((x: any) => x.id === input.itemId)!,
            o = orders.get(item.order_id),
            refs = await itemReferences(db, item);
          let requestId = refs.requestId,
            ledgerId = null,
            draftId = null,
            error = null,
            outcome: any = {};
          await db.query("SAVEPOINT invoice_continue_item");
          try {
            if (
              (refs.latest?.id || null) !== input.expectedAttemptId ||
              o.version !== input.orderVersion
            )
              fail(409, "该项目尝试记录或工作单版本已变化，请刷新待办后续办");
            if (o.status !== "processing") fail(409, "工作单不在经办阶段");
            if (!(await company(db, item.company_id)).active)
              fail(409, "客户已停用，不能续办");
            const key = randomUUID();
            if (input.action === "retry") {
              if (requestId)
                fail(
                  409,
                  `该项目已有申请 ${requestId}，请查看并修订原申请，不能重新补办`,
                );
              const existing = (
                await db.query(
                  "SELECT * FROM invoice_requests WHERE company_id=$1 AND business_ref=$2 AND status<>'withdrawn'",
                  [item.company_id, item.payload.businessRef],
                )
              ).rows[0];
              if (existing) {
                if (existing.order_id !== o.id)
                  fail(
                    409,
                    `该业务已关联其他工作单的申请 ${existing.id}，请核实原申请`,
                  );
                requestId = existing.id;
                outcome = {
                  state: "linked_existing",
                  message:
                    "发现已有同业务申请，已关联原记录；本次修正内容没有覆盖原申请，请查询后按需修订。",
                };
              } else {
                const current = await order(db, o.id);
                const prepared = await prepareInvoice(
                  db,
                  r.actor,
                  o.id,
                  {
                    ...input.changes,
                    businessRef: item.payload.businessRef,
                    version: current.version,
                    key,
                  },
                  r.id,
                );
                requestId = prepared.id;
                outcome = {
                  state: prepared.stage,
                  message: prepared.nextAction,
                };
              }
            } else {
              if (!requestId) fail(409, "该项目尚未保存申请，请先补办");
              const request = await readRequest(db, requestId, r.actor);
              if (request.version !== input.requestVersion)
                fail(409, "申请版本已变化，请刷新");
              if (input.action === "repair") {
                const prepared = await reviseInvoice(
                  db,
                  r.actor,
                  requestId,
                  {
                    ...input.changes,
                    version: input.requestVersion,
                    reason: input.reason,
                    key,
                  },
                  r.id,
                );
                outcome = {
                  state: prepared.stage,
                  message: prepared.nextAction,
                };
              } else {
                const ledger = await registerInvoiceLedger(
                  db,
                  r.actor,
                  requestId,
                  r.id,
                );
                ledgerId = ledger.id;
                outcome = {
                  state: "ledger_registered",
                  message: "回执已登记台账，未入账。",
                };
                if (input.action === "accounting") {
                  const draft = await prepareAccountingDraft(
                    db,
                    r.actor,
                    ledger.id,
                    {
                      key,
                      version: input.draftVersion,
                      context: input.context,
                    },
                    r.id,
                  );
                  draftId = draft.id;
                  outcome = {
                    state: draft.status,
                    message:
                      draft.status === "blocked"
                        ? "账务草稿仍有缺项，查看 issues 后补充。"
                        : "记账草稿已准备，等待独立复核。",
                    issues: draft.currentIssues,
                  };
                }
              }
            }
            await db.query("RELEASE SAVEPOINT invoice_continue_item");
          } catch (e: any) {
            await db.query("ROLLBACK TO SAVEPOINT invoice_continue_item");
            await db.query("RELEASE SAVEPOINT invoice_continue_item");
            requestId = refs.requestId;
            ledgerId = null;
            draftId = null;
            outcome = {};
            if ([400, 403, 404, 409].includes(e.statusCode)) error = e.message;
            else if (
              e.code === "23505" &&
              [
                "invoice_request_business",
                "invoice_accounting_voucher_claim",
              ].includes(e.constraint)
            )
              error = "该业务或凭证已有记录，请刷新并核实原记录，勿重复创建";
            // Unexpected integrity errors are technical faults: roll back the entire request.
            else throw e;
          }
          await db.query(
            "INSERT INTO invoice_continuation_items(id,org_id,company_id,continuation_id,item_id,action,status,request_id,ledger_id,draft_id,payload,error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
            [
              randomUUID(),
              r.actor.org_id,
              item.company_id,
              id,
              item.id,
              input.action,
              error ? "blocked" : "completed",
              requestId,
              ledgerId,
              draftId,
              JSON.stringify({ input, outcome }),
              error,
            ],
          );
          await audit(
            db,
            r.actor,
            "invoice_batch_continued",
            item.id,
            item.company_id,
            {
              continuationId: id,
              action: input.action,
              requestId,
              ledgerId,
              draftId,
              error,
              reason: input.reason,
            },
            r.id,
          );
        }
        return readContinuation(db, id);
      }),
  );
}
