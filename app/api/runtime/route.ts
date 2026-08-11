import { getRuntimeEnv } from "../../../lib/runtime-env";

export async function GET() {
  const env = getRuntimeEnv();
  return Response.json({
    stage: env.APP_STAGE || "testing",
    supabase: env.SUPABASE_URL && env.SUPABASE_ANON_KEY ? {
      url: env.SUPABASE_URL,
      anonKey: env.SUPABASE_ANON_KEY,
      ready: true,
    } : { url: "", anonKey: "", ready: false },
    integrations: {
      otpAndAuth: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
      email: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL),
      payments: Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET),
      paymentWebhooks: Boolean(env.RAZORPAY_WEBHOOK_SECRET),
    },
    razorpayKeyId: env.RAZORPAY_KEY_ID || "",
  }, { headers: { "Cache-Control": "no-store" } });
}
