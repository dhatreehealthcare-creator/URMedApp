export type UrmedRuntimeEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  DATA_ENCRYPTION_KEY?: string;
  APP_STAGE?: string;
  INTEGRATION_TEST_AUTH_SECRET?: string;
  REMINDER_JOB_SECRET?: string;
  EINVOICE_API_URL?: string;
  EINVOICE_API_KEY?: string;
};

export function getRuntimeEnv(): UrmedRuntimeEnv {
  return (globalThis as typeof globalThis & { __URMED_RUNTIME__?: UrmedRuntimeEnv }).__URMED_RUNTIME__ ?? {};
}

export function getRequiredRuntimeValue(key: keyof UrmedRuntimeEnv): string {
  const value = getRuntimeEnv()[key]?.trim();
  if (!value) throw new Error(`${key} is not configured for this deployment`);
  return value;
}
