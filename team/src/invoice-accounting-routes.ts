import ExcelJS from "exceljs";
import { z } from "zod";
import {
  tx,
  one,
  order,
  company,
  writer,
  role,
  uuid,
  period,
  fail,
  audit,
  independent,
  canonical,
} from "./core.js";
import {
  ruleBody,
  accountingDraftBody,
  prepareAccountingRule,
  readAccountingRule,
  accountingBasis,
  lockAccountingCompany,
  registerInvoiceLedger,
  prepareAccountingDraft,
  readAccountingDraft,
} from "./invoice-accounting.js";

const page = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(1000000).default(0),
});
const review = z
  .object({
    version: z.number().int().positive(),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export function invoiceAccountingRoutes(app: any, get: any, post: any) {
  get(
    "/api/v1/companies/:id/invoice-accounting-context",
    "读取本期科目来源及当前档案，不修改底稿",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const c = await company(db, uuid.parse(r.params.id)),
          p = period.parse(r.query.period),
          basis = await accountingBasis(db, c.id, p);
        return {
          companyId: c.id,
          period: p,
          snapshotId: basis.snapshot?.id || null,
          snapshotVersion: basis.snapshot?.version || 0,
          accounts: basis.snapshot?.payload.accounts || [],
          dossierId: basis.dossier?.id || null,
          vouchers: (basis.snapshot?.payload.vouchers || []).map((v: any) => ({
            number: v.number,
            date: v.date,
          })),
          posted: false,
        };
      }),
  );
  get(
    "/api/v1/companies/:id/invoice-accounting-rules",
    "分页读取客户记账规则及历史版本",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        await company(db, uuid.parse(r.params.id));
        const q = page
          .extend({ businessType: z.string().trim().max(100).optional() })
          .parse(r.query);
        const rows = (
          await db.query(
            "SELECT id FROM invoice_accounting_rules WHERE company_id=$1 AND ($2::text IS NULL OR business_type=$2) ORDER BY created_at DESC,version DESC,id LIMIT $3 OFFSET $4",
            [r.params.id, q.businessType || null, q.limit, q.offset],
          )
        ).rows;
        return Promise.all(
          rows.map((x) => readAccountingRule(db, x.id, r.actor)),
        );
      }),
  );
  get(
    "/api/v1/invoice-accounting-rules/:id",
    "记账规则完整内容及复核记录",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        return readAccountingRule(db, uuid.parse(r.params.id), r.actor);
      }),
  );
  post(
    "/api/v1/companies/:id/invoice-accounting-rules",
    ruleBody,
    "保存客户记账规则的新版本草稿",
    async (r: any, b: any) =>
      tx(r.actor, (db) =>
        prepareAccountingRule(db, r.actor, uuid.parse(r.params.id), b, r.id),
      ),
  );
  post(
    "/api/v1/invoice-accounting-rules/:id/revise",
    ruleBody.omit({ businessType: true }),
    "修订规则，原版本保留且新版本须独立核验",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const row = await one(
          db,
          "SELECT * FROM invoice_accounting_rules WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        if (row.version !== b.version) fail(409, "指定规则版本不一致");
        return prepareAccountingRule(
          db,
          r.actor,
          row.company_id,
          { ...b, businessType: row.business_type },
          r.id,
        );
      }),
  );
  for (const action of ["verify", "reject"] as const)
    post(
      `/api/v1/invoice-accounting-rules/:id/${action}`,
      review,
      "独立核验或驳回客户记账规则",
      async (r: any, b: any) =>
        tx(r.actor, async (db) => {
          role(r.actor, "owner", "reviewer");
          const ref = await one(
            db,
            "SELECT * FROM invoice_accounting_rules WHERE id=$1",
            [uuid.parse(r.params.id)],
          );
          await lockAccountingCompany(db, ref.company_id);
          const work = await one(
            db,
            "SELECT id FROM work_orders WHERE company_id=$1 AND period=$2",
            [ref.company_id, ref.basis_period],
          );
          await order(db, work.id);
          const row = await one(
            db,
            "SELECT * FROM invoice_accounting_rules WHERE id=$1 FOR UPDATE",
            [ref.id],
          );
          if (row.actor_id === r.actor.id)
            fail(403, "记账规则须由另一名人员核验");
          const current = await readAccountingRule(db, row.id, r.actor);
          if (current.reviewRestriction) fail(403, current.reviewRestriction);
          if (row.version !== b.version || !current.canReview)
            fail(409, "规则版本或状态已变化，请刷新");
          if (action === "verify") {
            if (!(await company(db, row.company_id)).active || current.stale)
              fail(409, "客户或科目底稿已变化，请修订规则再核验");
            await db.query(
              "UPDATE invoice_accounting_rules SET status='superseded' WHERE company_id=$1 AND business_type=$2 AND status='verified'",
              [row.company_id, row.business_type],
            );
          }
          await db.query(
            "UPDATE invoice_accounting_rules SET status=$2,reviewed_by=$3,reviewed_at=now(),review_reason=$4 WHERE id=$1",
            [
              row.id,
              action === "verify" ? "verified" : "rejected",
              r.actor.id,
              b.reason,
            ],
          );
          await audit(
            db,
            r.actor,
            `invoice_accounting_rule_${action}`,
            row.id,
            row.company_id,
            { reason: b.reason, version: row.version },
            r.id,
          );
          return readAccountingRule(db, row.id, r.actor);
        }),
    );

  post(
    "/api/v1/invoice-requests/:id/ledger",
    z.object({ version: z.number().int().positive() }).strict(),
    "从已核验成功回执登记唯一台账",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const request = await one(
          db,
          "SELECT * FROM invoice_requests WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        await order(db, request.order_id);
        const current = await one(
          db,
          "SELECT version FROM invoice_requests WHERE id=$1",
          [request.id],
        );
        if (current.version !== b.version) fail(409, "申请版本已变化");
        return registerInvoiceLedger(db, r.actor, request.id, r.id);
      }),
  );
  get(
    "/api/v1/orders/:id/invoice-ledger",
    "本单发票台账与最新记账草稿",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        await one(db, "SELECT id FROM work_orders WHERE id=$1", [
          uuid.parse(r.params.id),
        ]);
        const q = page.extend({ requestId: uuid.optional() }).parse(r.query);
        const rows = (
          await db.query(
            "SELECT * FROM invoice_ledger WHERE order_id=$1 AND ($4::uuid IS NULL OR request_id=$4) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
            [r.params.id, q.limit, q.offset, q.requestId || null],
          )
        ).rows;
        for (const row of rows) {
          const draft = (
            await db.query(
              "SELECT id FROM invoice_accounting_drafts WHERE ledger_id=$1 ORDER BY version DESC LIMIT 1",
              [row.id],
            )
          ).rows[0];
          row.latestDraft = draft
            ? await readAccountingDraft(db, draft.id, r.actor)
            : null;
        }
        return rows;
      }),
  );
  get("/api/v1/invoice-ledger/:id", "回录台账及草稿版本目录", async (r: any) =>
    tx(r.actor, async (db) => {
      writer(r.actor);
      const row = await one(db, "SELECT * FROM invoice_ledger WHERE id=$1", [
          uuid.parse(r.params.id),
        ]),
        q = page.parse(r.query);
      return {
        ...row,
        drafts: (
          await db.query(
            "SELECT id,version,status,actor_id,created_at,reviewed_at FROM invoice_accounting_drafts WHERE ledger_id=$1 ORDER BY version DESC LIMIT $2 OFFSET $3",
            [row.id, q.limit, q.offset],
          )
        ).rows,
        posted: false,
      };
    }),
  );
  post(
    "/api/v1/invoice-ledger/:id/accounting-drafts",
    accountingDraftBody,
    "依据实际业务及已核验规则准备记账草稿",
    async (r: any, b: any) =>
      tx(r.actor, (db) =>
        prepareAccountingDraft(db, r.actor, uuid.parse(r.params.id), b, r.id),
      ),
  );
  post(
    "/api/v1/invoice-accounting-drafts/:id/revise",
    accountingDraftBody,
    "补齐草稿依据并生成新版本，重新等待独立复核",
    async (r: any, b: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const row = await one(
          db,
          "SELECT * FROM invoice_accounting_drafts WHERE id=$1",
          [uuid.parse(r.params.id)],
        );
        if (row.version !== b.version) fail(409, "指定草稿版本不一致");
        return prepareAccountingDraft(db, r.actor, row.ledger_id, b, r.id);
      }),
  );
  get(
    "/api/v1/invoice-accounting-drafts/:id",
    "记账草稿、依据变化及复核状态",
    async (r: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        return readAccountingDraft(db, uuid.parse(r.params.id), r.actor);
      }),
  );
  for (const action of ["verify", "reject"] as const)
    post(
      `/api/v1/invoice-accounting-drafts/:id/${action}`,
      review,
      "人工复核记账草稿，形成交接成果但不入账",
      async (r: any, b: any) =>
        tx(r.actor, async (db) => {
          role(r.actor, "owner", "reviewer");
          const ref = await one(
            db,
            "SELECT * FROM invoice_accounting_drafts WHERE id=$1",
            [uuid.parse(r.params.id)],
          );
          await lockAccountingCompany(db, ref.company_id);
          const o = await order(db, ref.order_id);
          independent(o, r.actor);
          const row = await one(
            db,
            "SELECT * FROM invoice_accounting_drafts WHERE id=$1 FOR UPDATE",
            [ref.id],
          );
          if (row.actor_id === r.actor.id) fail(403, "经办不能复核自己的草稿");
          const current = await readAccountingDraft(db, row.id, r.actor);
          if (current.reviewRestriction) fail(403, current.reviewRestriction);
          if (row.version !== b.version || !current.canReview)
            fail(409, "草稿不是当前待复核版本或没有复核权限");
          if (action === "verify" && !current.canVerify)
            fail(409, "科目、规则、依据或业务信息已变化，请修订后再复核");
          await db.query(
            "UPDATE invoice_accounting_drafts SET status=$2,reviewed_by=$3,reviewed_at=now(),review_reason=$4 WHERE id=$1",
            [
              row.id,
              action === "verify" ? "verified" : "rejected",
              r.actor.id,
              b.reason,
            ],
          );
          await audit(
            db,
            r.actor,
            `invoice_accounting_draft_${action}`,
            row.id,
            row.company_id,
            {
              version: row.version,
              reason: b.reason,
              basisFingerprint: row.basis_fingerprint,
            },
            r.id,
          );
          return readAccountingDraft(db, row.id, r.actor);
        }),
    );
  app.get(
    "/api/v1/invoice-accounting-drafts/:id/export",
    async (r: any, reply: any) =>
      tx(r.actor, async (db) => {
        writer(r.actor);
        const row = await readAccountingDraft(
            db,
            uuid.parse(r.params.id),
            r.actor,
          ),
          format = z
            .enum(["json", "xlsx"])
            .default("xlsx")
            .parse(r.query.format);
        if (!row.canExport) fail(409, "只有独立复核通过的草稿可形成交接成果");
        const artifact = {
          kind: "invoice_accounting_handoff",
          operation:
            row.context.decision === "link_existing"
              ? "reference_existing_voucher"
              : "draft_new_voucher",
          posted: false,
          notice:
            "独立复核通过的交接成果，不代表已过账；历史版本按原核验依据保留。",
          draft: row,
        };
        await audit(
          db,
          r.actor,
          "invoice_accounting_exported",
          row.id,
          row.company_id,
          { version: row.version, format },
          r.id,
        );
        reply.header(
          "Content-Disposition",
          `attachment; filename="invoice-accounting-${row.id}.${format}"`,
        );
        if (format === "json")
          return reply
            .type("application/json; charset=utf-8")
            .send(JSON.stringify(artifact, null, 2));
        const book = new ExcelJS.Workbook();
        const info = book.addWorksheet("交接说明");
        info.addRows([
          ["编号", row.number],
          ["状态", "已独立复核，未过账"],
          ["期间", row.period],
          ["发票号码", row.ledger.snapshot.payload.invoiceNumber],
          ["处理方式", row.context.decision],
          ["确认依据", row.context.recognitionBasis],
          ["科目底稿版本", String(row.basis.snapshotVersion)],
          ["档案版本", String(row.basis.dossierVersion)],
          ["规则版本", String(row.basis.ruleVersion || "关联既有凭证")],
          ["复核人", row.reviewed_by],
          ["复核时间", String(row.reviewed_at)],
          ["复核说明", row.review_reason],
          ["当前依据是否变化", row.stale ? "是，历史核验快照保留" : "否"],
        ]);
        const lines = book.addWorksheet(
          row.context.decision === "link_existing"
            ? "已入账凭证参考"
            : "分录草稿",
        );
        lines.addRow(["科目", "科目名称", "借方", "贷方", "摘要", "取数依据"]);
        for (const l of row.lines)
          lines.addRow([
            l.account,
            l.accountName,
            l.debit,
            l.credit,
            l.description,
            l.amountBasis,
          ]);
        const files = book.addWorksheet("依据索引");
        files.addRow(["文件编号", "名称", "版本", "SHA256"]);
        for (const f of [...row.ledger.snapshot.evidence, ...row.basis.files])
          files.addRow([f.id, f.name, f.version, f.sha256]);
        // Keep complete immutable source and rule details in bounded text chunks, not Excel formulas.
        const metadata = book.addWorksheet("完整来源快照");
        const json = JSON.stringify(artifact);
        for (let n = 0; n < json.length; n += 30000)
          metadata.addRow([String(n / 30000 + 1), json.slice(n, n + 30000)]);
        for (const sheet of book.worksheets) {
          sheet.getRow(1).font = { bold: true };
          sheet.columns.forEach((c) => (c.width = 28));
        }
        return reply
          .type(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          )
          .send(Buffer.from(await book.xlsx.writeBuffer()));
      }),
  );
}
