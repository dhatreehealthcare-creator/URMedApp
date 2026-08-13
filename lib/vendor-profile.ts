export type LicenceDisplayState =
  | "expired"
  | "expiring_soon"
  | "pending_review"
  | "rejected"
  | "current";

export type VendorLicenceSummary = {
  validUntil: string;
  verificationStatus: string;
};

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

export function passwordPolicyMessage(value: unknown): string | null {
  const password = String(value ?? "");
  if (password.length < 12) return "The new password must contain at least 12 characters";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return "Use uppercase, lowercase, a number and a symbol in the new password";
  }
  return null;
}

export function licenceDisplayState(
  licence: VendorLicenceSummary,
  today = new Date(),
): LicenceDisplayState {
  if (licence.verificationStatus === "rejected") return "rejected";
  if (licence.verificationStatus !== "verified") return "pending_review";
  if (!isoDatePattern.test(licence.validUntil)) return "expired";
  const expiry = Date.parse(`${licence.validUntil}T00:00:00.000Z`);
  const currentDay = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  if (!Number.isFinite(expiry) || expiry < currentDay) return "expired";
  const reminderBoundary = new Date(currentDay);
  reminderBoundary.setUTCMonth(reminderBoundary.getUTCMonth() + 3);
  return expiry <= reminderBoundary.getTime() ? "expiring_soon" : "current";
}

export function selectCurrentLicence<T extends VendorLicenceSummary>(licences: T[], today = new Date()): T | null {
  const priority: Record<LicenceDisplayState, number> = {
    current: 5,
    expiring_soon: 4,
    pending_review: 3,
    rejected: 2,
    expired: 1,
  };
  return [...licences].sort((left, right) => {
    const stateDifference = priority[licenceDisplayState(right, today)] - priority[licenceDisplayState(left, today)];
    return stateDifference || right.validUntil.localeCompare(left.validUntil);
  })[0] ?? null;
}

export function isVerifiedPhoneChangeReady(input: {
  originalPhone: string;
  originalPhoneVerified: boolean;
  draftPhone: string;
  providerVerifiedPhone: string;
}) {
  return /^\d{10}$/.test(input.draftPhone)
    && (
      (input.draftPhone === input.originalPhone && input.originalPhoneVerified)
      || input.providerVerifiedPhone === input.draftPhone
    );
}
