import { getD1 } from "../db/d1.ts";

export type AbusePolicyName =
  | "auth"
  | "upload"
  | "payment"
  | "webhook"
  | "public_search"
  | "gps";

type AbusePolicy = { limit: number; windowSeconds: number };

export const ABUSE_POLICIES: Record<AbusePolicyName, AbusePolicy> = {
  auth: { limit: 12, windowSeconds: 60 },
  upload: { limit: 6, windowSeconds: 60 },
  payment: { limit: 12, windowSeconds: 60 },
  webhook: { limit: 120, windowSeconds: 60 },
  public_search: { limit: 60, windowSeconds: 60 },
  // Delivery proof has a separate 15-second freshness/replay guard. This
  // request budget allows legitimate availability + pickup + fulfilment
  // transitions while still bounding burst amplification.
  gps: { limit: 30, windowSeconds: 60 },
};

export class AbuseControlError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "AbuseControlError";
    this.status = status;
    this.code = code;
  }
}

async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clientAddress(request: Request) {
  return (request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]
    ?? "unknown").trim().slice(0, 200) || "unknown";
}

function limitedResponse(resetAtMs: number, policy: AbusePolicy, nowMs = Date.now()) {
  const retryAfter = Math.max(1, Math.ceil((resetAtMs - nowMs) / 1000));
  return Response.json({ error: "Too many requests. Please retry later.", code: "rate_limited" }, {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": String(retryAfter),
      "X-RateLimit-Limit": String(policy.limit),
      "X-RateLimit-Remaining": "0",
    },
  });
}

/**
 * Durable D1-backed fixed-window limiter. Raw IPs are hashed before storage.
 * A hosted Cloudflare Rate Limiting binding can replace this implementation at
 * deployment, but local and packaged tests exercise the same durable contract.
 */
export async function enforceRateLimit(
  request: Request,
  policyName: AbusePolicyName,
  options: { profileId?: number | null; nowMs?: number; database?: D1Database } = {},
): Promise<Response | null> {
  const policy = ABUSE_POLICIES[policyName];
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = policy.windowSeconds * 1000;
  const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
  const resetAtMs = windowStartMs + windowMs;
  const identity = `${policyName}|${clientAddress(request)}|profile:${options.profileId ?? "anonymous"}`;
  const subjectHash = await sha256Hex(identity);
  const database = options.database ?? getD1();
  try {
    await database.prepare("DELETE FROM abuse_rate_limit_buckets WHERE expires_at_ms < ?").bind(nowMs).run();
    const row = await database.prepare(`INSERT INTO abuse_rate_limit_buckets
      (route_key, subject_hash, window_start_ms, expires_at_ms, request_count)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(route_key, subject_hash, window_start_ms) DO UPDATE SET
        request_count = abuse_rate_limit_buckets.request_count + 1,
        expires_at_ms = excluded.expires_at_ms,
        updated_at = CURRENT_TIMESTAMP
      RETURNING request_count AS requestCount`)
      .bind(policyName, subjectHash, windowStartMs, resetAtMs).first<{ requestCount: number }>();
    if (!row) throw new AbuseControlError("Abuse control is temporarily unavailable", 503, "abuse_control_unavailable");
    if (Number(row.requestCount) > policy.limit) return limitedResponse(resetAtMs, policy, nowMs);
    return null;
  } catch (error) {
    if (error instanceof AbuseControlError && error.status === 429) return limitedResponse(resetAtMs, policy);
    if (error instanceof AbuseControlError) {
      return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "no-store", "Retry-After": "5" } });
    }
    return Response.json({ error: "Abuse control is temporarily unavailable", code: "abuse_control_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" },
    });
  }
}
