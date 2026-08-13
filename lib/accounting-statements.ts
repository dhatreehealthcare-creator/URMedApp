export type AccountingRow = {
  accountCode: string;
  name: string;
  accountType: "asset" | "liability" | "equity" | "income" | "expense";
  normalBalance: "debit" | "credit";
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
};

export type PartyLedgerRow = { id: number; accountCode: string; entryDate: string; description: string; debitPaise: number; creditPaise: number; referenceType: string; referenceId: number | null };

type Queryable = { prepare: (sql: string) => { bind: (...values: unknown[]) => { all: () => Promise<{ results: unknown[] }>; first: <T>() => Promise<T | null> } } };

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

export async function getPartySubledger(db: Queryable, input: { vendorId?: number; partyType: "supplier" | "customer"; partyId: number; start: string; end: string }) {
  validateAccountingPeriod(input.start, input.end);
  const row = await db.prepare(`SELECT id,party_type AS partyType,party_ref_id AS partyId,display_name AS displayName,vendor_id AS vendorId FROM accounting_parties WHERE party_type=? AND party_ref_id=? AND (vendor_id IS NULL OR vendor_id=?) AND active=1 LIMIT 1`).bind(input.partyType, input.partyId, input.vendorId ?? null).first<Record<string, unknown>>();
  if (!row) return null;
  const result = await db.prepare(`SELECT entry.id,entry.account_code AS accountCode,entry.entry_date AS entryDate,entry.description,entry.debit_paise AS debitPaise,entry.credit_paise AS creditPaise,entry.reference_type AS referenceType,entry.reference_id AS referenceId FROM ledger_entries entry WHERE entry.party_id=? AND date(entry.entry_date) BETWEEN date(?) AND date(?) ORDER BY date(entry.entry_date),entry.id`).bind(Number(row.id), input.start, input.end).all();
  const entries = result.results as PartyLedgerRow[];
  return { party: row, entries, totals: { debitPaise: entries.reduce((sum, entry) => sum + Number(entry.debitPaise), 0), creditPaise: entries.reduce((sum, entry) => sum + Number(entry.creditPaise), 0) } };
}

function escapeXml(value: string) { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;"); }

export function statementCsv(statement: Awaited<ReturnType<typeof getAccountingStatements>>) {
  const lines = [["Account code", "Account", "Type", "Debit (paise)", "Credit (paise)", "Balance (paise)"], ...statement.accounts.map((row) => [row.accountCode, row.name, row.accountType, row.debitPaise, row.creditPaise, row.balancePaise])];
  return lines.map((line) => line.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
}

export async function statementXlsx(statement: Awaited<ReturnType<typeof getAccountingStatements>>) {
  const { zipSync, strToU8 } = await import("fflate");
  const rows = [["Account code", "Account", "Type", "Debit (paise)", "Credit (paise)", "Balance (paise)"], ...statement.accounts.map((row) => [row.accountCode, row.name, row.accountType, row.debitPaise, row.creditPaise, row.balancePaise])];
  const cells = rows.map((row, rowIndex) => `<row r="${rowIndex + 1}">${row.map((value, colIndex) => { const ref = `${String.fromCharCode(65 + colIndex)}${rowIndex + 1}`; return typeof value === "number" ? `<c r="${ref}"><v>${value}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${escapeXml(String(value))}</t></is></c>`; }).join("")}</row>`).join("");
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${cells}</sheetData></worksheet>`),
  };
  return zipSync(files, { level: 6 });
}

export async function statementPdf(statement: Awaited<ReturnType<typeof getAccountingStatements>>) {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const document = await PDFDocument.create(); const page = document.addPage([595, 842]); const font = await document.embedFont(StandardFonts.Helvetica); let y = 800;
  page.drawText("URMED ACCOUNTING STATEMENT", { x: 40, y, size: 16, font, color: rgb(0.05, 0.3, 0.25) }); y -= 26;
  page.drawText(`${statement.period.start} to ${statement.period.end}`, { x: 40, y, size: 10, font }); y -= 25;
  page.drawText(`Trial balance: ${statement.trialBalance.balanced ? "BALANCED" : "EXCEPTION"}`, { x: 40, y, size: 11, font }); y -= 18;
  page.drawText(`P&L net income: ${(statement.profitAndLoss.netIncomePaise / 100).toFixed(2)} INR`, { x: 40, y, size: 11, font }); y -= 18;
  page.drawText(`Balance sheet: ${statement.balanceSheet.balanced ? "BALANCED" : "EXCEPTION"}`, { x: 40, y, size: 11, font }); y -= 30;
  for (const row of statement.accounts) { if (y < 45) { y = 800; document.addPage([595, 842]); } page.drawText(`${row.accountCode} ${row.name.slice(0, 32)}  Dr ${row.debitPaise}  Cr ${row.creditPaise}  Bal ${row.balancePaise}`, { x: 40, y, size: 8, font }); y -= 14; }
  return document.save();
}
