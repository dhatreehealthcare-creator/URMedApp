export type PublicAccountRole = "customer" | "vendor";

export type AccountAccessMode =
  | "login"
  | "verification-pending"
  | "forgot-password"
  | "reset-password"
  | "sign-out";

export const GENERIC_LOGIN_FAILURE = "Sign-in could not be completed. Check the credentials, verification state, and account access, then try again.";
export const GENERIC_VERIFICATION_RESEND_NOTICE = "If this email belongs to a pending account, a new verification message will be sent subject to provider limits.";
export const GENERIC_PASSWORD_RECOVERY_NOTICE = "If an eligible account exists for this email, password recovery instructions will be sent subject to provider limits.";
export const GENERIC_RECOVERY_LINK_ERROR = "This password recovery link is invalid, expired, or has already been used. Request a new link to continue.";

export function accountAccessPaths(role: PublicAccountRole) {
  const root = `/${role}`;
  return {
    root,
    login: `${root}/login`,
    verificationPending: `${root}/verification-pending`,
    forgotPassword: `${root}/forgot-password`,
    resetPassword: `${root}/reset-password`,
    signOut: `${root}/sign-out`,
    postLogin: role === "vendor" ? `${root}/registration/status` : root,
  } as const;
}

export function postLoginPath(role: PublicAccountRole, profile: {
  role: string;
  status: string;
  emailVerified: boolean;
  vendorAccessStatus?: string | null;
}) {
  if (profile.role !== role || profile.status !== "active") return null;
  const paths = accountAccessPaths(role);
  if (!profile.emailVerified) return paths.verificationPending;
  if (role === "vendor" && profile.vendorAccessStatus === "operational") return paths.root;
  return paths.postLogin;
}

export function accountPasswordPolicyMessage(value: unknown): string | null {
  const password = String(value ?? "");
  if (password.length < 12) return "The new password must contain at least 12 characters";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    return "Use uppercase, lowercase, a number and a symbol in the new password";
  }
  return null;
}

export type AccountRecoveryReturn =
  | { kind: "none" }
  | { kind: "provider_error" }
  | { kind: "invalid" }
  | { kind: "session"; accessToken: string; refreshToken: string };

export function inspectAccountRecoveryReturn(href: string): AccountRecoveryReturn {
  const url = new URL(href, "https://urmed.invalid");
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  if (query.has("error") || fragment.has("error")) return { kind: "provider_error" };
  if (!url.hash) return { kind: "none" };
  const accessToken = fragment.get("access_token") ?? "";
  const refreshToken = fragment.get("refresh_token") ?? "";
  if (fragment.get("type") !== "recovery" || !accessToken || !refreshToken) return { kind: "invalid" };
  return { kind: "session", accessToken, refreshToken };
}
