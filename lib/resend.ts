import { getRuntimeEnv } from "./runtime-env.ts";

export type TransactionalEmailSendResult =
  | { sent: true; providerMessageId: string; retryable?: false; code?: string; reason?: string }
  | { sent: false; retryable: boolean; code: string; reason: string; providerMessageId?: undefined };

export async function sendTransactionalEmail(
  to: string,
  subject: string,
  html: string,
  options?: { idempotencyKey?: string },
): Promise<TransactionalEmailSendResult> {
  const env = getRuntimeEnv();
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !to) {
    return { sent: false, retryable: true, code: "provider_not_configured", reason: "Transactional email provider is not configured" };
  }
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    };
    if (options?.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers,
      body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [to], subject, html }),
    });
    if (!response.ok) {
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      return { sent: false, retryable, code: `provider_${response.status}`,
        reason: retryable ? "Transactional email provider temporarily unavailable" : "Transactional email provider rejected the request" };
    }
    const payload = await response.json().catch(() => null) as { id?: unknown } | null;
    const providerMessageId = String(payload?.id ?? "").trim();
    if (!providerMessageId) {
      return { sent: false, retryable: true, code: "provider_invalid_response", reason: "Transactional email provider response omitted its message identifier" };
    }
    return { sent: true, providerMessageId };
  } catch {
    return { sent: false, retryable: true, code: "provider_network_error", reason: "Transactional email provider network request failed" };
  }
}
