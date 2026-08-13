import assert from "node:assert/strict";
import test from "node:test";

const source = await import("../lib/accounting-statements.ts");

test("accounting period validation rejects malformed or reversed periods", () => {
  source.validateAccountingPeriod("2026-01-01", "2026-12-31");
  assert.throws(() => source.validateAccountingPeriod("2026-02-01", "2026-01-31"), /invalid/);
  assert.throws(() => source.validateAccountingPeriod("2026-1-01", "2026-01-31"), /invalid/);
});

test("statements derive trial balance, P&L and balance sheet from governed rows", async () => {
  const sql = [];
  const db = {
    prepare(query) {
      sql.push(query);
      return {
        bind(...args) {
          return {
            all: async () => {
              assert.deepEqual(args, ["2026-01-01", "2026-12-31", "2026-01-01", "2026-12-31", 7]);
              return { results: [
                { accountCode: "CASH_BANK", name: "Cash and bank", accountType: "asset", normalBalance: "debit", debitPaise: 11800, creditPaise: 0 },
                { accountCode: "SALES", name: "Medicine sales", accountType: "income", normalBalance: "credit", debitPaise: 0, creditPaise: 10000 },
                { accountCode: "EXPENSE", name: "Operating expense", accountType: "expense", normalBalance: "debit", debitPaise: 2000, creditPaise: 0 },
              ] };
            },
          };
        },
      };
    },
  };
  const statement = await source.getAccountingStatements(db, { vendorId: 7, start: "2026-01-01", end: "2026-12-31" });
  assert.equal(statement.trialBalance.totalDebits, 13800);
  assert.equal(statement.trialBalance.totalCredits, 10000);
  assert.equal(statement.profitAndLoss.netIncomePaise, 8000);
  assert.equal(statement.balanceSheet.assetsPaise, 11800);
  assert.equal(statement.balanceSheet.equityPaise, 8000);
  assert.equal(statement.balanceSheet.balanced, false);
  assert.match(sql[0], /accounting_opening_balances/);
});

test("accounting migration seeds legacy posting codes and immutable controls", async () => {
  const fs = await import("node:fs/promises");
  const migration = await fs.readFile("drizzle/0053_accounting_statements.sql", "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS `chart_accounts`/);
  assert.match(migration, /'SALES'.*'Medicine sales'/s);
  assert.match(migration, /ledger_entries_closed_period_guard/);
  assert.match(migration, /accounting_opening_balances_no_delete/);
  assert.match(migration, /accounting_periods_closed_guard/);
});

test("party sub-ledger and export contracts are protected and deterministic", async () => {
  const fs = await import("node:fs/promises");
  const [route, policy] = await Promise.all([
    fs.readFile("app/api/admin/accounting/route.ts", "utf8"),
    fs.readFile("docs/ACCOUNTING_RECOGNITION_AND_CLOSING_POLICY.md", "utf8"),
  ]);
  assert.match(route, /partyType/);
  assert.match(route, /format === "xlsx"/);
  assert.match(route, /format === "pdf"/);
  assert.match(policy, /Sales income is recognized only at completed fulfilment/);
  assert.match(policy, /close permanently/);
});

test("all operational report routes expose csv, xlsx and pdf export contracts", async () => {
  const fs = await import("node:fs/promises");
  for (const file of ["expenses", "sales", "stock", "home-delivery"]) {
    const route = await fs.readFile(`app/api/admin/reports/${file}/route.ts`, "utf8");
    assert.match(route, /reportFormat/);
    assert.match(route, /reportExportResponse/);
  }
  const reporting = await fs.readFile("lib/admin-reporting.ts", "utf8");
  assert.match(reporting, /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
  assert.match(reporting, /application\/pdf/);
  assert.match(reporting, /private, no-store/);
});
