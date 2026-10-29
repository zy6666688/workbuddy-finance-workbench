import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';

// Independent integer-cent oracle: deliberately does not import the production ledger.
for (const basis of ['small_2011', 'enterprise']) for (const industry of ['trade', 'services']) {
  test(`fixed annual acceptance sample: ${basis}/${industry}`, () => {
    const base = new URL(`./fixtures/batch1/${basis}-${industry}/`, import.meta.url);
    const sample = JSON.parse(readFileSync(new URL('sample.json', base), 'utf8'));
    const sources = parse(readFileSync(new URL('business-evidence.csv', base)), { columns: true });
    const check = (journals: any[], evidence: any[]) => {
      assert.equal(new Set(journals.map(j => j.id)).size, journals.length, 'duplicate_record');
      for (const j of journals) {
        const source = evidence.find((s: any) => s.source_id === j.source);
        assert.ok(source, 'missing_source');
        assert.equal(Number(source.amount_cents), j.amount, 'amount_mismatch');
      }
    };
    check(sample.journals, sources);
    assert.equal(new Set(sample.journals.map((j: any) => j.date.slice(0, 7))).size, 12);
    const balances: Record<string, number> = { ...sample.opening };
    for (const j of sample.journals) {
      assert.ok(Number.isSafeInteger(j.amount) && j.amount > 0);
      balances[j.debit] = (balances[j.debit] || 0) + j.amount;
      balances[j.credit] = (balances[j.credit] || 0) - j.amount;
    }
    assert.deepEqual(balances, sample.expected);
    for (const expected of sample.expectedMonthEnds) {
      const monthly: Record<string, number> = { ...sample.opening };
      for (const j of sample.journals.filter((j: any) => j.date.slice(0, 7) <= expected.period)) {
        monthly[j.debit] = (monthly[j.debit] || 0) + j.amount;
        monthly[j.credit] = (monthly[j.credit] || 0) - j.amount;
      }
      assert.equal(monthly.bank, expected.bank, expected.period);
      assert.equal(monthly.receivables, expected.receivables, expected.period);
      assert.equal(-monthly.revenue - monthly.cost - monthly.salary - monthly.depreciation - (monthly.accrued_expense || 0), expected.cumulativeProfit, expected.period);
    }
    assert.equal(Object.values(balances).reduce((a, b) => a + b, 0), 0);
    const profit = -balances.revenue - balances.cost - balances.salary - balances.depreciation - balances.accrued_expense;
    assert.equal(profit, sample.statements.profit);
    assert.equal(sample.statements.assets, sample.statements.liabilities + sample.statements.equityAfterProfit);
    const bank = parse(readFileSync(new URL('bank.csv', base)), { columns: true });
    assert.equal(bank.reduce((s: number, r: any) => s + Number(r.in_cents) - Number(r.out_cents), 0), sample.statements.netCashIncrease);
    assert.equal(balances.bank - sample.opening.bank, sample.statements.netCashIncrease);
    assert.throws(() => check([...sample.journals, sample.journals[0]], sources), /duplicate_record/);
    assert.throws(() => check(sample.journals, sources.slice(1)), /missing_source/);
    assert.throws(() => check(sample.journals, sources.map((s: any, i: number) => i ? s : { ...s, amount_cents: Number(s.amount_cents) + 1 })), /amount_mismatch/);
  });
}
