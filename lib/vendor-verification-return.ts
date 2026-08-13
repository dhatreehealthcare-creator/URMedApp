export type VendorVerificationReturnInspection =
  | { kind: "session"; accessToken: string; refreshToken: string }
  | { kind: "provider_error" }
  | { kind: "invalid" }
  | { kind: "none" };

const implicitSessionKeys = ["access_token", "refresh_token", "expires_in", "token_type"] as const;
const providerErrorKeys = ["error", "error_code", "error_description"] as const;

/**
 * Classify a Supabase email-verification return without exposing provider error
 * details to the UI. URMED currently creates the Supabase client with the
 * implicit flow, so successful email confirmations return the session only in
 * the URL fragment and can be removed before any application HTTP request.
 */
export function inspectEmailVerificationReturn(value: string): VendorVerificationReturnInspection {
  const url = new URL(value, "https://urmed.invalid");
  const hash = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const hasProviderError = providerErrorKeys.some((key) => url.searchParams.has(key) || hash.has(key));
  if (hasProviderError) return { kind: "provider_error" };

  const hasImplicitSessionValue = implicitSessionKeys.some((key) => hash.has(key));
  if (!hasImplicitSessionValue) return { kind: "none" };
  if (hash.get("type") !== "signup" || implicitSessionKeys.some((key) => !hash.get(key))) {
    return { kind: "invalid" };
  }

  return {
    kind: "session",
    accessToken: hash.get("access_token")!,
    refreshToken: hash.get("refresh_token")!,
  };
}

export const inspectVendorVerificationReturn = inspectEmailVerificationReturn;

export type VendorVerificationUser = {
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

export type VendorVerificationProfileSeed = {
  role: "vendor";
  name: string;
  businessName: string;
  phone: string;
};

/**
 * New vendor shells are created only from the provider-owned session returned
 * for the vendor signup. Verification flags and confirmed identity values are
 * deliberately absent: the profile API derives those from the bearer token.
 */
export function vendorVerificationProfileSeed(user: VendorVerificationUser): VendorVerificationProfileSeed | null {
  const metadata = user.user_metadata ?? {};
  if (metadata.role !== "vendor" || !user.email || !user.email_confirmed_at) return null;
  const name = String(metadata.name ?? metadata.owner_name ?? "").trim().slice(0, 120);
  const businessName = String(metadata.business_name ?? "").trim().slice(0, 180);
  if (!name || !businessName) return null;
  return {
    role: "vendor",
    name,
    businessName,
    phone: String(metadata.phone ?? ""),
  };
}
