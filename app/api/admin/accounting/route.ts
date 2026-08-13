import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";
import { getAccountingStatements, validateAccountingPeriod } from "../../../../lib/accounting-statements";
import { appendAuditEvent } from "../../../../lib/audit";

const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: Request) {
  try {
    await requireAdminProfile(request);
    const params = new URL(request.url).searchParams;
    const start = params.get("start") ?? `${new Date().getUTCFullYear()}-01-01`;
    const end = params.get("end") ?? new Date().toISOString().slice(0, 10);
    const vendorIdValue = params.get("vendorId");
    const vendorId = vendorIdValue ? Number(vendorIdValue) : undefined;
    if (vendorIdValue && (!Number.isInteger(vendorId) || (vendorId as number) < 1)) return Response.json({ error: "Vendor scope is invalid" }, { status: 400, headers });
    try { validateAccountingPeriod(start, end); } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Accounting period dates are invalid" }, { status: 400, headers }); }
    return Response.json(await getAccountingStatements(getD1(), { start, end, vendorId }), { headers });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const profile = await requireAdminProfile(request);
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action ?? "");
    const db = getD1();
    if (action === "opening_balance") {
      const vendorId = body.vendorId == null || body.vendorId === "" ? null : Number(body.vendorId);
      const accountCode = String(body.accountCode ?? "").trim().toUpperCase();
      const asOfDate = String(body.asOfDate ?? "");
      const debitPaise = Math.round(Number(body.debitPaise ?? Number(body.debit ?? 0) * 100));
      const creditPaise = Math.round(Number(body.creditPaise ?? Number(body.credit ?? 0) * 100));
      if ((vendorId !== null && (!Number.isInteger(vendorId) || vendorId < 1)) || !accountCode || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate) || !Number.isInteger(debitPaise) || !Number.isInteger(creditPaise) || debitPaise < 0 || creditPaise < 0 || (debitPaise > 0 && creditPaise > 0)) return Response.json({ error: "Opening balance is invalid" }, { status: 400, headers });
      const result = await db.prepare(`INSERT INTO accounting_opening_balances (vendor_id,account_code,as_of_date,debit_paise,credit_paise,description,created_by_profile_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(vendor_id,account_code,as_of_date) DO NOTHING`).bind(vendorId, accountCode, asOfDate, debitPaise, creditPaise, String(body.description ?? "Opening balance").trim().slice(0, 200) || "Opening balance", profile.id).run();
      if (!result.meta.changes) return Response.json({ error: "An opening balance already exists for this account and date" }, { status: 409, headers });
      await appendAuditEvent({ actorProfileId: profile.id, action: "accounting.opening_balance.created", entityType: "accounting_opening_balance", entityId: accountCode, after: { vendorId, asOfDate, debitPaise, creditPaise }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ created: true }, { status: 201, headers });
    }
    if (action === "period") {
      const vendorId = body.vendorId == null || body.vendorId === "" ? null : Number(body.vendorId);
      const periodStart = String(body.periodStart ?? ""), periodEnd = String(body.periodEnd ?? "");
      validateAccountingPeriod(periodStart, periodEnd);
      const status = body.status === "closed" ? "closed" : "open";
      const result = await db.prepare(`INSERT INTO accounting_periods (vendor_id,period_start,period_end,status,closed_by_profile_id,closed_at) VALUES (?,?,?,?,?,CASE WHEN ?='closed' THEN CURRENT_TIMESTAMP ELSE NULL END) ON CONFLICT(vendor_id,period_start,period_end) DO NOTHING`).bind(vendorId, periodStart, periodEnd, status, status === "closed" ? profile.id : null, status).run();
      if (!result.meta.changes) return Response.json({ error: "An accounting period already exists and cannot be reopened or changed" }, { status: 409, headers });
      await appendAuditEvent({ actorProfileId: profile.id, action: `accounting.period.${status}`, entityType: "accounting_period", entityId: `${vendorId ?? "global"}:${periodStart}:${periodEnd}`, after: { vendorId, periodStart, periodEnd, status }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ saved: true, changes: result.meta.changes }, { headers });
    }
    if (action === "reconcile") {
      const vendorId = body.vendorId == null || body.vendorId === "" ? null : Number(body.vendorId);
      const accountCode = String(body.accountCode ?? "").trim().toUpperCase();
      const periodStart = String(body.periodStart ?? ""), periodEnd = String(body.periodEnd ?? "");
      const statementPaise = Number(body.statementPaise);
      validateAccountingPeriod(periodStart, periodEnd);
      if (!accountCode || !Number.isInteger(statementPaise)) return Response.json({ error: "Reconciliation is invalid" }, { status: 400, headers });
      const row = await db.prepare(`SELECT COALESCE(SUM(debit_paise-credit_paise),0) AS balance FROM ledger_entries WHERE account_code=? AND date(entry_date) BETWEEN date(?) AND date(?) AND (vendor_id IS NULL OR vendor_id=?)`).bind(accountCode, periodStart, periodEnd, vendorId).first<{ balance: number }>();
      const ledgerPaise = Number(row?.balance ?? 0), variancePaise = statementPaise - ledgerPaise, status = variancePaise === 0 ? "matched" : "exception";
      await db.prepare(`INSERT INTO accounting_reconciliations (vendor_id,account_code,period_start,period_end,ledger_paise,statement_paise,variance_paise,status,note,reviewed_by_profile_id,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(vendor_id,account_code,period_start,period_end) DO UPDATE SET ledger_paise=excluded.ledger_paise,statement_paise=excluded.statement_paise,variance_paise=excluded.variance_paise,status=excluded.status,note=excluded.note,reviewed_by_profile_id=excluded.reviewed_by_profile_id,reviewed_at=CURRENT_TIMESTAMP`).bind(vendorId, accountCode, periodStart, periodEnd, ledgerPaise, statementPaise, variancePaise, status, String(body.note ?? "").trim().slice(0, 300), profile.id).run();
      await appendAuditEvent({ actorProfileId: profile.id, action: "accounting.reconciliation.reviewed", entityType: "accounting_reconciliation", entityId: `${accountCode}:${periodStart}:${periodEnd}`, after: { vendorId, ledgerPaise, statementPaise, variancePaise, status }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ ledgerPaise, statementPaise, variancePaise, status }, { headers });
    }
    return Response.json({ error: "Accounting action is invalid" }, { status: 400, headers });
  } catch (error) { return errorResponse(error); }
}
