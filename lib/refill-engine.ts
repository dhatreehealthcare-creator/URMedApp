export type RefillStatus = "active" | "due" | "overdue" | "snoozed" | "completed" | "cancelled";

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function estimateRefillDueDate(deliveredAt: string | Date, daysSupply = 30) {
  if (!Number.isInteger(daysSupply) || daysSupply < 1 || daysSupply > 365) throw new Error("Days supply must be between 1 and 365");
  const delivered = deliveredAt instanceof Date ? new Date(deliveredAt) : new Date(deliveredAt);
  if (Number.isNaN(delivered.getTime())) throw new Error("Delivery date is invalid");
  delivered.setUTCDate(delivered.getUTCDate() + daysSupply);
  return isoDate(delivered);
}

export function validateRefillDate(value: unknown, today = new Date()) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(new Date(`${text}T00:00:00.000Z`).getTime())) {
    throw new Error("Choose a valid reminder date");
  }
  const maximum = new Date(today);
  maximum.setUTCDate(maximum.getUTCDate() + 365);
  if (text > isoDate(maximum)) throw new Error("Reminder date cannot be more than one year away");
  return text;
}

export function effectiveRefillStatus(reminder: { status: string; dueDate: string; snoozedUntil?: string | null }, today = new Date()): RefillStatus {
  if (reminder.status === "completed" || reminder.status === "cancelled") return reminder.status;
  const current = isoDate(today);
  if (reminder.snoozedUntil && reminder.snoozedUntil >= current) return "snoozed";
  if (reminder.dueDate < current) return "overdue";
  if (reminder.dueDate === current) return "due";
  return "active";
}
