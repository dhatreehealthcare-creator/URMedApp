export const SAFE_EMAIL_REGISTRATION_NOTICE =
  "If this email can be registered, a verification message will be sent. If an account already exists, sign in with it or contact support.";

export function isProviderIdentityConflict(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null;
  const code = String(value?.code ?? "");
  const message = String(value?.message ?? (error instanceof Error ? error.message : error ?? ""));
  return /already[_ -]?(?:registered|exists)|user[_ -]?already[_ -]?exists|identity[_ -]?already[_ -]?exists|email[_ -]?exists|phone[_ -]?exists/i.test(`${code} ${message}`);
}

export function verifiedContactConflictMessage(field: "email" | "phone") {
  return field === "email"
    ? "This verified email cannot be linked to this account. Sign in to its existing account or contact support."
    : "This verified phone number cannot be linked to this account. Sign in to its existing account or use another verified number.";
}
