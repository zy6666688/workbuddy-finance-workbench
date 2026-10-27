import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  readTable,
  validateRows,
  reconcile,
  templateFile,
} from "../src/tables.js";
import { validateFile } from "../src/server.js";

test("decimal sums, required fields, duplicates, date and period checks", () => {
  const r = validateRows(
    "bank",
    [
      { date: "2026-01-01", reference: "A", amount: "0.1" },
      { date: "2026-01-02", reference: "B", amount: "0.2" },
    ],
    {},
    "2026-01",
  );
  assert.equal(r.total, "0.30");
  assert.deepEqual(r.errors, []);
  assert.ok(
    validateRows(
      "bank",
      [{ date: "2026-02-30", reference: "", amount: "1e3" }],
      {},
      "2026-01",
    ).errors.length >= 4,
  );
  assert.ok(
    validateRows("companies", [
      { code: "A", name: "A" },
      { code: "A", name: "B" },
    ]).errors.length,
  );
  assert.throws(() => validateRows("bank", Array(10001).fill({})));
});
test("ambiguous bank candidates are never auto-matched", () => {
  const a = { date: "2026-01-01", reference: "A", amount: "1.00" };
  const b = { date: "2026-01-02", reference: "B", amount: "0.20" };
  const r = reconcile([a, a, b], [a, b]);
  assert.equal(r.matched.length, 1);
  assert.equal(r.ambiguous.length, 1);
  assert.equal(r.difference, "1.00");
});
test("Excel/CSV templates, field mapping and formula rejection", async () => {
  for (const kind of ["companies", "materials", "bank", "ledger", "delivery"])
    for (const format of ["csv", "xlsx"])
      assert.deepEqual(
        await readTable(await templateFile(kind, format), `template.${format}`),
        [],
      );
  const rows = await readTable(
    Buffer.from("日期,单号,金额\n2026-01-01,A,1.23\n"),
    "input.csv",
  );
  assert.equal(
    validateRows(
      "bank",
      rows,
      { date: "日期", reference: "单号", amount: "金额" },
      "2026-01",
    ).total,
    "1.23",
  );
  const b = new ExcelJS.Workbook(),
    s = b.addWorksheet("sheet");
  s.addRow(["amount"]);
  s.addRow([{ formula: "1+1", result: 2 }]);
  await assert.rejects(
    readTable(Buffer.from(await b.xlsx.writeBuffer()), "input.xlsx"),
    /公式/,
  );
  assert.throws(() => validateFile(Buffer.from("MZexe"), ".txt"), /可执行/);
  assert.throws(() => validateFile(Buffer.alloc(0), ".xlsx"), /格式/);
});
