export type IdentityVerificationStatus =
  | "email_and_phone_pending"
  | "email_pending"
  | "phone_pending"
  | "verified";

export type VendorRegistrationStatus = "draft" | "submitted";

export type VendorAccessStatus =
  | "account_inactive"
  | IdentityVerificationStatus
  | "registration_draft"
  | "review_pending"
  | "operational";

export type ProviderIdentityClaims = {
  email?: string | null;
  phone?: string | null;
  email_confirmed_at?: string | null;
  phone_confirmed_at?: string | null;
};

export type VerificationState = {
  email: string;
  phone: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  identityVerificationStatus: IdentityVerificationStatus;
};

export function normalizeProviderEmail(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().slice(0, 180);
}

export function normalizeIndianMobile(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (/^\d{10}$/.test(digits)) return digits;
  if (/^91\d{10}$/.test(digits)) return digits.slice(2);
  return "";
}

export function getIdentityVerificationStatus(
  emailVerified: boolean,
  phoneVerified: boolean,
): IdentityVerificationStatus {
  if (emailVerified && phoneVerified) return "verified";
  if (!emailVerified && !phoneVerified) return "email_and_phone_pending";
  return emailVerified ? "phone_pending" : "email_pending";
}

export function providerVerificationState(user: ProviderIdentityClaims): VerificationState {
  const email = normalizeProviderEmail(user.email);
  const phone = normalizeIndianMobile(user.phone);
  const emailVerified = Boolean(email && user.email_confirmed_at);
  const phoneVerified = Boolean(phone && user.phone_confirmed_at);
  return {
    email,
    phone,
    emailVerified,
    phoneVerified,
    identityVerificationStatus: getIdentityVerificationStatus(emailVerified, phoneVerified),
  };
}

export function getVendorAccessStatus(input: {
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
  vendorRegistrationStatus?: string | null;
  vendorApprovalStatus?: string | null;
  vendorComplianceStatus?: string | null;
}): VendorAccessStatus {
  if (input.status !== "active") return "account_inactive";
  const identityStatus = getIdentityVerificationStatus(input.emailVerified, input.phoneVerified);
  if (identityStatus !== "verified") return identityStatus;
  if (input.vendorRegistrationStatus !== "submitted") return "registration_draft";
  if (input.vendorApprovalStatus !== "approved" || input.vendorComplianceStatus !== "verified") return "review_pending";
  return "operational";
}

