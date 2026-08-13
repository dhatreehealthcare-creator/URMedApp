# URMED accounting recognition and closing policy

This policy is the implementation baseline until an accountant approves a signed replacement.

- The source of truth is the append-only `ledger_entries` journal. Operational totals, invoices, COD evidence, returns, and expenses must post through that journal; UI summaries never create accounting evidence.
- Sales income is recognized only at completed fulfilment with paid or reconciled COD evidence. A reservation, cart, delivery assignment, or unpaid order is not income.
- Purchase payable and inventory recognition is recorded when stock is physically received. Draft and approved purchase orders do not affect stock or payables.
- Customer refunds and sales returns reverse the finalized source evidence through immutable credit-note/return postings. They do not mutate the original invoice.
- Supplier returns reverse received purchase quantities and payable evidence. Supplier payment settlement is not inferred from a payable ledger entry.
- GST is reported from the tax/invoice evidence generated for the finalized supply. It is not inferred from a UI total.
- Opening balances are one-time, dated, immutable records. A balanced opening package must be supplied by the accountant; later corrections require an explicit journal/reconciliation process, never an update or delete.
- Accounting periods are inclusive and close permanently. Posting into a closed period is rejected by the database guard. Corrections after close require a new-period adjustment with an audit explanation.
- Trial balance must have equal total debits and credits. P&L is income less expense for the selected period. Balance sheet is assets versus liabilities plus equity and current-period earnings; “sales minus expenses” is not a balance sheet.
- Reconciliation compares an external statement balance with the governed ledger balance and records any variance, reviewer, note, and timestamp. A matched record does not rewrite the journal.

The policy does not yet claim statutory filing, depreciation, accruals, inventory valuation, or accountant-approved tax recognition beyond the explicit rules above. Those require business/accounting sign-off before being automated.
