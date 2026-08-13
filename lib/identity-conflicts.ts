export type IdentityConflictField = "email" | "phone";

const defaultMessage = "This verified contact is already linked to another URMED account";

export class IdentityConflictError extends Error {
  readonly code = "identity_conflict";
  readonly fields: IdentityConflictField[];

  constructor(fields: IdentityConflictField[], message = defaultMessage) {
    super(message);
    this.name = "IdentityConflictError";
    this.fields = [...new Set(fields)];
  }
}

export function identityConflictFromDatabaseError(error: unknown): IdentityConflictError | null {
  if (error instanceof IdentityConflictError) return error;
  const detail = error instanceof Error ? error.message : String(error ?? "");
  if (!/unique constraint|constraint failed|SQLITE_CONSTRAINT|D1_ERROR/i.test(detail)) return null;

  const fields: IdentityConflictField[] = [];
  if (/account_profiles(?:_normalized)?_email_uidx|vendors_email_uidx|(?:account_profiles|vendors)\.email/i.test(detail)) fields.push("email");
  if (/account_profiles_phone_uidx|vendors_phone_uidx|(?:account_profiles|vendors)\.phone/i.test(detail)) fields.push("phone");
  return fields.length ? new IdentityConflictError(fields) : null;
}

export function identityConflictMessage(fields: IdentityConflictField[]) {
  if (fields.length !== 1) return defaultMessage;
  return fields[0] === "email"
    ? "This verified email is already linked to another URMED account"
    : "This verified phone number is already linked to another URMED account";
}

