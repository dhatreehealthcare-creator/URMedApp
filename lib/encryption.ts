import { getRequiredRuntimeValue } from "./runtime-env";

const encoder = new TextEncoder();

function base64(bytes: Uint8Array) {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

export async function encryptSensitiveText(value: string) {
  const secret = getRequiredRuntimeValue("DATA_ENCRYPTION_KEY");
  if (secret.length < 24) throw new Error("DATA_ENCRYPTION_KEY must contain at least 24 characters");
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(value));
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
