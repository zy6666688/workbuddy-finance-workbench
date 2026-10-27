import ExcelJS from "exceljs";
import { parse } from "csv-parse/sync";
import { Decimal } from "decimal.js";
import AdmZip from "adm-zip";
import { fail, sha } from "./core.js";

export const templates: Record<string, string[]> = {
  companies: ["code", "name"],
  materials: ["category", "required"],
  bank: ["date", "reference", "amount", "description"],
  ledger: ["date", "reference", "amount", "description"],
  delivery: ["period", "file", "note"],
};
export async function readTable(
  bytes: Buffer,
  name: string,
): Promise<Record<string, string>[]> {
  if (bytes.length > 10 * 1024 * 1024) fail(413, "表格不得超过10MB");
  const validateHeaders = (headers: string[]) => {
    if (
      headers.length > 100 ||
      headers.some((h) => !h.trim()) ||
      new Set(headers).size !== headers.length
    )
      fail(400, "列名必须唯一、非空，且最多100列");
    return headers;
  };
  if (name.toLowerCase().endsWith(".csv"))
    return parse(bytes.toString("utf8").replace(/^\uFEFF/, ""), {
      columns: validateHeaders,
      skip_empty_lines: true,
      max_record_size: 100000,
      trim: true,
      to: 10001,
    });
  if (!name.toLowerCase().endsWith(".xlsx"))
    fail(400, "结构化导入仅支持CSV或XLSX");
  const entries = new AdmZip(bytes).getEntries();
  if (
    entries.length > 1000 ||
    entries.reduce((n, e) => n + e.header.size, 0) > 50 * 1024 * 1024
  )
    fail(413, "表格解压体积过大");
  if (entries.some((e) => /vbaProject|externalLinks/i.test(e.entryName)))
    fail(400, "不接受宏或外部链接表格");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes as any);
  const sheet = book.worksheets[0];
  if (!sheet) fail(400, "没有工作表");
  if (sheet.rowCount > 10001 || sheet.columnCount > 100)
    fail(413, "每次最多10000行、100列");
  const headers = validateHeaders(
    (sheet.getRow(1).values as any[]).slice(1).map(String),
  );
  const rows: Record<string, string>[] = [];
  sheet.eachRow((r, i) => {
    if (i === 1) return;
    const row: Record<string, string> = {};
    headers.forEach((h, j) => {
      const c = r.getCell(j + 1);
      if (c.type === ExcelJS.ValueType.Formula)
        fail(400, "导入表格请先将公式转换成数值");
      row[h] =
        c.value instanceof Date ? c.value.toISOString().slice(0, 10) : c.text;
    });
    rows.push(row);
  });
  return rows;
}
export function validateRows(
  kind: string,
  rows: Record<string, string>[],
  mapping: Record<string, string> = {},
  period?: string,
) {
  const headers = templates[kind];
  if (!headers) fail(400, "未知模板");
  if (rows.length > 10000) fail(413, "每次最多10000行");
  const errors: { row: number; message: string }[] = rows.length
    ? []
    : [{ row: 1, message: "表格没有数据行" }];
  const seen = new Set<string>();
  let total = new Decimal(0);
  const normalized = rows.map((raw, i) => {
    const row = Object.fromEntries(
      headers.map((h) => [h, String(raw[mapping[h] || h] ?? "").trim()]),
    );
    const required =
      kind === "companies"
        ? ["code", "name"]
        : kind === "materials"
          ? ["category", "required"]
          : kind === "delivery"
            ? ["period", "file"]
            : ["date", "reference", "amount"];
    required.forEach((h) => {
      if (!row[h]) errors.push({ row: i + 2, message: `缺少 ${h}` });
    });
    if (kind === "bank" || kind === "ledger") {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
        Number.isNaN(Date.parse(row.date)) ||
        new Date(row.date).toISOString().slice(0, 10) !== row.date
      )
        errors.push({ row: i + 2, message: "日期无效" });
      if (period && !row.date.startsWith(period + "-"))
        errors.push({ row: i + 2, message: "日期不在所选期间" });
      if (!/^-?\d{1,14}(\.\d{1,2})?$/.test(row.amount))
        errors.push({
          row: i + 2,
          message: "金额最多两位小数且必须是普通数字",
        });
      else {
        row.amount = new Decimal(row.amount).toFixed(2);
        total = total.plus(row.amount);
      }
    }
    if (kind === "materials" && !["true", "false"].includes(row.required))
      errors.push({ row: i + 2, message: "required 必须为 true 或 false" });
    if (
      kind === "delivery" &&
      (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(row.period) ||
        (period && row.period !== period))
    )
      errors.push({
        row: i + 2,
        message: "交付清单期间无效或与所选期间不一致",
      });
    const key =
      kind === "companies"
        ? row.code
        : kind === "materials"
          ? row.category
          : JSON.stringify(row);
    if (seen.has(key)) errors.push({ row: i + 2, message: "重复记录，请复核" });
    seen.add(key);
    return row;
  });
  return {
    rows: normalized,
    errors,
    total: total.toFixed(2),
    count: rows.length,
    digest: sha(JSON.stringify({ kind, normalized, period })),
  };
}
export function reconcile(
  bank: Record<string, string>[],
  ledger: Record<string, string>[],
) {
  const key = (r: Record<string, string>) =>
    `${r.date}|${r.reference}|${new Decimal(r.amount).toFixed(2)}`;
  const group = (rows: Record<string, string>[]) => {
    const m = new Map<string, number[]>();
    rows.forEach((r, i) => m.set(key(r), [...(m.get(key(r)) || []), i]));
    return m;
  };
  const b = group(bank),
    l = group(ledger);
  const matched: any[] = [],
    ambiguous: any[] = [],
    unmatchedBank: any[] = [],
    unmatchedLedger: any[] = [];
  for (const k of new Set([...b.keys(), ...l.keys()])) {
    const x = b.get(k) || [],
      y = l.get(k) || [];
    if (x.length === 1 && y.length === 1)
      matched.push({ bankRow: x[0] + 2, ledgerRow: y[0] + 2 });
    else if (x.length && y.length)
      ambiguous.push({
        bankRows: x.map((i) => i + 2),
        ledgerRows: y.map((i) => i + 2),
      });
    else {
      x.forEach((i) => unmatchedBank.push({ row: i + 2, ...bank[i] }));
      y.forEach((i) => unmatchedLedger.push({ row: i + 2, ...ledger[i] }));
    }
  }
  const sum = (r: Record<string, string>[]) =>
    r.reduce((s, r) => s.plus(r.amount), new Decimal(0));
  return {
    matched,
    ambiguous,
    unmatchedBank,
    unmatchedLedger,
    bankTotal: sum(bank).toFixed(2),
    ledgerTotal: sum(ledger).toFixed(2),
    difference: sum(bank).minus(sum(ledger)).toFixed(2),
  };
}
export async function templateFile(kind: string, format: string) {
  const headers = templates[kind];
  if (!headers) fail(404, "模板不存在");
  if (format === "csv")
    return Buffer.from("\uFEFF" + headers.join(",") + "\r\n");
  const b = new ExcelJS.Workbook();
  const s = b.addWorksheet("模板");
  s.addRow(headers);
  s.columns.forEach((c) => (c.width = 22));
  s.getRow(1).font = { bold: true };
  return Buffer.from(await b.xlsx.writeBuffer());
}
