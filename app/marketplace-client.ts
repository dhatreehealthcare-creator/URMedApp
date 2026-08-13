import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type RuntimeConfig = {
  stage: string;
  supabase: { url: string; anonKey: string; ready: boolean };
  integrations: { otpAndAuth: boolean; email: boolean; payments: boolean; paymentWebhooks: boolean };
  razorpayKeyId: string;
};

let configPromise: Promise<RuntimeConfig> | null = null;
let clientPromise: Promise<SupabaseClient | null> | null = null;
const testTokenKey = "urmed_test_access_token";

export function getTestAccessToken() {
  return typeof window === "undefined" ? "" : sessionStorage.getItem(testTokenKey) ?? "";
}

export function setTestAccessToken(token: string) {
  if (typeof window !== "undefined") sessionStorage.setItem(testTokenKey, token);
}

export function clearTestAccessToken() {
  if (typeof window !== "undefined") sessionStorage.removeItem(testTokenKey);
}

export function getRuntimeConfig() {
  configPromise ??= fetch("/api/runtime", { cache: "no-store" }).then(async (response) => {
    if (!response.ok) throw new Error("URMED service configuration is unavailable");
    return response.json() as Promise<RuntimeConfig>;
  });
  return configPromise;
}

export function getAuthClient() {
  clientPromise ??= getRuntimeConfig().then((config) => {
    if (!config.supabase.ready) return null;
    return createClient(config.supabase.url, config.supabase.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        flowType: "implicit",
      },
    });
  });
  return clientPromise;
}

export async function accessToken() {
  const testToken = getTestAccessToken();
  if (testToken) return testToken;
  const client = await getAuthClient();
  const session = client ? (await client.auth.getSession()).data.session : null;
  return session?.access_token ?? "";
}

export async function authenticatedFetch(input: string, init: RequestInit = {}) {
  const token = await accessToken();
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(input, { ...init, headers });
}
