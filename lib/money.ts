export function asPositiveInteger(value: unknown, field: string, max = 1000000): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`${field} is invalid`);
  return parsed;
}

export function rupeesToPaise(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10000000) throw new Error(`${field} is invalid`);
  return Math.round(parsed * 100);
}

export function orderNumber() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase();
  return `UR${date}-${suffix}`;
}
