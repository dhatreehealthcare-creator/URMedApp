const BASE_SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(self), payment=(self)",
} as const;

/**
 * Apply browser-level safeguards at the Worker boundary so pages, API errors,
 * redirects, and optimized images receive one consistent baseline. A global
 * CSP is intentionally deferred until the framework/provider script inventory
 * can be nonce-based; imposing one here would break Vinext hydration or the
 * Razorpay/Supabase flows it has not explicitly allowlisted.
 */
export function withSecurityHeaders(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(BASE_SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
  if (new URL(request.url).protocol === "https:" && !headers.has("Strict-Transport-Security")) {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
