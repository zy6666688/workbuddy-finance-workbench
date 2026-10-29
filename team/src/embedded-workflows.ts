import { FINANCE_WORKFLOWS } from "../../src/finance-data.js";
import { composeFinanceTask } from "../../src/task-prompt.js";
import {
  readAccountingWorkbook,
  accountingExport,
} from "./accounting-workbook.js";
import { contextualAccountingReport } from "./accounting-context.js";
import { fail, fileBytes } from "./core.js";
import { workflowContracts } from "./workflow-contracts.js";
import { runWorkflowRules } from "./workflow-rules.js";
import { workflowOutputWorkbook } from "./workflow-tables.js";

// These existing workflows can reuse the current accounting workbook engine.
// Rules are explicit local operations, not claims of full autonomous financial judgment.
const accountingWorkflows = new Set([
  "monthly-management-report",
  "vat-monthly-check",
]);
export function embeddedCapability(workflowId: string) {
  return accountingWorkflows.has(workflowId)
    ? {
        executor: "embedded_accounting",
        input: "一份已按本系统财务核对底稿模板填写的 XLSX",
        scope: "确定性账票核对、现有财务报表计算及异常清单；业务判断仍需复核",
      }
    : workflowContracts[workflowId]
      ? {
          executor: "embedded_rules",
          input: "按此工作流字段契约填写的 XLSX，可同时固定依据附件",
          scope: workflowContracts[workflowId].scope,
        }
      : null;
}
export function workflowDefinition(id: string) {
  const workflow = FINANCE_WORKFLOWS.find((w: any) => w.id === id);
  if (!workflow) fail(404, "工作流不存在");
  return {
    ...workflow,
    executionModes: embeddedCapability(id)
      ? ["workbuddy", embeddedCapability(id)!.executor]
      : ["workbuddy"],
    embedded: embeddedCapability(id),
    inputContract: workflowContracts[id] || null,
    templatePath: workflowContracts[id]
      ? `/api/v1/workflows/${id}/template`
      : "/api/v1/accounting/template",
    recommendedExecutionMode: embeddedCapability(id)?.executor || "workbuddy",
    instructions: composeFinanceTask(workflow),
  };
}
export function assertEmbeddedInput(
  workflowId: string,
  files: any[],
  mode?: string,
) {
  if (!embeddedCapability(workflowId))
    fail(400, "此内嵌工作流暂由 WorkBuddy 执行，尚未绑定后台计算器");
  if (mode && mode !== embeddedCapability(workflowId)!.executor)
    fail(400, "执行方式与此工作流能力不一致，请读取工作流定义");
  if (workflowContracts[workflowId]) {
    if (!files.some((f) => /\.xlsx$/i.test(f.name)) || files.length > 20)
      fail(400, "需要至少一份标准 XLSX；含依据附件最多 20 份");
    if (
      files.reduce((n, f) => n + Number(f.size || 0), 0) > 20 * 1024 * 1024 ||
      files.some(
        (f) =>
          /\.xlsx$/i.test(f.name) && Number(f.size || 0) > 10 * 1024 * 1024,
      )
    )
      fail(413, "输入总量最多 20 MB，单份 XLSX 最多 10 MB");
    return;
  }
  if (files.length !== 1 || !/\.xlsx$/i.test(files[0].name))
    fail(
      400,
      "后台账务计算需要一份本系统标准财务核对底稿 XLSX；其他原始资料请先由 WorkBuddy 整理",
    );
  if (Number(files[0].size || 0) > 10 * 1024 * 1024)
    fail(413, "后台计算底稿不能超过 10 MB");
}
export async function calculateEmbedded(
  db: any,
  o: any,
  run: any,
  files: any[],
) {
  assertEmbeddedInput(run.workflow_id, files, run.execution_mode);
  if (run.execution_mode === "embedded_rules") {
    const report = await runWorkflowRules(db, o, run, files);
    const metadata = {
      executor: "embedded_rules",
      workflowId: run.workflow_id,
      runId: run.id,
      companyId: o.company_id,
      period: o.period,
      inputRevision: run.input_revision,
      issueCount: report.issues.length,
      financialReview: "pending",
      scope: report.scope,
      manual: report.manual,
      summary: report.summary,
      sources: files.map((f) => ({
        id: f.id,
        name: f.name,
        version: f.version,
        sha256: f.sha256,
      })),
      sections: ["summary", "issues", "rows"],
    };
    const json = Buffer.from(JSON.stringify({ ...metadata, report }, null, 2));
    if (json.length > 20 * 1024 * 1024)
      fail(413, "结果过大，请按客户/期间/业务拆分任务");
    return {
      metadata,
      files: [
        { name: "计算结果与异常.json", bytes: json },
        {
          name: "工作流处理结果.xlsx",
          bytes: await workflowOutputWorkbook(report),
        },
        {
          name: "计算说明.md",
          bytes: Buffer.from(
            `# 工作流处理结果\n\n${report.scope}\n\n输入 ${report.summary.inputRows} 行，排除 ${report.summary.excludedRows} 行，异常 ${report.issues.length} 项。\n\n${report.manual.join("\n")}\n\n程序只生成内部核对结果/草稿，待独立复核。`,
          ),
        },
      ],
    };
  }
  const source = files[0];
  const payload = await readAccountingWorkbook(
    await fileBytes(source),
    source.name,
  );
  if (Buffer.byteLength(JSON.stringify(payload)) > 2 * 1024 * 1024)
    fail(413, "财务核对底稿超过 2 MB，请按期间整理");
  const report = await contextualAccountingReport(
    db,
    o.company_id,
    o.period,
    payload,
  );
  const metadata = {
    executor: "embedded_accounting",
    workflowId: run.workflow_id,
    runId: run.id,
    companyId: o.company_id,
    period: o.period,
    inputRevision: run.input_revision,
    source: {
      id: source.id,
      name: source.name,
      version: source.version,
      sha256: source.sha256,
    },
    issueCount: report.issues.length,
    financialReview: "pending",
    scope: "本系统确定性核对计算；不自动保存正式账套、过账、申报或开票",
    counts: {
      accounts: payload.accounts.length,
      vouchers: payload.vouchers.length,
      invoices: payload.invoices.length,
    },
    summary: report.summary,
  };
  return {
    metadata,
    files: [
      {
        name: "计算结果与异常.json",
        bytes: Buffer.from(JSON.stringify({ ...metadata, report }, null, 2)),
      },
      {
        name: "财务核对底稿.xlsx",
        bytes: await accountingExport(payload, report),
      },
      {
        name: "计算说明.md",
        bytes: Buffer.from(
          `# 内嵌工作流计算结果\n\n来源：${source.name}\n期间：${o.period}\n异常数：${report.issues.length}\n\n由工作台现有账务计算器处理。原始输入及摘要见清单。需要 WorkBuddy 阅读异常、补充业务解释并回传成果。零差异不代表资料完整，也不代表已记账、开票或复核通过。`,
        ),
      },
    ],
  };
}
