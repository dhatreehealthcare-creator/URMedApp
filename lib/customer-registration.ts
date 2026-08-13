export type CustomerOnboardingStatus =
  | "account_inactive"
  | "email_pending"
  | "phone_pending"
  | "operational";

export type CustomerOnboardingNextAction =
  | "contact_support"
  | "verify_email"
  | "verify_phone"
  | "open_workspace";

export function getCustomerOnboardingStatus(input: {
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}): CustomerOnboardingStatus {
  if (input.status !== "active") return "account_inactive";
  if (!input.emailVerified) return "email_pending";
  if (!input.phoneVerified) return "phone_pending";
  return "operational";
}

export function getCustomerOnboardingState(input: {
  status: string;
  emailVerified: boolean;
  phoneVerified: boolean;
}) {
  const status = getCustomerOnboardingStatus(input);
  const nextAction: CustomerOnboardingNextAction = status === "account_inactive"
    ? "contact_support"
    : status === "email_pending"
      ? "verify_email"
      : status === "phone_pending"
        ? "verify_phone"
        : "open_workspace";
  return {
    status,
    nextAction,
    verificationComplete: status === "operational",
    resumable: status !== "account_inactive",
  };
}

export function customerVerificationReturnUrl(origin: string): string {
  return new URL("/customer", origin).toString();
}
