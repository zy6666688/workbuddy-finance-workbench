import { Decimal as BaseDecimal } from "decimal.js";
import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";
import {
  readWorkflowTables,
  type Row,
  type Source,
} from "./workflow-tables.js";
type Decimal = BaseDecimal;
const Decimal = BaseDecimal.clone({
  precision: 40,
  rounding: BaseDecimal.ROUND_HALF_UP,
});

const key = (...values: string[]) => JSON.stringify(values);
const days = (a: string, b: string) =>
  Math.round(
    (Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 86400000,
  );
const num = (r: Row, field = "amount") => new Decimal(r.values[field]);
const sum = (rows: Row[], field = "amount") =>
  rows.reduce((n, r) => n.add(num(r, field)), new Decimal(0));
function group(rows: Row[], fields: string[]) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const k = key(...fields.map((f) => row.values[f]));
    const bucket = groups.get(k) || [];
    bucket.push(row);
    groups.set(k, bucket);
  }
  return groups;
}
export async function runWorkflowRules(
  db: any,
  o: any,
  run: any,
  files: any[],
) {
  const inputFiles = run.task_brief?.preparedWorkbookId
    ? files.filter((f) => f.id === run.task_brief.preparedWorkbookId)
    : files;
  const input = await readWorkflowTables(run.workflow_id, inputFiles),
    { spec, tables, parameters: p, issues } = input;
  const rows: any[] = [],
    selected = new Map<string, any>(files.map((f) => [f.id, f]));
  const issue = (
    type: string,
    message: string,
    row?: Row,
    related?: Source[],
  ) =>
    issues.push({
      type,
      message,
      ...(row ? { source: row.source } : {}),
      ...(related ? { related: related.slice(0, 20) } : {}),
    });
  const emit = (type: string, row: Row, extra: any = {}) =>
    rows.push({ type, ...row.values, ...extra, source: row.source });
  const valid = (name: string) => (tables[name] || []).filter((r) => r.valid);
  const check = (row: Row, field: string, allowed: string[]) => {
    if (!allowed.includes(row.values[field])) {
      issue("enum", `${field} 只能填写 ${allowed.join("/")}`, row);
      row.valid = false;
      return false;
    }
    return true;
  };
  const evidence = (row: Row, field: string) => {
    const file = selected.get(row.values[field]);
    if (!file) issue("evidence", `${field} 未指向本任务固定输入中的附件`, row);
    return file;
  };
  // Duplicate business IDs are excluded from calculated totals; raw rows remain in the result.
  for (const table of spec.tables)
    for (const bucket of group(valid(table.key), ["id"]).values())
      if (bucket.length > 1)
        for (const row of bucket) {
          issue(
            "duplicate_id",
            `业务编号 ${row.values.id} 重复，未计入计算`,
            row,
          );
          row.valid = false;
        }
  const workflowId = run.workflow_id;
  if (
    ["excel-cleaning", "excel-merge", "full-table-anomaly"].includes(workflowId)
  ) {
    for (const row of valid("data")) {
      emit("standard_row", row);
      if (p.largeAmount && num(row).abs().gte(p.largeAmount))
        issue("large_amount", "达到已设定大额阈值，请复核", row);
    }
    for (const bucket of group(valid("data"), ["currency"]).values())
      rows.push({
        type: "control_total",
        currency: bucket[0].values.currency,
        count: bucket.length,
        amount: sum(bucket).toFixed(2),
      });
  } else if (
    ["expense-summary", "expense-duplicate-check"].includes(workflowId)
  ) {
    for (const row of valid("expenses"))
      check(row, "approval", ["approved", "pending", "rejected"]);
    for (const bucket of group(valid("expenses"), ["invoiceId"]).values())
      if (bucket.length > 1)
        for (const row of bucket) {
          issue(
            "duplicate_invoice",
            "发票号重复，列为待核查；不认定违规或自动删除",
            row,
          );
          row.valid = false;
        }
    for (const row of valid("expenses")) {
      if (num(row).lte(0)) {
        issue("expense_amount", "报销金额非正数，请单独核实冲回/退款", row);
        row.valid = false;
        continue;
      }
      if (row.values.approval !== "approved")
        issue("approval", "审批未通过，未纳入有效费用汇总", row);
      if (p.largeAmount && num(row).gte(p.largeAmount))
        issue("large_amount", "达到已设定大额阈值", row);
      if (row.values.budget && num(row).gt(row.values.budget))
        issue(
          "over_budget",
          "单笔金额超过所填对应预算，请核实预算分配口径",
          row,
        );
      emit("expense", row, { included: row.values.approval === "approved" });
    }
    if (workflowId === "expense-summary")
      for (const bucket of group(
        valid("expenses").filter((r) => r.values.approval === "approved"),
        ["currency", "department", "project", "category"],
      ).values())
        rows.push({
          type: "expense_summary",
          currency: bucket[0].values.currency,
          department: bucket[0].values.department,
          project: bucket[0].values.project,
          category: bucket[0].values.category,
          count: bucket.length,
          amount: sum(bucket).toFixed(2),
        });
    if (workflowId === "expense-duplicate-check" && p.dateToleranceDays)
      for (const bucket of group(valid("expenses"), [
        "employee",
        "currency",
        "amount",
      ]).values()) {
        bucket.sort((a, b) => a.values.date.localeCompare(b.values.date));
        for (let i = 1; i < bucket.length; i++)
          if (
            days(bucket[i].values.date, bucket[i - 1].values.date) <=
            Number(p.dateToleranceDays)
          )
            issue(
              "possible_duplicate",
              "同员工、同原币金额且日期接近，仅作疑似重复",
              bucket[i],
              [bucket[i - 1].source],
            );
      }
    if (p.largeAmount)
      for (const bucket of group(valid("expenses"), [
        "merchant",
        "date",
        "currency",
      ]).values())
        if (bucket.length > 1 && sum(bucket).gte(p.largeAmount))
          issue(
            "merchant_split",
            "同商户同日多笔合计达到阈值，请核实是否拆单",
            bucket[0],
            bucket.map((r) => r.source),
          );
  } else if (workflowId === "bank-reconcile") {
    const fields = ["account", "currency", "amount", "reference", "date"],
      bank = valid("bank"),
      ledger = valid("ledger");
    const left = group(bank, fields),
      right = group(ledger, fields),
      loose = group(ledger, ["account", "currency", "amount"]),
      used = new Set<Row>();
    for (const row of bank) {
      const k = key(...fields.map((f) => row.values[f])),
        matches = right.get(k) || [];
      if (left.get(k)?.length === 1 && matches.length === 1) {
        used.add(matches[0]);
        emit("exact_match", row, {
          counterpart: matches[0].source,
          ledgerId: matches[0].values.id,
        });
      } else {
        const bucket =
          loose.get(
            key(row.values.account, row.values.currency, row.values.amount),
          ) || [];
        const candidates =
          p.dateToleranceDays && bucket.length <= 100
            ? bucket.filter(
                (r) =>
                  Math.abs(days(row.values.date, r.values.date)) <=
                  Number(p.dateToleranceDays),
              )
            : [];
        emit("unconfirmed", row, {
          candidates: candidates.slice(0, 20).map((r) => r.source),
          candidateCount: candidates.length,
          candidateSearchLimited: bucket.length > 100,
        });
        issue(
          "bank_unmatched",
          bucket.length > 100
            ? "同账户金额候选过多，请补充共同编号后重算"
            : "未形成双方唯一精确匹配；容差匹配仅为候选",
          row,
        );
      }
    }
    for (const row of ledger)
      if (!used.has(row)) {
        emit("ledger_unmatched", row);
        issue("ledger_unmatched", "账务流水未被唯一匹配", row);
      }
  } else if (
    ["order-cash-invoice", "invoice-payment-match"].includes(workflowId)
  ) {
    const names =
      workflowId === "order-cash-invoice"
        ? ["orders", "receipts", "invoices"]
        : ["invoices", "payments"];
    const groups = names.map((name) =>
      group(valid(name), ["contract", "party", "currency"]),
    );
    const keys = new Set(groups.flatMap((g) => [...g.keys()]));
    for (const k of keys) {
      const buckets = groups.map((g) => g.get(k) || []),
        first = buckets.flat()[0];
      const totals = buckets.map((b) => sum(b));
      const result: any = {
        type: "linked_totals",
        contract: first.values.contract,
        party: first.values.party,
        currency: first.values.currency,
      };
      names.forEach((name, i) => {
        result[name] = totals[i].toFixed(2);
        result[name + "Count"] = buckets[i].length;
      });
      result.differences = totals
        .slice(1)
        .map((n) => n.minus(totals[0]).toFixed(2));
      result.sources = buckets
        .flat()
        .slice(0, 100)
        .map((r) => r.source);
      result.sourceCount = buckets.flat().length;
      rows.push(result);
      if (
        buckets.some((b) => !b.length) ||
        totals.some((n) => !n.eq(totals[0]))
      )
        issue(
          "linked_difference",
          "合同维度金额或资料覆盖存在差异，请核实未收/未开/超付及预收等业务",
          first,
        );
      if (
        buckets.some((b) => b.length > 1) ||
        buckets.flat().some((r) => num(r).lt(0))
      )
        issue(
          "complex_relation",
          "一对多、多对一或负金额仅按明确主键累计，须复核业务分摊关系",
          first,
        );
    }
  } else if (["ar-aging", "ap-schedule"].includes(workflowId)) {
    const name = workflowId === "ar-aging" ? "receivables" : "payables";
    if (workflowId === "ap-schedule") {
      for (const row of valid(name)) {
        check(row, "approval", ["approved", "pending", "rejected"]);
        check(row, "documents", ["complete", "missing"]);
      }
      for (const bucket of group(valid(name), ["invoiceId"]).values())
        if (bucket.length > 1)
          for (const row of bucket) {
            issue("duplicate_invoice", "重复发票已暂缓，不进入付款建议", row);
            row.valid = false;
          }
    }
    let cash = p.availableCash ? new Decimal(p.availableCash) : null;
    for (const row of valid(name).sort(
      (a, b) =>
        a.values.dueDate.localeCompare(b.values.dueDate) ||
        a.values.id.localeCompare(b.values.id),
    )) {
      if (num(row).lt(0)) {
        issue("negative_balance", "负余额须按预收/预付等实际业务单独确认", row);
        emit("negative_balance", row);
        continue;
      }
      const overdue = p.asOfDate
        ? Math.max(0, days(p.asOfDate, row.values.dueDate))
        : null;
      if (workflowId === "ar-aging") {
        check(row, "dispute", ["yes", "no"]);
        emit("aging", row, {
          asOfDate: p.asOfDate || null,
          overdueDays: overdue,
          bucket:
            overdue === null
              ? "统计日待补"
              : overdue === 0
                ? "未逾期"
                : overdue <= 30
                  ? "1–30"
                  : overdue <= 60
                    ? "31–60"
                    : overdue <= 90
                      ? "61–90"
                      : "90以上",
          disputed: row.values.dispute === "yes",
        });
      } else {
        let proposal = "暂缓";
        if (
          p.asOfDate &&
          row.values.approval === "approved" &&
          row.values.documents === "complete" &&
          cash &&
          row.values.currency === p.cashCurrency &&
          num(row).lte(cash)
        ) {
          proposal = "建议排期，待授权人员决定";
          cash = cash.minus(num(row));
        } else
          issue(
            "payment_hold",
            "审批、资料、余额或币种条件不满足，暂缓建议排期",
            row,
          );
        emit("payment_draft", row, {
          overdueDays: overdue,
          proposal,
          remainingCash:
            row.values.currency === p.cashCurrency
              ? (cash?.toFixed(2) ?? null)
              : null,
        });
      }
    }
  } else if (workflowId === "invoice-ledger") {
    for (const row of valid("invoices")) {
      check(row, "status", ["blue", "red", "void", "unknown"]);
      if (!num(row, "net").add(num(row, "tax")).eq(num(row, "gross")))
        issue("invoice_amount", "不含税金额加税额不等于价税合计", row);
      if (row.values.taxId !== row.values.expectedTaxId)
        issue("tax_id", "票面税号与提供的档案税号不一致", row);
      if (row.values.status !== "blue")
        issue(
          "special_invoice",
          "红字、作废或未知状态须核实，不作为正常蓝票处理",
          row,
        );
      if (row.values.status === "red" && !row.values.originalId)
        issue("red_reference", "红字缺少原票关联", row);
      emit("invoice_ledger", row, { verifiedWithTaxAuthority: false });
    }
  } else if (workflowId === "fixed-assets") {
    for (const row of valid("assets")) {
      check(row, "eligible", ["yes", "no"]);
      check(row, "status", ["active", "disposed", "transferred"]);
      const cost = num(row, "cost"),
        residual = num(row, "residual"),
        prior = num(row, "priorDepreciation"),
        months = num(row, "months");
      let expected: Decimal | null = null;
      if (
        !p.asOfDate ||
        row.values.activationDate > p.asOfDate ||
        row.values.method !== "straight_line" ||
        !months.isInteger() ||
        months.lte(0) ||
        residual.lt(0) ||
        cost.lt(residual) ||
        prior.lt(0) ||
        prior.gt(cost.minus(residual)) ||
        !row.valid
      )
        issue(
          "depreciation_policy",
          "启用日、政策参数或计提方法不能直接计算，请核实",
          row,
        );
      else if (row.values.eligible === "no") expected = new Decimal(0);
      else
        expected = Decimal.min(
          cost.minus(residual).minus(prior),
          cost.minus(residual).div(months).toDecimalPlaces(2),
        );
      if (expected && !expected.eq(num(row, "bookDepreciation")))
        issue("depreciation_difference", "本期直线法测算与账面折旧不同", row);
      if (row.values.status !== "active")
        issue("asset_change", "转移/处置资产须复核变动及计提依据", row);
      emit("depreciation_draft", row, {
        expectedDepreciation: expected?.toFixed(2) ?? null,
      });
    }
  } else if (workflowId === "inventory-check") {
    for (const bucket of group(valid("inventory"), [
      "sku",
      "warehouse",
      "unit",
      "currency",
    ]).values())
      if (bucket.length > 1)
        for (const row of bucket) {
          issue(
            "inventory_scope",
            "同 SKU/仓库/单位/币种出现多份期初期末汇总，不能重复累计",
            row,
          );
          row.valid = false;
        }
    for (const row of valid("inventory")) {
      const closing = num(row, "opening")
          .add(num(row, "inbound"))
          .minus(num(row, "outbound")),
        value = num(row, "openingValue")
          .add(num(row, "inboundValue"))
          .minus(num(row, "outboundValue"));
      const quantityDifference = closing.minus(num(row, "closing")),
        countDifference = num(row, "counted").minus(num(row, "closing")),
        valueDifference = value.minus(num(row, "closingValue"));
      if (
        !quantityDifference.isZero() ||
        !countDifference.isZero() ||
        !valueDifference.isZero() ||
        closing.lt(0)
      )
        issue("inventory_difference", "数量、实盘、金额存在差异或负库存", row);
      emit("inventory_check", row, {
        theoreticalClosing: closing.toFixed(),
        quantityDifference: quantityDifference.toFixed(),
        countDifference: countDifference.toFixed(),
        valueDifference: valueDifference.toFixed(2),
      });
    }
  } else if (workflowId === "payroll-check") {
    const names = ["payroll", "social", "tax", "roster"],
      maps = names.map(
        (name) => new Map(valid(name).map((r) => [r.values.id, r])),
      );
    for (const id of new Set(maps.flatMap((m) => [...m.keys()]))) {
      const [pay, social, tax, roster] = maps.map((m) => m.get(id)),
        first = (pay || social || tax || roster)!;
      if (!pay || !social || !tax || !roster) {
        issue("staff_coverage", "工资、社保、个税或人员范围缺少该员工", first);
        emit("staff_missing", first);
        continue;
      }
      check(roster, "status", ["yes", "no"]);
      if (roster.values.status !== "yes")
        issue("staff_status", "存在工资记录但未明确属于本期应计薪人员", pay);
      if (
        social.values.currency !== pay.values.currency ||
        tax.values.currency !== pay.values.currency
      ) {
        issue("currency", "工资、社保及个税币种不一致，停止金额比较", pay);
        continue;
      }
      const expected = num(pay, "gross")
        .minus(num(pay, "social"))
        .minus(num(pay, "tax"))
        .minus(num(pay, "other"));
      if (
        !expected.eq(num(pay, "net")) ||
        !num(pay, "social").eq(num(social)) ||
        !num(pay, "tax").eq(num(tax))
      )
        issue("payroll_difference", "实发关系或扣款跨表金额不一致", pay, [
          social.source,
          tax.source,
        ]);
      emit("payroll_check", pay, {
        expectedNet: expected.toFixed(2),
        socialSource: social.source,
        taxSource: tax.source,
        rosterSource: roster.source,
      });
    }
  } else if (workflowId === "month-close-completeness") {
    for (const row of valid("close")) {
      check(row, "status", ["done", "pending", "not_applicable"]);
      if (row.values.status === "done") evidence(row, "evidenceFileId");
      if (row.values.status === "pending")
        issue("close_pending", "月结事项尚未完成，需责任人及预计完成日", row);
      emit("close_item", row);
    }
    for (const item of o.checklist || [])
      if (item.required && !item.fileId && !item.waiver)
        issue("order_material", `工作单必需资料未齐备：${item.name}`);
  } else if (
    ["budget-variance", "cost-reduction", "management-summary"].includes(
      workflowId,
    )
  ) {
    for (const row of valid("analysis")) {
      const budget = num(row, "budget"),
        actual = num(row, "actual"),
        previous = num(row, "previous"),
        delta = actual.minus(budget),
        change = actual.minus(previous),
        ratio = budget.isZero() ? null : delta.div(budget.abs());
      if (budget.isZero())
        issue("zero_budget", "预算为零，不计算预算差异率", row);
      if (
        p.varianceThreshold &&
        ratio &&
        ratio.abs().gte(p.varianceThreshold) &&
        !row.values.cause
      )
        issue("business_cause", "偏差达到阈值，业务原因待确认", row);
      emit("analysis_fact", row, {
        budgetDifference: delta.toFixed(2),
        budgetDifferenceRatio: ratio?.toFixed(6) ?? null,
        previousDifference: change.toFixed(2),
        previousRatio: previous.isZero()
          ? null
          : change.div(previous.abs()).toFixed(6),
        causeStatus: row.values.cause ? "提供了原因，待独立核实" : "待业务解释",
      });
    }
  } else if (workflowId === "cashflow-forecast") {
    for (const row of valid("cash")) {
      check(row, "direction", ["in", "out"]);
      check(row, "scenario", ["base", "optimistic", "stress"]);
      check(row, "status", ["confirmed", "estimated"]);
    }
    for (const bucket of group(valid("cash"), [
      "scenario",
      "currency",
    ]).values()) {
      let balance =
        p.openingBalance && bucket[0].values.currency === p.cashCurrency
          ? new Decimal(p.openingBalance)
          : null;
      for (const row of bucket.sort(
        (a, b) =>
          a.values.date.localeCompare(b.values.date) ||
          a.values.id.localeCompare(b.values.id),
      )) {
        if (num(row).lt(0) || !p.asOfDate || row.values.date < p.asOfDate) {
          issue("forecast_scope", "计划金额须非负、日期不早于期初余额日", row);
          emit("forecast_excluded", row);
          continue;
        }
        if (balance)
          balance =
            row.values.direction === "in"
              ? balance.add(num(row))
              : balance.minus(num(row));
        if (!balance || balance.lt(0))
          issue(
            "cash_gap",
            balance
              ? "预测余额为负，存在资金缺口"
              : "缺少同币种期初余额，未计算余额",
            row,
          );
        emit("forecast", row, {
          projectedBalance: balance?.toFixed(2) ?? null,
          actualTransaction: false,
        });
      }
    }
  } else if (workflowId === "voucher-archive") {
    for (const row of valid("archive")) {
      const file = evidence(row, "fileId");
      if (/[\\/:*?"<>|]|\.\./.test(row.values.targetName))
        issue(
          "archive_name",
          "建议归档名包含路径或非法字符，仅保留索引不执行移动",
          row,
        );
      emit("archive_index", row, {
        sha256: file?.sha256 || null,
        sourceVersion: file?.version || null,
        archived: false,
      });
    }
  } else if (workflowId === "contract-terms") {
    for (const row of valid("clauses")) {
      evidence(row, "sourceFileId");
      if (
        !row.values.paymentDate ||
        !row.values.amount ||
        !row.values.currency ||
        !row.values.condition
      )
        issue(
          "contract_unresolved",
          "付款日、金额、币种或条件尚不明确，不能直接进入付款计划",
          row,
        );
      emit("contract_clause_draft", row, {
        interpretation: "待人工逐条核实原文和条件",
        approved: false,
      });
    }
  } else if (workflowId === "local-automation") {
    for (const row of valid("automation")) {
      evidence(row, "sourceFileId");
      check(row, "frequency", ["daily", "weekly", "monthly"]);
      check(row, "action", ["draft", "read_only"]);
      check(row, "enabled", ["no"]);
      if (
        !FINANCE_WORKFLOWS.some((w: any) => w.id === row.values.workflowId) ||
        row.values.workflowId === "local-automation"
      )
        issue("workflow", "待调度工作流无效或递归引用自身", row);
      try {
        new Intl.DateTimeFormat("en", { timeZone: row.values.timezone });
      } catch {
        issue("timezone", "时区不是有效 IANA 时区", row);
      }
      emit("disabled_schedule_draft", row, {
        enabled: "no",
        schedulerInstalled: false,
        executionStarted: false,
      });
    }
  } else if (workflowId === "policy-knowledge") {
    const policies = valid("policies");
    if (policies.length > 2000 || valid("questions").length > 200)
      throw new Error("制度检索每批最多 2000 条条款、200 个问题，请拆分");
    for (const row of policies) {
      if (!evidence(row, "sourceFileId")) row.valid = false;
      check(row, "status", ["current", "expired", "conflicting"]);
      emit("policy_index", row);
    }
    // Bounded literal retrieval; uploaded text is evidence, never executable instructions.
    for (const question of valid("questions")) {
      const candidates = policies.filter(
        (r) => r.valid && r.values.text.includes(question.values.keyword),
      );
      const conflict = candidates.some(
        (r) => r.values.status === "conflicting",
      );
      const current = candidates.filter((r) => r.values.status === "current");
      if (!current.length || conflict)
        issue(
          "policy_unresolved",
          conflict
            ? "相关制度存在冲突，不给确定答案"
            : "未找到现行制度原文依据",
          question,
        );
      emit("policy_evidence", question, {
        answerStatus:
          !current.length || conflict ? "待确认" : "找到相关原文，适用性待确认",
        answer: null,
        evidence: conflict
          ? []
          : current.slice(0, 10).map((r) => ({
              version: r.values.version,
              clause: r.values.clause,
              quote: r.values.text,
              scope: r.values.scope,
              fileId: r.values.sourceFileId,
              source: r.source,
            })),
        totalMatches: current.length,
      });
    }
  } else throw new Error("工作流尚未绑定确定性处理函数");
  for (const table of spec.tables)
    for (const row of tables[table.key])
      if (!row.valid) emit("excluded_input", row, { table: table.key });
  return {
    rows,
    issues,
    trial: [],
    scope: spec.scope,
    manual: spec.manual,
    summary: {
      workflowId,
      workbookCount: input.workbookCount,
      inputRows: Object.values(tables).reduce((n, r) => n + r.length, 0),
      excludedRows: Object.values(tables)
        .flat()
        .filter((r) => !r.valid).length,
      outputRows: rows.length,
      issueCount: issues.length,
      parameters: p,
      totalsScope:
        "仅明确有效且符合各工作流条件的行；各币种单独计算，排除行仍保留",
    },
  };
}
