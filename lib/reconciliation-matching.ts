export type ReconciliationCandidate = {
  itemId: number;
  ledgerEntryId: number;
  itemAmountPaise: number;
  ledgerAmountPaise: number;
  differencePaise: number;
  dateDistanceDays: number;
  confidence: "exact" | "tolerated";
};

type MatchItem = { id: number; amountPaise: number; externalDate: string; externalReference: string };
type LedgerRow = { id: number; amountPaise: number; entryDate: string; description: string };

function daysBetween(left: string, right: string) {
  const a = Date.parse(`${left}T00:00:00Z`), b = Date.parse(`${right}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.abs(Math.round((a - b) / 86_400_000)) : Number.POSITIVE_INFINITY;
}

/** Deterministic candidates only; this never approves or posts a match. */
export function findReconciliationCandidates(input: {
  items: MatchItem[];
  ledger: LedgerRow[];
  amountTolerancePaise?: number;
  dateToleranceDays?: number;
}) {
  const amountTolerancePaise = Math.max(0, Math.min(100_000, Math.trunc(input.amountTolerancePaise ?? 0)));
  const dateToleranceDays = Math.max(0, Math.min(31, Math.trunc(input.dateToleranceDays ?? 0)));
  const candidates: ReconciliationCandidate[] = [];
  for (const item of input.items) {
    const rows = input.ledger.map((entry) => {
      const differencePaise = Math.abs(Number(item.amountPaise) - Number(entry.amountPaise));
      const dateDistanceDays = daysBetween(item.externalDate, entry.entryDate);
      const referenceMatch = item.externalReference && entry.description.toLowerCase().includes(item.externalReference.toLowerCase());
      if (differencePaise > amountTolerancePaise || dateDistanceDays > dateToleranceDays) return null;
      return { itemId: item.id, ledgerEntryId: entry.id, itemAmountPaise: item.amountPaise, ledgerAmountPaise: entry.amountPaise, differencePaise, dateDistanceDays, confidence: differencePaise === 0 && dateDistanceDays === 0 ? "exact" as const : referenceMatch ? "tolerated" as const : "tolerated" as const };
    }).filter((candidate): candidate is ReconciliationCandidate => Boolean(candidate));
    rows.sort((a, b) => a.differencePaise - b.differencePaise || a.dateDistanceDays - b.dateDistanceDays || a.ledgerEntryId - b.ledgerEntryId);
    candidates.push(...rows.slice(0, 5));
  }
  return candidates;
}
