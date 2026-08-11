export function isStrictIsoDate(value: unknown): value is string {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === text;
}

export function requireIsoDate(value: unknown, label: string, optional = false) {
  const text = String(value ?? "").trim();
  if (optional && !text) return null;
  if (!isStrictIsoDate(text)) throw new Response(`${label} is invalid`, { status: 400 });
  return text;
}
