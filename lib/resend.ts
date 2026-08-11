import { getRuntimeEnv } from "./runtime-env";

export async function sendTransactionalEmail(to: string, subject: string, html: string) {
  const env = getRuntimeEnv();
  if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !to) return { sent: false, reason: "not_configured" };
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM_EMAIL, to: [to], subject, html }),
  });
  if (!response.ok) return { sent: false, reason: `provider_${response.status}` };
  return { sent: true };
}
