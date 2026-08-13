import { getRuntimeEnv, type UrmedRuntimeEnv } from "./runtime-env.ts";

export const TEST_TOKEN_PREFIX = "urmed_test_";
export const TEST_AUTH_HEADER = "x-urmed-integration-key";

export function isTestAuthenticationEnabled(env: UrmedRuntimeEnv = getRuntimeEnv()) {
  return env.APP_STAGE?.trim().toLowerCase() === "integration"
    && (env.INTEGRATION_TEST_AUTH_SECRET?.trim().length ?? 0) >= 32;
}

export async function requireIntegrationTestRequest(request: Request) {
  const env = getRuntimeEnv();
  const expected = env.INTEGRATION_TEST_AUTH_SECRET?.trim() ?? "";
  const supplied = request.headers.get(TEST_AUTH_HEADER)?.trim() ?? "";
  if (!isTestAuthenticationEnabled(env) || !supplied) {
    throw new Response("Not found", { status: 404 });
  }
  const [expectedHash, suppliedHash] = await Promise.all([sha256(expected), sha256(supplied)]);
  let mismatch = expectedHash.length ^ suppliedHash.length;
  for (let index = 0; index < expectedHash.length; index += 1) {
    mismatch |= expectedHash.charCodeAt(index) ^ suppliedHash.charCodeAt(index);
  }
  if (mismatch !== 0) throw new Response("Not found", { status: 404 });
}

export async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomTestToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${TEST_TOKEN_PREFIX}${encoded}`;
}
