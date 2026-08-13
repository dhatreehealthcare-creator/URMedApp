export type AccountingRow = {
  accountCode: string;
  name: string;
  accountType: "asset" | "liability" | "equity" | "income" | "expense";
  normalBalance: "debit" | "credit";
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
};

type Queryable = { prepare: (sql: string) => { bind: (...values: unknown[]) => { all: () => Promise<{ results: unknown[] }> } } };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export function validateAccountingPeriod(start: string, end: string) {
  if (!datePattern.test(start) || !datePattern.test(end) || start > end) throw new Error("Accounting period dates are invalid");
}

export async function getAccountingStatements(db: Queryable, input: { vendorId?: number; start: string; end: string }) {
  validateAccountingPeriod(input.start, input.end);
  const vendorClause = input.vendorId == null ? "" : " AND (vendor_id IS NULL OR vendor_id=?)";
  const args = input.vendorId == null ? [input.start, input.end, input.start, input.end] : [input.start, input.end, input.start, input.end, input.vendorId];
  const rows = await db.prepare(`
    SELECT account.account_code AS accountCode, account.name, account.account_type AS accountType,
      account.normal_balance AS normalBalance,
      COALESCE(SUM(postings.debit_paise),0) AS debitPaise,
      COALESCE(SUM(postings.credit_paise),0) AS creditPaise
    FROM chart_accounts account
    LEFT JOIN (
      SELECT account_code, debit_paise, credit_paise, entry_date, vendor_id
      FROM ledger_entries WHERE date(entry_date) BETWEEN date(?) AND date(?)
      UNION ALL
      SELECT account_code, debit_paise, credit_paise, as_of_date AS entry_date, vendor_id
      FROM accounting_opening_balances WHERE date(as_of_date) <= date(?)
    ) postings ON postings.account_code=account.account_code
      AND date(postings.entry_date) <= date(?)${vendorClause.replace("vendor_id", "postings.vendor_id")}
    WHERE account.active=1
    GROUP BY account.id, account.account_code, account.name, account.account_type, account.normal_balance
    ORDER BY account.account_code`).bind(...args).all();
  const accountRows = (rows.results as Array<Record<string, unknown>>).map((row) => {
    const debitPaise = Number(row.debitPaise ?? 0), creditPaise = Number(row.creditPaise ?? 0);
    return { accountCode: String(row.accountCode), name: String(row.name), accountType: row.accountType as AccountingRow["accountType"], normalBalance: row.normalBalance as AccountingRow["normalBalance"], debitPaise, creditPaise, balancePaise: row.normalBalance === "credit" ? creditPaise - debitPaise : debitPaise - creditPaise };
  });
  const totalDebits = accountRows.reduce((sum, row) => sum + row.debitPaise, 0);
  const totalCredits = accountRows.reduce((sum, row) => sum + row.creditPaise, 0);
  const incomePaise = accountRows.filter((row) => row.accountType === "income").reduce((sum, row) => sum + row.balancePaise, 0);
  const expensePaise = accountRows.filter((row) => row.accountType === "expense").reduce((sum, row) => sum + row.balancePaise, 0);
  const netIncomePaise = incomePaise - expensePaise;
  const assetsPaise = accountRows.filter((row) => row.accountType === "asset").reduce((sum, row) => sum + row.balancePaise, 0);
  const liabilitiesPaise = accountRows.filter((row) => row.accountType === "liability").reduce((sum, row) => sum + row.balancePaise, 0);
  const equityPaise = accountRows.filter((row) => row.accountType === "equity").reduce((sum, row) => sum + row.balancePaise, 0) + netIncomePaise;
  return { period: { start: input.start, end: input.end, vendorId: input.vendorId ?? null }, accounts: accountRows, trialBalance: { totalDebits, totalCredits, balanced: totalDebits === totalCredits }, profitAndLoss: { incomePaise, expensePaise, netIncomePaise }, balanceSheet: { assetsPaise, liabilitiesPaise, equityPaise, balanced: assetsPaise === liabilitiesPaise + equityPaise } };
}
