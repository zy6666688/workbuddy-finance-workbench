import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import { z } from "zod";
import {
  one,
  order,
  company,
  fail,
  uuid,
  period,
  audit,
  canonical,
  sha,
  touch,
  writer,
} from "./core.js";

const text = (max: number) => z.string().trim().min(1).max(max);
export const ruleBody = z
  .object({
    key: uuid,
    version: z.number().int().min(0),
    period,
    businessType: text(100),
    reason: text(2000),
    payload: z
      .object({
        name: text(200),
        validFrom: z.iso.date(),
        validUntil: z.iso.date(),
        conditions: text(2000),
        requiredEvidence: z.array(text(100)).min(1).max(10),
        lines: z
          .array(
            z
              .object({
                account: text(60),
                side: z.enum(["debit", "credit"]),
                amountBasis: z.enum(["net", "tax", "gross"]),
                description: text(500),
              })
              .strict(),
          )
          .min(2)
          .max(20),
      })
      .strict()
      .refine((p) => p.validFrom <= p.validUntil, "规则起止日期不正确"),
  })
  .strict();
export const accountingContext = z
  .object({
    businessType: z.string().trim().max(100).default(""),
    handlingDate: z.union([z.iso.date(), z.literal("")]).default(""),
    currency: z.string().trim().max(10).default(""),
    businessMode: z
      .enum(["standard_sale", "other", "unknown"])
      .default("unknown"),
    decision: z.enum(["new_entry", "link_existing", "hold"]).default("hold"),
    conditionsConfirmed: z.boolean().default(false),
    ruleId: uuid.nullable().default(null),
    ruleVersion: z.number().int().positive().nullable().default(null),
    recognitionBasis: z.string().trim().max(2000).default(""),
    existingVoucher: z.string().trim().max(60).default(""),
    note: text(2000),
    evidence: z
      .array(
        z
          .object({ requirement: text(100), fileId: uuid, note: text(1000) })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict();
export const accountingDraftBody = z
  .object({
    key: uuid,
    version: z.number().int().min(0),
    context: accountingContext,
  })
  .strict();

export async function lockAccountingCompany(db: any, companyId: string) {
  // Take before any work-order locks in every entry point that uses this lock.
  await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `invoice-accounting/${companyId}`,
  ]);
}
export async function accountingBasis(
  db: any,
  companyId: string,
  targetPeriod: string,
) {
  const snapshot =
    (
      await db.query(
        "SELECT * FROM accounting_snapshots WHERE company_id=$1 AND period=$2 ORDER BY version DESC LIMIT 1",
        [companyId, targetPeriod],
      )
    ).rows[0] || null;
  const dossier =
    (
      await db.query(
        "SELECT d.* FROM client_dossier_bindings b JOIN client_dossier_revisions d ON d.id=b.revision_id WHERE b.company_id=$1 AND b.period=$2",
        [companyId, targetPeriod],
      )
    ).rows[0] || null;
  return { snapshot, dossier };
}

// A hand-off to another author must not erase participation in an unreviewed
// revision chain. A previously approved version is an independent review boundary.
export async function accountingRuleContributors(
  db: any,
  rule: any,
): Promise<string[]> {
  const rows = (
    await db.query(
      `SELECT DISTINCT actor_id FROM invoice_accounting_rules
       WHERE company_id=$1 AND business_type=$2 AND version<=$3
         AND version>COALESCE((
           SELECT max(version) FROM invoice_accounting_rules
           WHERE company_id=$1 AND business_type=$2 AND version<$3
             AND status IN ('verified','superseded') AND reviewed_by IS NOT NULL
         ),0)
       ORDER BY actor_id`,
      [rule.company_id, rule.business_type, rule.version],
    )
  ).rows;
  return rows.map((r: any) => r.actor_id);
}
export async function registerInvoiceLedger(
  db: any,
  actor: any,
  requestId: string,
  auditId = "system",
) {
  writer(actor);
  const ref = await one(
      db,
      "SELECT order_id FROM invoice_requests WHERE id=$1",
      [requestId],
    ),
    o = await order(db, ref.order_id);
  if (!(await company(db, o.company_id)).active) fail(409, "客户已停用");
  const receipt = await one(
    db,
    "SELECT * FROM invoice_result_records WHERE request_id=$1 AND status='verified' AND payload->>'outcome'='issued'",
    [requestId],
  );
  const prior = (
    await db.query("SELECT * FROM invoice_ledger WHERE result_id=$1", [
      receipt.id,
    ])
  ).rows[0];
  if (prior) return prior;
  if (o.status !== "processing") fail(409, "请在经办阶段登记台账");
  const id = randomUUID();
  await db.query(
    "INSERT INTO invoice_ledger(id,org_id,company_id,order_id,request_id,result_id,actor_id,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id,
      actor.org_id,
      o.company_id,
      o.id,
      requestId,
      receipt.id,
      actor.id,
      JSON.stringify(receipt),
    ],
  );
  await touch(db, o, actor);
  await audit(
    db,
    actor,
    "invoice_ledger_registered",
    id,
    o.company_id,
    { requestId, resultId: receipt.id },
    auditId,
  );
  return one(db, "SELECT * FROM invoice_ledger WHERE id=$1", [id]);
}

export async function evaluateAccounting(db: any, ledger: any, context: any) {
  const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
    ledger.order_id,
  ]);
  const { snapshot, dossier } = await accountingBasis(
    db,
    o.company_id,
    o.period,
  );
  const issues: { field: string; message: string }[] = [];
  const issue = (field: string, message: string) =>
    issues.push({ field, message });
  const receipt = ledger.snapshot.payload;
  if (!snapshot) issue("accounts", "本期尚无已保存的账务底稿及科目表");
  if (!dossier) issue("dossier", "本期尚未固定客户档案");
  if (
    dossier &&
    (dossier.payload.creditCode !== receipt.sellerTaxId ||
      dossier.payload.legalName !== ledger.snapshot.snapshot.payload.sellerName)
  )
    issue("dossier", "当前档案销方与回录主体不一致");
  if (!context.businessType) issue("businessType", "请明确实际业务类型");
  if (context.currency !== "CNY")
    issue("currency", "仅支持已明确的人民币口径；外币或币种不明须人工处理");
  if (
    !context.handlingDate.startsWith(o.period + "-") ||
    !receipt.invoiceDate.startsWith(o.period + "-")
  )
    issue("handlingDate", "处理日期或发票日期跨期，须另行人工处理");
  if (context.businessMode !== "standard_sale")
    issue(
      "businessMode",
      "仅支持已确认的普通蓝字销项业务，特殊或不明业务须人工处理",
    );
  if (context.decision === "hold")
    issue("decision", "尚未确定是否记账或是否已入账");
  if (!context.recognitionBasis)
    issue("recognitionBasis", "缺少业务确认依据，不能仅因开票确认收入");
  if (!context.evidence.length) issue("evidence", "需选择原始业务确认依据");
  const ids = [...new Set<string>(context.evidence.map((x: any) => x.fileId))];
  const files = (
    await db.query(
      `SELECT f.id,f.name,f.sha256,f.version,f.kind FROM files f WHERE f.order_id=$1 AND f.id=ANY($2::uuid[]) AND f.kind IN ('source','evidence') AND f.category<>'系统任务包'
    AND NOT EXISTS(SELECT 1 FROM files n WHERE n.order_id=f.order_id AND n.kind=f.kind AND n.name=f.name AND n.version>f.version) ORDER BY f.id`,
      [o.id, ids],
    )
  ).rows;
  if (files.length !== ids.length)
    issue("evidence", "业务依据不属于本单、已被替换或不可访问，请重新选用");
  const accounts = new Map<string, any>(
    (snapshot?.payload.accounts || []).map((a: any) => [a.code, a]),
  );
  if (accounts.size !== (snapshot?.payload.accounts || []).length)
    issue("accounts", "科目表存在重复编号");
  let rule: any = null,
    lines: any[] = [];
  if (context.decision === "new_entry") {
    const matches = (
      await db.query(
        "SELECT * FROM invoice_accounting_rules WHERE company_id=$1 AND business_type=$2 AND status='verified' AND payload->>'validFrom'<=$3 AND payload->>'validUntil'>=$3",
        [o.company_id, context.businessType, context.handlingDate],
      )
    ).rows;
    if (matches.length !== 1)
      issue("rule", "本业务及处理日期没有唯一有效的已核验记账规则");
    else {
      rule = matches[0];
      if (context.ruleId !== rule.id || context.ruleVersion !== rule.version)
        issue(
          "rule",
          "规则版本未明确或已变化，请读取当前规则并重新确认适用条件",
        );
      const ruleBasis = await one(
        db,
        "SELECT payload FROM accounting_snapshots WHERE id=$1 AND company_id=$2",
        [rule.basis_snapshot_id, o.company_id],
      );
      if (
        rule.payload.lines.some((l: any) => {
          const old = ruleBasis.payload.accounts.find(
              (a: any) => a.code === l.account,
            ),
            current = accounts.get(l.account);
          return (
            !old ||
            !current ||
            old.name !== current.name ||
            old.category !== current.category
          );
        })
      )
        issue("rule", "规则使用的科目名称或类别已变化，请先修订并核验规则");
      if (!context.conditionsConfirmed)
        issue("conditionsConfirmed", "需明确确认本次业务符合规则适用条件");
      for (const requirement of rule.payload.requiredEvidence)
        if (
          !context.evidence.some(
            (e: any) =>
              e.requirement === requirement &&
              files.some((f: any) => f.id === e.fileId),
          )
        )
          issue("evidence", `缺少规则要求的依据：${requirement}`);
      lines = rule.payload.lines.flatMap((l: any) => {
        const value = new Decimal(receipt[l.amountBasis]);
        if (value.isZero()) return [];
        return [
          {
            account: l.account,
            accountName: accounts.get(l.account)?.name || "",
            debit: l.side === "debit" ? value.toFixed(2) : "0.00",
            credit: l.side === "credit" ? value.toFixed(2) : "0.00",
            description: l.description,
            amountBasis: l.amountBasis,
          },
        ];
      });
    }
    // Existing invoice rows are evidence of prior accounting, not permission to duplicate it.
    if (
      snapshot?.payload.invoices?.some(
        (i: any) => i.kind === "sale" && i.number === receipt.invoiceNumber,
      )
    )
      issue("decision", "本期底稿已有该销项发票，请核实并改为关联现有凭证");
    if (context.existingVoucher)
      issue("existingVoucher", "新增草稿不能同时指定已入账凭证");
  } else if (context.decision === "link_existing") {
    const vouchers = (snapshot?.payload.vouchers || []).filter(
      (v: any) => v.number === context.existingVoucher,
    );
    if (!context.existingVoucher || vouchers.length !== 1)
      issue("existingVoucher", "本期底稿没有唯一匹配的现有凭证");
    else {
      const voucher = vouchers[0];
      if (voucher.closing || !voucher.date.startsWith(o.period + "-"))
        issue("existingVoucher", "不能关联结转或跨期凭证");
      lines = voucher.lines.map((l: any) => ({
        ...l,
        accountName: accounts.get(l.account)?.name || "",
        amountBasis: "existing_voucher",
      }));
      const invoiceRows = (snapshot.payload.invoices || []).filter(
        (i: any) => i.number === receipt.invoiceNumber && i.kind === "sale",
      );
      if (
        invoiceRows.length !== 1 ||
        invoiceRows[0].voucher !== context.existingVoucher ||
        invoiceRows[0].color !== "blue" ||
        ["net", "tax", "gross"].some(
          (k) => !new Decimal(invoiceRows[0][k]).equals(receipt[k]),
        )
      )
        issue(
          "existingVoucher",
          "需有与本回执票号、金额一致的蓝字销项底稿记录，且明确关联此凭证",
        );
      const claimed = (
        await db.query(
          "SELECT id FROM invoice_accounting_drafts WHERE company_id=$1 AND period=$2 AND claimed_voucher=$3 AND ledger_id<>$4 AND status IN ('pending','verified') LIMIT 1",
          [o.company_id, o.period, context.existingVoucher, ledger.id],
        )
      ).rows[0];
      if (claimed)
        issue(
          "existingVoucher",
          "此凭证已有其他发票的待复核或已核验关联；合并凭证须人工处理",
        );
    }
  }
  if (context.decision !== "hold") {
    let debit = new Decimal(0),
      credit = new Decimal(0);
    for (const l of lines) {
      const d = new Decimal(l.debit),
        c = new Decimal(l.credit);
      if (!accounts.has(l.account))
        issue("accounts", `科目 ${l.account} 不在当前科目表中`);
      if (
        d.lt(0) ||
        c.lt(0) ||
        (d.gt(0) && c.gt(0)) ||
        (d.isZero() && c.isZero())
      )
        issue("lines", `科目 ${l.account} 借贷方向或金额无效`);
      debit = debit.plus(d);
      credit = credit.plus(c);
    }
    if (
      lines.length < 2 ||
      !debit.equals(credit) ||
      !debit.equals(receipt.gross)
    )
      issue(
        "lines",
        "分录须借贷平衡且双方合计等于本张回执价税合计；拆分或复杂业务须人工处理",
      );
  }
  const basis = {
    inputRevision: o.input_revision,
    snapshotId: snapshot?.id || null,
    snapshotVersion: snapshot?.version || null,
    accounts: snapshot?.payload.accounts || [],
    dossierId: dossier?.id || null,
    dossierVersion: dossier?.version || null,
    ruleId: rule?.id || null,
    ruleVersion: rule?.version || null,
    rule: rule
      ? {
          payload: rule.payload,
          contributorIds: await accountingRuleContributors(db, rule),
          reviewedBy: rule.reviewed_by,
          reviewedAt:
            rule.reviewed_at instanceof Date
              ? rule.reviewed_at.toISOString()
              : rule.reviewed_at,
        }
      : null,
    files,
    resultId: ledger.result_id,
  };
  return { issues, lines, basis, basisFingerprint: sha(canonical(basis)) };
}

export async function prepareAccountingDraft(
  db: any,
  actor: any,
  ledgerId: string,
  b: any,
  auditId = "system",
) {
  writer(actor);
  const ledger = await one(db, "SELECT * FROM invoice_ledger WHERE id=$1", [
    ledgerId,
  ]);
  await lockAccountingCompany(db, ledger.company_id);
  const o = await order(db, ledger.order_id);
  const fingerprint = sha(
    canonical({ version: b.version, context: b.context }),
  );
  const prior = (
    await db.query(
      "SELECT id,fingerprint FROM invoice_accounting_drafts WHERE ledger_id=$1 AND actor_id=$2 AND request_key=$3",
      [ledger.id, actor.id, b.key],
    )
  ).rows[0];
  if (prior) {
    if (prior.fingerprint !== fingerprint)
      fail(409, "请求标识已用于另一份记账草稿");
    return readAccountingDraft(db, prior.id, actor);
  }
  if (!(await company(db, o.company_id)).active || o.status !== "processing")
    fail(409, "请在有效客户的经办阶段准备记账草稿");
  const latest = (
    await db.query(
      "SELECT * FROM invoice_accounting_drafts WHERE ledger_id=$1 ORDER BY version DESC LIMIT 1",
      [ledger.id],
    )
  ).rows[0];
  if ((latest?.version || 0) !== b.version)
    fail(409, "记账草稿版本已变化，请刷新");
  if (latest?.status === "verified")
    fail(409, "已有核验通过的交接成果，不重复生成分录；后续调整须人工另行处理");
  if (latest && latest.actor_id !== actor.id && actor.role !== "owner")
    fail(403, "只有原经办或负责人可修订记账草稿");
  const result = await evaluateAccounting(db, ledger, b.context);
  await db.query(
    "UPDATE invoice_accounting_drafts SET status='superseded' WHERE ledger_id=$1 AND status IN ('pending','blocked')",
    [ledger.id],
  );
  const id = randomUUID(),
    status = result.issues.length ? "blocked" : "pending";
  await db.query(
    `INSERT INTO invoice_accounting_drafts(id,org_id,company_id,order_id,ledger_id,version,period,actor_id,request_key,fingerprint,context,basis,basis_fingerprint,lines,issues,claimed_voucher,status)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id,
      actor.org_id,
      o.company_id,
      o.id,
      ledger.id,
      b.version + 1,
      o.period,
      actor.id,
      b.key,
      fingerprint,
      JSON.stringify(b.context),
      JSON.stringify(result.basis),
      result.basisFingerprint,
      JSON.stringify(result.lines),
      JSON.stringify(result.issues),
      b.context.decision === "link_existing"
        ? b.context.existingVoucher || null
        : null,
      status,
    ],
  );
  await touch(db, o, actor);
  await audit(
    db,
    actor,
    "invoice_accounting_prepared",
    id,
    o.company_id,
    {
      ledgerId: ledger.id,
      version: b.version + 1,
      status,
      issueCount: result.issues.length,
    },
    auditId,
  );
  return readAccountingDraft(db, id, actor);
}
export async function readAccountingDraft(db: any, id: string, actor: any) {
  const row = await one(
    db,
    "SELECT * FROM invoice_accounting_drafts WHERE id=$1",
    [id],
  );
  const ledger = await one(db, "SELECT * FROM invoice_ledger WHERE id=$1", [
    row.ledger_id,
  ]);
  const o = await one(db, "SELECT * FROM work_orders WHERE id=$1", [
    row.order_id,
  ]);
  const current = await evaluateAccounting(db, ledger, row.context);
  const active = (await company(db, row.company_id)).active;
  const stale =
    current.basisFingerprint !== row.basis_fingerprint ||
    canonical(current.lines) !== canonical(row.lines) ||
    current.issues.length > 0;
  const latest = await one(
    db,
    "SELECT id FROM invoice_accounting_drafts WHERE ledger_id=$1 ORDER BY version DESC LIMIT 1",
    [row.ledger_id],
  );
  const ruleContributors = row.basis.ruleId
    ? await accountingRuleContributors(
        db,
        await one(
          db,
          "SELECT * FROM invoice_accounting_rules WHERE id=$1 AND company_id=$2",
          [row.basis.ruleId, row.company_id],
        ),
      )
    : [];
  const independentActor =
    ["owner", "reviewer"].includes(actor.role) &&
    actor.id !== row.actor_id &&
    !ruleContributors.includes(actor.id) &&
    o.assignee_id !== actor.id &&
    !o.contributors.includes(actor.id) &&
    o.submission?.submittedBy !== actor.id &&
    (actor.role === "owner" || o.reviewer_id === actor.id);
  return {
    ...row,
    number: `记账草稿-${row.id.slice(0, 8)}-v${row.version}`,
    ledger,
    stale,
    currentIssues: current.issues,
    reviewRestriction: ruleContributors.includes(actor.id)
      ? "参与所用规则编制的人员不能复核由该规则生成的记账草稿，请交由另一名独立人员处理。"
      : "",
    posted: false,
    canReview:
      active &&
      o.status === "processing" &&
      row.status === "pending" &&
      latest.id === id &&
      independentActor,
    canVerify:
      active &&
      o.status === "processing" &&
      row.status === "pending" &&
      latest.id === id &&
      independentActor &&
      !stale,
    canRevise:
      active &&
      o.status === "processing" &&
      latest.id === id &&
      row.status !== "verified" &&
      (actor.role === "owner" || row.actor_id === actor.id),
    canExport: row.status === "verified",
    history: (
      await db.query(
        "SELECT action,actor_id,details,created_at FROM audit_events WHERE company_id=$1 AND target_id=$2 ORDER BY created_at,id",
        [row.company_id, id],
      )
    ).rows,
  };
}

export async function prepareAccountingRule(
  db: any,
  actor: any,
  companyId: string,
  b: any,
  auditId = "system",
) {
  writer(actor);
  await lockAccountingCompany(db, companyId);
  const fingerprint = sha(
    canonical({
      version: b.version,
      period: b.period,
      businessType: b.businessType,
      payload: b.payload,
      reason: b.reason,
    }),
  );
  const prior = (
    await db.query(
      "SELECT id,fingerprint FROM invoice_accounting_rules WHERE company_id=$1 AND actor_id=$2 AND request_key=$3",
      [companyId, actor.id, b.key],
    )
  ).rows[0];
  if (prior) {
    if (prior.fingerprint !== fingerprint) fail(409, "请求标识已用于不同规则");
    return readAccountingRule(db, prior.id, actor);
  }
  if (!(await company(db, companyId)).active) fail(409, "客户已停用");
  const latest = (
    await db.query(
      "SELECT * FROM invoice_accounting_rules WHERE company_id=$1 AND business_type=$2 ORDER BY version DESC LIMIT 1",
      [companyId, b.businessType],
    )
  ).rows[0];
  if ((latest?.version || 0) !== b.version) fail(409, "规则版本已变化，请刷新");
  const work = await one(
    db,
    "SELECT id FROM work_orders WHERE company_id=$1 AND period=$2",
    [companyId, b.period],
  );
  await order(db, work.id);
  const { snapshot } = await accountingBasis(db, companyId, b.period);
  if (!snapshot) fail(409, "请先保存客户本期科目底稿，再准备规则");
  if (
    b.payload.lines.some(
      (l: any) =>
        !snapshot.payload.accounts.some((a: any) => a.code === l.account),
    )
  )
    fail(400, "规则科目不在本期科目表中");
  if (
    new Set(b.payload.requiredEvidence).size !==
    b.payload.requiredEvidence.length
  )
    fail(400, "必需依据名称不得重复");
  // Require symbolic balance net + tax = gross, not just one coincidental invoice.
  const coefficients = { net: 0, tax: 0 };
  const debitCoefficients = { net: 0, tax: 0 };
  for (const l of b.payload.lines) {
    const sign = l.side === "debit" ? 1 : -1;
    if (l.amountBasis !== "tax") coefficients.net += sign;
    if (l.amountBasis !== "net") coefficients.tax += sign;
    if (l.side === "debit") {
      if (l.amountBasis !== "tax") debitCoefficients.net++;
      if (l.amountBasis !== "net") debitCoefficients.tax++;
    }
  }
  if (
    coefficients.net !== 0 ||
    coefficients.tax !== 0 ||
    debitCoefficients.net !== 1 ||
    debitCoefficients.tax !== 1
  )
    fail(
      400,
      "规则须保证借贷平衡，且双方合计各等于一份价税合计；复杂拆分请人工处理",
    );
  const replaced = await db.query(
    "UPDATE invoice_accounting_rules SET status='superseded' WHERE company_id=$1 AND business_type=$2 AND status='draft' RETURNING id",
    [companyId, b.businessType],
  );
  const id = randomUUID();
  await db.query(
    "INSERT INTO invoice_accounting_rules(id,org_id,company_id,business_type,version,actor_id,request_key,fingerprint,basis_period,basis_snapshot_id,payload,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      id,
      actor.org_id,
      companyId,
      b.businessType,
      b.version + 1,
      actor.id,
      b.key,
      fingerprint,
      b.period,
      snapshot.id,
      JSON.stringify(b.payload),
      b.reason,
    ],
  );
  await audit(
    db,
    actor,
    "invoice_accounting_rule_prepared",
    id,
    companyId,
    {
      businessType: b.businessType,
      version: b.version + 1,
      reason: b.reason,
      replacedDraftIds: replaced.rows.map((r: any) => r.id),
    },
    auditId,
  );
  return readAccountingRule(db, id, actor);
}
export async function readAccountingRule(db: any, id: string, actor: any) {
  const row = await one(
    db,
    "SELECT * FROM invoice_accounting_rules WHERE id=$1",
    [id],
  );
  const { snapshot } = await accountingBasis(
    db,
    row.company_id,
    row.basis_period,
  );
  const latest = await one(
    db,
    "SELECT id,version FROM invoice_accounting_rules WHERE company_id=$1 AND business_type=$2 ORDER BY version DESC LIMIT 1",
    [row.company_id, row.business_type],
  );
  const contributorIds = await accountingRuleContributors(db, row);
  const active = (await company(db, row.company_id)).active;
  return {
    ...row,
    contributorIds,
    latestVersion: latest.version,
    stale: snapshot?.id !== row.basis_snapshot_id,
    reviewRestriction: contributorIds.includes(actor.id)
      ? "参与本轮规则编制或修订的人员不能复核，即使最新版本由其他人员提交。"
      : "",
    canReview:
      active &&
      row.status === "draft" &&
      latest.id === id &&
      !contributorIds.includes(actor.id) &&
      ["owner", "reviewer"].includes(actor.role),
    history: (
      await db.query(
        "SELECT action,actor_id,details,created_at FROM audit_events WHERE company_id=$1 AND target_id=$2 ORDER BY created_at,id",
        [row.company_id, id],
      )
    ).rows,
  };
}
