import { getD1 } from "../../../../db/d1";
import { requireAdminProfile } from "../../../../lib/admin-access";
import { errorResponse } from "../../../../lib/auth-server";
import { getAccountingStatements, getPartySubledger, statementCsv, statementPdf, statementXlsx, validateAccountingPeriod } from "../../../../lib/accounting-statements";
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
    const statement = await getAccountingStatements(getD1(), { start, end, vendorId });
    const format = params.get("format");
    if (format === "csv") return new Response(statementCsv(statement), { headers: { ...headers, "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=urmed-accounting.csv" } });
    if (format === "xlsx") return new Response(await statementXlsx(statement) as unknown as BodyInit, { headers: { ...headers, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": "attachment; filename=urmed-accounting.xlsx" } });
    if (format === "pdf") return new Response(await statementPdf(statement) as unknown as BodyInit, { headers: { ...headers, "Content-Type": "application/pdf", "Content-Disposition": "inline; filename=urmed-accounting.pdf" } });
    const partyType = params.get("partyType") as "supplier" | "customer" | null; const partyId = Number(params.get("partyId"));
    if (partyType && Number.isInteger(partyId) && partyId > 0) return Response.json({ statement, subledger: await getPartySubledger(getD1(), { vendorId, partyType, partyId, start, end }) }, { headers });
    return Response.json(statement, { headers });
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
    if (action === "reconciliation_item") {
      const vendorId = body.vendorId == null || body.vendorId === "" ? null : Number(body.vendorId);
      const accountCode = String(body.accountCode ?? "").trim().toUpperCase();
      const externalReference = String(body.externalReference ?? "").trim().slice(0, 120);
      const externalDate = String(body.externalDate ?? ""); const amountPaise = Number(body.amountPaise); const status = body.status === "ignored" ? "ignored" : "unmatched";
      if (!accountCode || !externalReference || !/^\d{4}-\d{2}-\d{2}$/.test(externalDate) || !Number.isInteger(amountPaise) || amountPaise < 0) return Response.json({ error: "Reconciliation item is invalid" }, { status: 400, headers });
      const result = await db.prepare(`INSERT INTO accounting_reconciliation_items (vendor_id,account_code,period_start,period_end,external_reference,external_date,amount_paise,status,note,created_by_profile_id) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(vendor_id,account_code,external_reference) DO NOTHING`).bind(vendorId, accountCode, String(body.periodStart ?? externalDate), String(body.periodEnd ?? externalDate), externalReference, externalDate, amountPaise, status, String(body.note ?? "").trim().slice(0, 300), profile.id).run();
      if (!result.meta.changes) return Response.json({ error: "External reconciliation reference already exists" }, { status: 409, headers });
      return Response.json({ created: true }, { status: 201, headers });
    }
    if (action === "match_reconciliation_item") {
      const id = Number(body.id); const ledgerEntryId = Number(body.ledgerEntryId);
      if (!Number.isInteger(id) || id < 1 || !Number.isInteger(ledgerEntryId) || ledgerEntryId < 1) return Response.json({ error: "Reconciliation match is invalid" }, { status: 400, headers });
      const result = await db.prepare(`UPDATE accounting_reconciliation_items SET status='matched',matched_ledger_entry_id=?,matched_by_profile_id=?,matched_at=CURRENT_TIMESTAMP,note=? WHERE id=? AND status='unmatched' AND EXISTS (SELECT 1 FROM ledger_entries ledger WHERE ledger.id=? AND ledger.account_code=accounting_reconciliation_items.account_code AND (ledger.vendor_id=accounting_reconciliation_items.vendor_id OR (ledger.vendor_id IS NULL AND accounting_reconciliation_items.vendor_id IS NULL)))`).bind(ledgerEntryId, profile.id, String(body.note ?? "").trim().slice(0, 300), id, ledgerEntryId).run();
      if (!result.meta.changes) return Response.json({ error: "Reconciliation item is already resolved or ledger scope does not match" }, { status: 409, headers });
      await appendAuditEvent({ actorProfileId: profile.id, action: "accounting.reconciliation_item.matched", entityType: "accounting_reconciliation_item", entityId: String(id), after: { ledgerEntryId }, requestId: request.headers.get("cf-ray") ?? "" });
      return Response.json({ matched: true }, { headers });
    }
    return Response.json({ error: "Accounting action is invalid" }, { status: 400, headers });
  } catch (error) { return errorResponse(error); }
}
