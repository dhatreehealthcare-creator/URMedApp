"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, KeyRound, LogIn, LogOut, MailCheck, ShieldCheck } from "lucide-react";
import {
  accountAccessPaths,
  accountPasswordPolicyMessage,
  GENERIC_LOGIN_FAILURE,
  GENERIC_PASSWORD_RECOVERY_NOTICE,
  GENERIC_RECOVERY_LINK_ERROR,
  GENERIC_VERIFICATION_RESEND_NOTICE,
  inspectAccountRecoveryReturn,
  postLoginPath,
  type AccountAccessMode,
  type PublicAccountRole,
} from "../lib/account-access";
import { customerVerificationReturnUrl } from "../lib/customer-registration";
import { vendorVerificationReturnUrl } from "../lib/vendor-registration-status";
import type { WorkspaceProfile } from "../lib/role-access";
import { getAuthClient } from "./marketplace-client";

type Notice = { tone: "success" | "error"; message: string } | null;

const roleLabel: Record<PublicAccountRole, string> = { customer: "Customer", vendor: "Vendor" };

async function activeProfile(accessToken: string) {
  const response = await fetch("/api/auth/profile", {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const payload = await response.json() as { profile?: WorkspaceProfile | null };
  return response.ok ? payload.profile ?? null : null;
}

export function AccountAccessPage({ role, mode }: { role: PublicAccountRole; mode: AccountAccessMode }) {
  const paths = accountAccessPaths(role);
  const mounted = useRef(false);
  const recoveryStarted = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(mode === "sign-out" || mode === "reset-password");
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    mounted.current = true;
    if (mode === "sign-out") {
      void getAuthClient().then(async (client) => {
        if (!client) throw new Error("Authentication keys are not connected yet");
        const result = await client.auth.signOut();
        if (result.error) throw result.error;
        if (mounted.current) { setSignedOut(true); setBusy(false); }
      }).catch(() => {
        if (mounted.current) {
          setNotice({ tone: "error", message: "Sign-out could not be confirmed. Close this browser session or try again when authentication is available." });
          setBusy(false);
        }
      });
    }
    if (mode === "reset-password" && !recoveryStarted.current) {
      recoveryStarted.current = true;
      const inspection = inspectAccountRecoveryReturn(window.location.href);
      window.history.replaceState({}, "", paths.resetPassword);
      void (async () => {
        try {
          if (inspection.kind === "provider_error" || inspection.kind === "invalid") throw new Error(GENERIC_RECOVERY_LINK_ERROR);
          const client = await getAuthClient();
          if (!client) throw new Error("Authentication keys are not connected yet");
          if (inspection.kind !== "session") throw new Error(GENERIC_RECOVERY_LINK_ERROR);
          const result = await client.auth.setSession({ access_token: inspection.accessToken, refresh_token: inspection.refreshToken });
          if (result.error) throw result.error;
          const session = result.data.session;
          if (!session) throw new Error(GENERIC_RECOVERY_LINK_ERROR);
          const profile = await activeProfile(session.access_token);
          if (!profile || profile.role !== role || profile.status !== "active") {
            await client.auth.signOut();
            throw new Error(GENERIC_RECOVERY_LINK_ERROR);
          }
          if (mounted.current) setRecoveryReady(true);
        } catch (reason) {
          if (mounted.current) setNotice({ tone: "error", message: reason instanceof Error && /not connected/i.test(reason.message) ? reason.message : GENERIC_RECOVERY_LINK_ERROR });
        } finally {
          if (mounted.current) setBusy(false);
        }
      })();
    }
    return () => { mounted.current = false; };
  }, [mode, paths.resetPassword, role]);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      const result = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (result.error || !result.data.session) {
        if (/email not confirmed/i.test(result.error?.message ?? "")) {
          sessionStorage.setItem(`urmed_pending_verification_${role}`, email.trim().toLowerCase());
          window.location.assign(paths.verificationPending);
          return;
        }
        throw new Error(GENERIC_LOGIN_FAILURE);
      }
      const profile = await activeProfile(result.data.session.access_token);
      const destination = profile ? postLoginPath(role, profile) : null;
      if (!destination) {
        await client.auth.signOut();
        throw new Error(GENERIC_LOGIN_FAILURE);
      }
      if (!profile?.emailVerified) {
        sessionStorage.setItem(`urmed_pending_verification_${role}`, email.trim().toLowerCase());
        await client.auth.signOut();
      }
      window.location.assign(destination);
    } catch (reason) {
      const message = reason instanceof Error && /not connected/i.test(reason.message) ? reason.message : GENERIC_LOGIN_FAILURE;
      setNotice({ tone: "error", message });
    } finally { setBusy(false); }
  };

  const resendVerification = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      const emailRedirectTo = role === "vendor"
        ? vendorVerificationReturnUrl(window.location.origin)
        : customerVerificationReturnUrl(window.location.origin);
      await client.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo } });
      sessionStorage.setItem(`urmed_pending_verification_${role}`, email.trim().toLowerCase());
      setNotice({ tone: "success", message: GENERIC_VERIFICATION_RESEND_NOTICE });
    } catch (reason) {
      if (reason instanceof Error && /not connected/i.test(reason.message)) setNotice({ tone: "error", message: reason.message });
      else setNotice({ tone: "success", message: GENERIC_VERIFICATION_RESEND_NOTICE });
    } finally { setBusy(false); }
  };

  const requestRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      await client.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: new URL(paths.resetPassword, window.location.origin).toString(),
      });
      setNotice({ tone: "success", message: GENERIC_PASSWORD_RECOVERY_NOTICE });
    } catch (reason) {
      if (reason instanceof Error && /not connected/i.test(reason.message)) setNotice({ tone: "error", message: reason.message });
      else setNotice({ tone: "success", message: GENERIC_PASSWORD_RECOVERY_NOTICE });
    } finally { setBusy(false); }
  };

  const resetPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setNotice(null);
    try {
      const policyError = accountPasswordPolicyMessage(password);
      if (policyError) throw new Error(policyError);
      if (password !== confirmPassword) throw new Error("The new password and confirmation do not match");
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      const result = await client.auth.updateUser({ password });
      if (result.error) throw new Error(GENERIC_RECOVERY_LINK_ERROR);
      await client.auth.signOut();
      setRecoveryReady(false);
      setPassword(""); setConfirmPassword("");
      setNotice({ tone: "success", message: "Password changed. Sign in again with the new password." });
    } catch (reason) {
      const safeMessages = new Set([
        "The new password must contain at least 12 characters",
        "Use uppercase, lowercase, a number and a symbol in the new password",
        "The new password and confirmation do not match",
        "Authentication keys are not connected yet",
      ]);
      const message = reason instanceof Error && safeMessages.has(reason.message) ? reason.message : GENERIC_RECOVERY_LINK_ERROR;
      setNotice({ tone: "error", message });
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (mode !== "verification-pending") return;
    const stored = sessionStorage.getItem(`urmed_pending_verification_${role}`) ?? "";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setEmail(stored);
  }, [mode, role]);

  const title = mode === "login" ? `${roleLabel[role]} login`
    : mode === "verification-pending" ? "Email verification pending"
      : mode === "forgot-password" ? "Recover password"
        : mode === "reset-password" ? "Set a new password"
          : "Signed out";
  const Icon = mode === "login" ? LogIn : mode === "verification-pending" ? MailCheck : mode === "sign-out" ? LogOut : KeyRound;

  return <main className="vendor-milestone-page">
    <section className="vendor-milestone-shell">
      <Link className="milestone-back" href="/"><ArrowLeft size={16} /> URMED marketplace</Link>
      <div className={`milestone-hero ${notice?.tone === "error" ? "error" : ""}`}>
        <span className="milestone-icon"><Icon size={30} /></span>
        <small>{role.toUpperCase()} ACCOUNT ACCESS</small>
        <h1>{title}</h1>
        <p>{mode === "login" ? `Use the verified ${role} email and password. This page cannot create accounts or switch account roles.`
          : mode === "verification-pending" ? "Request another provider verification message without revealing whether an account exists."
            : mode === "forgot-password" ? "Request a role-scoped recovery link. The same response is shown for recognized and unrecognized emails."
              : mode === "reset-password" ? "A valid recovery session for this account role is required before a password can be changed."
                : busy ? "Ending the current provider session…" : signedOut ? "The provider session has ended on this browser." : "Session sign-out completed."}</p>
        {notice && <div className={`auth-message ${notice.tone}`}>{notice.message}</div>}

        {mode === "login" && <form className="portal-form-grid one" onSubmit={submitLogin}>
          <label className="portal-field"><span>Email *</span><input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
          <label className="portal-field"><span>Password *</span><input autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
          <button className="portal-primary wide" disabled={busy} type="submit">{busy ? "Signing in…" : "Sign in securely"}</button>
        </form>}

        {mode === "verification-pending" && <form className="portal-form-grid one" onSubmit={resendVerification}>
          <label className="portal-field"><span>Registration email *</span><input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
          <button className="portal-primary wide" disabled={busy} type="submit">{busy ? "Requesting…" : "Resend verification email"}</button>
        </form>}

        {mode === "forgot-password" && <form className="portal-form-grid one" onSubmit={requestRecovery}>
          <label className="portal-field"><span>Account email *</span><input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
          <button className="portal-primary wide" disabled={busy} type="submit">{busy ? "Requesting…" : "Send password recovery instructions"}</button>
        </form>}

        {mode === "reset-password" && recoveryReady && <form className="portal-form-grid one" onSubmit={resetPassword}>
          <label className="portal-field"><span>New password *</span><input autoComplete="new-password" minLength={12} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /><small>Use uppercase, lowercase, a number and a symbol.</small></label>
          <label className="portal-field"><span>Confirm new password *</span><input autoComplete="new-password" minLength={12} onChange={(event) => setConfirmPassword(event.target.value)} required type="password" value={confirmPassword} /></label>
          <button className="portal-primary wide" disabled={busy} type="submit">{busy ? "Changing…" : "Change password"}</button>
        </form>}

        {mode === "reset-password" && busy && <div className="milestone-actions"><span>Validating the recovery session…</span></div>}
        {mode === "sign-out" && !busy && <div className="milestone-actions"><Link className="portal-primary" href={paths.login}>Return to {role} login</Link></div>}
        {mode !== "sign-out" && <div className="milestone-actions">
          {mode !== "login" && <Link className="portal-outline" href={paths.login}>Back to login</Link>}
          {mode === "login" && <><Link className="portal-outline" href={paths.verificationPending}>Verification pending</Link><Link className="portal-outline" href={paths.forgotPassword}>Forgot password</Link></>}
          {mode === "forgot-password" && <Link className="portal-outline" href={paths.verificationPending}>Need email verification?</Link>}
        </div>}
      </div>
      <div className="milestone-privacy"><ShieldCheck size={18} /><span><strong>Provider-backed access only.</strong><small>These pages never accept a browser-supplied role or verification flag. Verification and recovery messages use neutral responses, and recovery tokens are removed from the address before validation.</small></span></div>
    </section>
  </main>;
}
