export type VendorRegistrationNextAction =
  | "verify_email"
  | "verify_phone"
  | "complete_registration"
  | "resolve_rejection"
  | "add_pharmacist"
  | "awaiting_review"
  | "operational";

export type VendorRegistrationStatusInput = {
  emailVerified: boolean;
  phoneVerified: boolean;
  registrationStatus: string;
  approvalStatus: string;
  complianceStatus: string;
  currentLicenceCount: number;
  verifiedLicenceCount: number;
  pharmacistCount: number;
  verifiedPharmacistCount: number;
};

export function getVendorRegistrationNextAction(input: VendorRegistrationStatusInput): VendorRegistrationNextAction {
  if (!input.emailVerified) return "verify_email";
  if (!input.phoneVerified) return "verify_phone";
  if (input.registrationStatus !== "submitted") return "complete_registration";
  if (input.approvalStatus === "rejected" || input.complianceStatus === "rejected") return "resolve_rejection";
  if (input.pharmacistCount < 1) return "add_pharmacist";
  if (
    input.approvalStatus === "approved"
    && input.complianceStatus === "verified"
    && input.verifiedLicenceCount > 0
    && input.verifiedPharmacistCount > 0
  ) return "operational";
  return "awaiting_review";
}

export function vendorVerificationReturnUrl(origin: string): string {
  return new URL("/vendor/verification-return", origin).toString();
}

