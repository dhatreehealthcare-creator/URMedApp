import { prepareAuditEventStatement } from "./audit.ts";

export type PostAdminExpenseInput = {
  db: D1Database;
  vendorId: number | null;
  purpose: string;
  expenseHead: string;
  amountPaise: number;
  expenseDate: string;
  paymentMode: string;
  referenceNumber: string;
  actorProfileId: number;
  requestId?: string;
};

export async function postAdminExpense(input: PostAdminExpenseInput) {
  const next = await input.db.prepare("SELECT COALESCE(MAX(id),0)+1 AS id FROM expenses")
    .first<{ id: number }>();
  const expenseId = Number(next?.id);
  if (!Number.isInteger(expenseId) || expenseId < 1) throw new Error("Expense identifier could not be allocated");
  const audit = await prepareAuditEventStatement({
    vendorId: input.vendorId,
    actorProfileId: input.actorProfileId,
    action: "expense.created",
    entityType: "expense",
    entityId: expenseId,
    after: {
      purpose: input.purpose,
      expenseHead: input.expenseHead,
      amountPaise: input.amountPaise,
      expenseDate: input.expenseDate,
      paymentMode: input.paymentMode,
    },
    requestId: input.requestId ?? "",
  }, input.db);
  const results = await input.db.batch([
    input.db.prepare(`INSERT INTO expenses
      (id,vendor_id,purpose,expense_head,amount_paise,expense_date,payment_mode,reference_number,created_by_profile_id)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(expenseId, input.vendorId, input.purpose, input.expenseHead,
      input.amountPaise, input.expenseDate, input.paymentMode, input.referenceNumber, input.actorProfileId),
    input.db.prepare(`INSERT INTO ledger_entries
      (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
      VALUES (?,'EXPENSE',?,?,?,0,'expense',?,?)`).bind(input.vendorId, input.expenseDate,
      input.purpose, input.amountPaise, expenseId, input.actorProfileId),
    input.db.prepare(`INSERT INTO ledger_entries
      (vendor_id,account_code,entry_date,description,debit_paise,credit_paise,reference_type,reference_id,created_by_profile_id)
      VALUES (?,'CASH_BANK',?,?,0,?,'expense',?,?)`).bind(input.vendorId, input.expenseDate,
      input.purpose, input.amountPaise, expenseId, input.actorProfileId),
    audit,
  ]);
  if (results.some((result) => Number(result.meta.changes ?? 0) !== 1)) {
    throw new Error("Expense accounting batch did not persist all evidence");
  }
  return { expenseId };
}
