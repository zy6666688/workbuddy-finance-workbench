import ExcelJS from "exceljs";
import AdmZip from "adm-zip";
import { Decimal } from "decimal.js";
import {
  workflowContracts,
  parameterHelp,
  type Field,
} from "./workflow-contracts.js";
import { fail, fileBytes } from "./core.js";

export type Source = {
  fileId: string;
  fileName: string;
  sheet: string;
  row: number;
};
export type Row = {
  values: Record<string, string>;
  source: Source;
  valid: boolean;
};
export type Issue = {
  type: string;
  message: string;
  source?: Source;
  related?: Source[];
};
export function validDate(value: string) {
  return (
    /^20\d{2}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value
  );
}
export function validNumber(value: string, quantity = false) {
  return new RegExp(`^-?\\d{1,12}(\\.\\d{1,${quantity ? 8 : 2}})?$`).test(
    value,
  );
}
export async function workflowTemplate(workflowId: string) {
  const spec = workflowContracts[workflowId];
  if (!spec) fail(400, "此工作流使用账务底稿模板或外部处理方式");
  const book = new ExcelJS.Workbook();
  for (const table of spec.tables) {
    const sheet = book.addWorksheet(table.key);
    sheet.addRow(table.fields.map((f) => f.key));
    sheet.columns.forEach((column) => {
      column.width = 24;
      column.numFmt = "@";
    });
    sheet.getRow(1).font = { bold: true };
  }
  const params = book.addWorksheet("parameters");
  params.addRow(["key", "value"]);
  spec.parameters.forEach((key) => params.addRow([key, ""]));
  params.columns.forEach((column) => {
    column.width = 32;
    column.numFmt = "@";
  });
  const note = book.addWorksheet("填写说明");
  note.addRow(["工作流", workflowId]);
  note.addRow(["程序执行范围", spec.scope]);
  note.addRow([
    "注意",
    "不填示例客户；未知数据留空。文本编号保留前导零，日期为文本 YYYY-MM-DD，金额不得带千分位。公式单元格不参与计算。",
  ]);
  note.addRow([
    "依据",
    "上传前保留原文件/工作表/行号映射；附件编号必须属于本次工作单固定输入。重复明细不自动删除。",
  ]);
  for (const table of spec.tables)
    for (const field of table.fields)
      note.addRow([
        table.key + "." + field.key,
        field.label,
        field.type,
        field.optional ? "可空，缺失不推测" : "必填",
      ]);
  spec.parameters.forEach((key) =>
    note.addRow(["parameters." + key, parameterHelp[key]]),
  );
  spec.manual.forEach((text) => note.addRow(["待人工核实", text]));
  note.columns.forEach((column) => (column.width = 55));
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function readWorkflowTables(workflowId: string, files: any[]) {
  const spec = workflowContracts[workflowId];
  if (!spec) fail(400, "没有此工作流的内置字段契约");
  const tables: Record<string, Row[]> = Object.fromEntries(
    spec.tables.map((t) => [t.key, []]),
  );
  const parameters: Record<string, string> = {},
    issues: Issue[] = [];
  const seenParameters = new Set<string>();
  let rowsRead = 0,
    workbookCount = 0;
  for (const file of files) {
    if (!/\.xlsx$/i.test(file.name)) continue; // Non-workbook attachments remain fixed evidence.
    workbookCount++;
    const bytes = await fileBytes(file),
      zip = new AdmZip(bytes),
      entries = zip.getEntries();
    if (
      entries.length > 200 ||
      entries.reduce((n, e) => n + e.header.size, 0) > 30 * 1024 * 1024
    )
      fail(413, "工作表解压后过大，请拆分任务");
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as any);
    const text = (
      value: ExcelJS.CellValue,
      source: Source,
      field?: Field,
    ): string => {
      if (value === null || value === undefined) return "";
      if (typeof value === "object" || typeof value === "boolean") {
        issues.push({
          type: "cell",
          message: "公式、日期对象或非标文本请先转换为可核验的文本/数值",
          source,
        });
        return "";
      }
      if (field?.type === "text" && typeof value === "number") {
        issues.push({
          type: "identifier",
          message: `${field.key} 必须为文本，避免丢失前导零`,
          source,
        });
        return "";
      }
      const v = String(value).trim();
      if (v.length > 4000) {
        issues.push({
          type: "cell",
          message: "单元格超过 4000 字，请使用原文附件并拆分摘录",
          source,
        });
        return "";
      }
      return v;
    };
    for (const sheet of book.worksheets) {
      if (sheet.name === "填写说明") continue;
      const table = spec.tables.find((t) => t.key === sheet.name);
      if (!table && sheet.name !== "parameters") {
        if (sheet.rowCount > 1)
          issues.push({
            type: "sheet",
            message: `未处理工作表 ${sheet.name}；请按模板映射或从输入中移除无关页`,
            source: {
              fileId: file.id,
              fileName: file.name,
              sheet: sheet.name,
              row: 1,
            },
          });
        continue;
      }
      if (sheet.rowCount > 10001 || sheet.columnCount > 80)
        fail(413, "工作表最多 10000 行、80 列");
      const source = (row: number): Source => ({
        fileId: file.id,
        fileName: file.name,
        sheet: sheet.name,
        row,
      });
      const headers: string[] = [];
      sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
        headers[col - 1] = text(cell.value, source(1));
      });
      const expected = table?.fields.map((f) => f.key) || ["key", "value"];
      const invalidHeader = expected.filter((k) => !headers.includes(k));
      if (
        invalidHeader.length ||
        headers.filter(Boolean).length !==
          new Set(headers.filter(Boolean)).size ||
        headers.some((h) => h && !expected.includes(h))
      ) {
        issues.push({
          type: "headers",
          message: `${sheet.name} 表头须按模板唯一对应；缺列：${invalidHeader.join("、") || "无"}，不允许未知/重复列`,
          source: source(1),
        });
        continue;
      }
      sheet.eachRow((raw, number) => {
        if (number === 1) return;
        if (++rowsRead > 10000) fail(413, "一次工作流最多处理 10000 条输入行");
        const before = issues.length;
        raw.eachCell((cell, col) => {
          if (
            !expected.includes(headers[col - 1]) &&
            cell.value !== null &&
            cell.value !== undefined &&
            cell.value !== ""
          )
            issues.push({
              type: "unmapped_cell",
              message: `第 ${col} 列存在未映射数据，未静默舍弃`,
              source: source(number),
            });
        });
        const values = Object.fromEntries(
          expected.map((key) => [
            key,
            text(
              raw.getCell(headers.indexOf(key) + 1).value,
              source(number),
              table?.fields.find((f) => f.key === key),
            ),
          ]),
        );
        if (!Object.values(values).some(Boolean) && before === issues.length)
          return;
        if (sheet.name === "parameters") {
          if (
            !spec.parameters.includes(values.key) ||
            seenParameters.has(values.key)
          )
            issues.push({
              type: "parameter",
              message: `参数 ${values.key} 未定义或重复；每个任务只提供一份参数`,
              source: source(number),
            });
          else {
            parameters[values.key] = values.value;
            seenParameters.add(values.key);
          }
          return;
        }
        for (const field of table!.fields) {
          const value = values[field.key];
          if (!value && !field.optional)
            issues.push({
              type: "required",
              message: `缺少 ${field.label}`,
              source: source(number),
            });
          if (
            value &&
            ((field.type === "date" && !validDate(value)) ||
              (["money", "quantity"].includes(field.type) &&
                !validNumber(value, field.type === "quantity")))
          )
            issues.push({
              type: "format",
              message: `${field.label} 格式无效，未参与金额计算`,
              source: source(number),
            });
          else if (value && ["money", "quantity"].includes(field.type))
            values[field.key] =
              field.type === "money"
                ? new Decimal(value).toFixed(2)
                : new Decimal(value).toFixed();
        }
        tables[table!.key].push({
          values,
          source: source(number),
          valid: before === issues.length,
        });
      });
    }
  }
  for (const table of spec.tables)
    if (!tables[table.key].length)
      issues.push({
        type: "missing_table",
        message: `缺少非空 ${table.label}（${table.key}）`,
      });
  if (!workbookCount) fail(400, "请提供本工作流标准 XLSX，其他附件仅作为依据");
  for (const key of spec.parameters) {
    const value = parameters[key];
    let valid = !!value;
    if (key === "asOfDate") valid = valid && validDate(value);
    else if (key === "dateToleranceDays")
      valid = valid && /^\d{1,2}$/.test(value) && Number(value) <= 31;
    else if (key !== "cashCurrency")
      valid =
        valid &&
        validNumber(value, key === "varianceThreshold") &&
        new Decimal(value).gte(0);
    if (!valid) {
      delete parameters[key];
      issues.push({
        type: "parameter",
        message: `参数 ${parameterHelp[key] || key} 缺失或无效，相关判断不执行`,
      });
    }
  }
  return { spec, tables, parameters, issues, rowsRead, workbookCount };
}

export async function workflowOutputWorkbook(report: any) {
  const book = new ExcelJS.Workbook();
  let abbreviatedCells = 0;
  const cell = (value: any) => {
    const text =
      typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    if (text.length <= 30000) return text;
    abbreviatedCells++;
    return text.slice(0, 30000) + "…（完整内容见计算结果与异常.json）";
  };
  for (const [name, rows] of [
    ["处理结果", report.rows],
    ["异常清单", report.issues],
  ] as [string, any[]][]) {
    const sheet = book.addWorksheet(name);
    const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    sheet.addRow(keys.length ? keys : ["无明细"]);
    rows.forEach((row) => sheet.addRow(keys.map((key) => cell(row[key]))));
    sheet.columns.forEach((c) => {
      c.width = 28;
      c.numFmt = "@";
    });
    sheet.getRow(1).font = { bold: true };
  }
  const note = book.addWorksheet("范围与校验");
  Object.entries(report.summary).forEach(([key, value]) =>
    note.addRow([
      key,
      typeof value === "object" ? JSON.stringify(value) : String(value),
    ]),
  );
  note.addRow(["范围", report.scope]);
  note.addRow([
    "超长单元格",
    `${abbreviatedCells} 个单元格仅显示摘要；完整结构化原件保存在计算结果与异常.json，并可经分页接口读取。`,
  ]);
  report.manual.forEach((s: string) => note.addRow(["待人工核实", s]));
  note.addRow([
    "结论边界",
    "程序完成不等于财务复核通过；不执行付款、入账、申报、开票、文件移动或调度启用。",
  ]);
  return Buffer.from(await book.xlsx.writeBuffer());
}
