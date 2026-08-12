export const RECOVERED_CUSTOMER_IDENTITY_POLICY = {
  credentialAuthority: "supabase_auth",
  liveProfileAuthority: "account_profiles",
  recoveredCustomerClassification: "admin_only_reference",
  recoveredCustomersCanAuthenticate: false,
  automaticLinking: false,
  linkingStatus: "not_implemented",
} as const;
