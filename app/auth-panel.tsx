"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, KeyRound, LogOut, MailCheck, MessageSquareText, ShieldCheck } from "lucide-react";
import { isRoleSessionAuthorized, type WorkspaceProfile, type WorkspaceRole } from "../lib/role-access";
import { isProviderIdentityConflict, SAFE_EMAIL_REGISTRATION_NOTICE, verifiedContactConflictMessage } from "../lib/auth-identity-messages";
import { customerVerificationReturnUrl, getCustomerOnboardingStatus } from "../lib/customer-registration";
import { vendorVerificationReturnUrl } from "../lib/vendor-registration-status";
import { inspectEmailVerificationReturn } from "../lib/vendor-verification-return";
import { getAuthClient, getRuntimeConfig, type RuntimeConfig } from "./marketplace-client";

const roleLabels: Record<WorkspaceRole, string> = {
  customer: "Customer",
  vendor: "Vendor",
  admin: "Administrator",
  delivery: "Delivery agent",
};

export function AuthPanel({ role, onProfileChange }: { role: WorkspaceRole; onProfileChange?: (profile: WorkspaceProfile | null) => void }) {
  const provisionedRole = role === "admin" || role === "delivery";
  const mounted = useRef(false);
  const initializationStarted = useRef(false);
  const authSubscription = useRef<(() => void) | undefined>(undefined);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mode, setMode] = useState<"register" | "login">(provisionedRole ? "login" : "register");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [profile, setProfile] = useState<WorkspaceProfile | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const syncProfile = useCallback(async (accessToken: string, fallback?: Record<string, unknown>) => {
    let response = await fetch("/api/auth/profile", { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    let payload = await response.json() as { profile?: WorkspaceProfile; error?: string };
    if (!payload.profile && fallback && !provisionedRole) {
      response = await fetch("/api/auth/profile", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(fallback),
      });
      payload = await response.json() as { profile?: WorkspaceProfile; error?: string };
    }
    if (!response.ok) throw new Error(payload.error || "URMED profile could not be loaded");
    if (!payload.profile) throw new Error(`No live ${role} profile is linked to this provider account. Complete the required email/password registration first.`);
    const nextProfile = payload.profile ?? null;
    if (nextProfile && !isRoleSessionAuthorized(nextProfile, role)) throw new Error(`Sign in with an active ${role} account to continue`);
    setProfile(nextProfile);
    if (nextProfile?.phone) setPhone((current) => current || nextProfile.phone);
    onProfileChange?.(nextProfile);
  }, [onProfileChange, provisionedRole, role]);

  useEffect(() => {
    mounted.current = true;
    if (!initializationStarted.current) {
      initializationStarted.current = true;
      const callback = role === "customer" ? inspectEmailVerificationReturn(window.location.href) : { kind: "none" as const };
      if (callback.kind !== "none") window.history.replaceState({}, "", role === "customer" ? "/customer" : window.location.pathname);
      void getRuntimeConfig().then((value) => mounted.current && setConfig(value)).catch((reason) => mounted.current && setError(reason instanceof Error ? reason.message : "Configuration unavailable"));
      void getAuthClient().then(async (client) => {
        if (!client) return;
        try {
          if (callback.kind === "provider_error" || callback.kind === "invalid") {
            throw new Error("This email verification link is invalid, expired, or has already been used. Sign in to request a new link.");
          }
          let session = (await client.auth.getSession()).data.session;
          if (callback.kind === "session") {
            const result = await client.auth.setSession({ access_token: callback.accessToken, refresh_token: callback.refreshToken });
            if (result.error) throw result.error;
            session = result.data.session;
          }
          if (session && mounted.current) {
            const { data: providerData, error: providerError } = await client.auth.getUser();
            if (providerError) throw providerError;
            const user = providerData.user;
            const metadata = user.user_metadata ?? {};
            if (callback.kind === "session" && (!user.email_confirmed_at || metadata.role !== "customer")) {
              throw new Error("This verification return does not belong to a customer email registration.");
            }
            const metadataPhone = String(metadata.phone ?? "").replace(/\D/g, "").slice(-10);
            if (metadataPhone) setPhone((current) => current || metadataPhone);
            const fallback = user.email && metadata.role === role && !provisionedRole ? {
              role,
              name: metadata.name || metadata.owner_name || user.email.split("@")[0] || "URMED user",
              businessName: metadata.business_name || "Pharmacy registration",
              phone: metadataPhone,
            } : undefined;
            await syncProfile(session.access_token, fallback);
            if (callback.kind === "session" && mounted.current) setMessage("Email verified. Now verify the registered mobile number to activate customer access.");
          }
        } catch (reason) {
          if (mounted.current) setError(reason instanceof Error ? reason.message : "Profile unavailable");
        }
        const { data } = client.auth.onAuthStateChange((_event, sessionValue) => {
          if (!mounted.current) return;
          if (!sessionValue) { setProfile(null); onProfileChange?.(null); }
        });
        authSubscription.current = () => data.subscription.unsubscribe();
      });
    }
    return () => {
      mounted.current = false;
      authSubscription.current?.();
      authSubscription.current = undefined;
    };
  }, [onProfileChange, provisionedRole, role, syncProfile]);

  const finishSignIn = async (accessToken: string, allowProfileCreation = false) => {
    await syncProfile(accessToken, allowProfileCreation && !provisionedRole ? { role, name: name || email.split("@")[0] || "URMED user", businessName, phone } : undefined);
    setMessage(`${roleLabels[role]} sign-in completed.`);
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      if (mode === "register") {
        if (!name.trim()) throw new Error("Name is required");
        if (role === "vendor" && !businessName.trim()) throw new Error("Shop or business name is required");
        if ((role === "vendor" || role === "customer") && !/^\d{10}$/.test(phone)) throw new Error(`Enter the ${role}’s 10-digit mobile number`);
        if (role === "customer" && password !== confirmPassword) throw new Error("Password and confirmation must match");
        const emailRedirectTo = role === "vendor"
          ? vendorVerificationReturnUrl(window.location.origin)
          : role === "customer" ? customerVerificationReturnUrl(window.location.origin) : window.location.origin;
        const { data, error: authError } = await client.auth.signUp({
          email: email.trim(), password,
          options: { emailRedirectTo, data: { role, name: name.trim(), owner_name: name.trim(), business_name: businessName.trim(), phone } },
        });
        if (authError && isProviderIdentityConflict(authError)) {
          setMessage(SAFE_EMAIL_REGISTRATION_NOTICE);
          return;
        }
        if (authError) throw authError;
        if (data.session) await finishSignIn(data.session.access_token, true);
        else setMessage(SAFE_EMAIL_REGISTRATION_NOTICE);
      } else {
        const { data, error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (authError && /email not confirmed/i.test(authError.message)) {
          const emailRedirectTo = role === "vendor"
            ? vendorVerificationReturnUrl(window.location.origin)
            : role === "customer" ? customerVerificationReturnUrl(window.location.origin) : window.location.origin;
          const { error: resendError } = await client.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo } });
          if (resendError) throw resendError;
          setMessage("Email is not verified. A new secure verification link has been sent.");
          return;
        }
        if (authError) throw authError;
        await finishSignIn(data.session.access_token);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Authentication failed");
    } finally { setBusy(false); }
  };

  const sendOtp = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      if (!/^\d{10}$/.test(phone)) throw new Error("Enter a valid 10-digit Indian mobile number");
      if (mode === "register") throw new Error(`Create the ${role} email and password account first, then verify its mobile number during onboarding`);
      const client = await getAuthClient();
      if (!client) throw new Error("OTP keys are not connected yet");
      const { error: authError } = await client.auth.signInWithOtp({
        phone: `+91${phone}`,
        options: { shouldCreateUser: false },
      });
      if (authError) throw authError;
      setOtpSent(true); setMessage("OTP sent. Enter the 6-digit code to verify this phone.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "OTP could not be sent"); }
    finally { setBusy(false); }
  };

  const verifyOtp = async () => {
    setBusy(true); setError("");
    try {
      const client = await getAuthClient();
      if (!client) throw new Error("OTP keys are not connected yet");
      const { data, error: authError } = await client.auth.verifyOtp({ phone: `+91${phone}`, token: otp, type: "sms" });
      if (authError) throw authError;
      if (!data.session) throw new Error("OTP verification did not create a session");
      await finishSignIn(data.session.access_token);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "OTP verification failed"); }
    finally { setBusy(false); }
  };

  const sendCustomerPhoneVerification = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      if (profile?.role !== "customer" || !profile.emailVerified) throw new Error("Verify the customer account email before verifying its mobile number");
      if (!/^\d{10}$/.test(phone)) throw new Error("Enter the required 10-digit Indian mobile number");
      const client = await getAuthClient();
      if (!client) throw new Error("OTP keys are not connected yet");
      const { error: updateError } = await client.auth.updateUser({ phone: `+91${phone}` });
      if (updateError && isProviderIdentityConflict(updateError)) throw new Error(verifiedContactConflictMessage("phone"));
      if (updateError) throw updateError;
      setOtpSent(true);
      setMessage("A 6-digit verification code was sent to the registered mobile number.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Phone verification could not be started"); }
    finally { setBusy(false); }
  };

  const confirmCustomerPhoneVerification = async () => {
    setBusy(true); setError(""); setMessage("");
    try {
      if (profile?.role !== "customer" || !profile.emailVerified) throw new Error("A verified customer email session is required");
      if (!/^\d{10}$/.test(phone) || !/^\d{6}$/.test(otp)) throw new Error("Enter the 10-digit mobile number and 6-digit OTP");
      const client = await getAuthClient();
      if (!client) throw new Error("OTP keys are not connected yet");
      const { error: verifyError } = await client.auth.verifyOtp({ phone: `+91${phone}`, token: otp, type: "phone_change" });
      if (verifyError) throw verifyError;
      const session = (await client.auth.getSession()).data.session;
      if (!session) throw new Error("The customer session expired. Sign in again before verifying the phone.");
      await syncProfile(session.access_token);
      setOtp(""); setOtpSent(false);
      setMessage("Mobile number verified. Customer ordering access is now active.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Phone verification failed"); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    const client = await getAuthClient();
    await client?.auth.signOut();
    setProfile(null); onProfileChange?.(null); setMessage("Signed out securely.");
  };

  if (profile) {
    const vendorState = profile.role === "vendor" ? profile.vendorAccessStatus : null;
    const customerState = profile.role === "customer" ? getCustomerOnboardingStatus(profile) : null;
    return <section className={`auth-live-card ${customerState && customerState !== "operational" ? "customer-onboarding-card" : ""}`}><span><CheckCircle2 size={28} /></span><div><small>AUTHENTICATED {profile.role.toUpperCase()}</small><h3>{profile.name}</h3><p>{profile.email || profile.phone} · Account {profile.status}</p>{(profile.role === "vendor" || profile.role === "customer") && <div className="identity-state-list"><span className={profile.emailVerified ? "complete" : "pending"}>{profile.emailVerified ? "Email verified" : "Email verification pending"}</span><span className={profile.phoneVerified ? "complete" : "pending"}>{profile.phoneVerified ? "Phone verified" : "Phone verification pending"}</span>{profile.role === "vendor" ? <span className={vendorState === "operational" ? "complete" : "pending"}>{vendorState === "registration_draft" ? "Registration draft" : vendorState === "review_pending" ? "Registration submitted · administrator review pending" : vendorState === "operational" ? "Operational access approved" : "Identity verification incomplete"}</span> : <span className={customerState === "operational" ? "complete" : "pending"}>{customerState === "operational" ? "Customer access active" : "Customer access restricted"}</span>}</div>}{profile.role === "vendor" && <a className="auth-status-link" href="/vendor/registration/status">View detailed registration status</a>}{customerState && customerState !== "operational" && <div className="customer-verification-step"><strong>{customerState === "email_pending" ? "Verify the account email first" : "Verify your mobile number"}</strong><p>{customerState === "email_pending" ? "Open the secure verification email, then return and sign in. Mobile OTP verification becomes available only after the provider confirms the email." : "Customer ordering and account operations stay locked until the required mobile OTP is confirmed on this same email/password account."}</p>{message && <div className="auth-message success">{message}</div>}{error && <div className="auth-message error">{error}</div>}{customerState === "phone_pending" && <div className="customer-phone-verification"><label className="portal-field"><span>10-digit mobile number *</span><div className="phone-entry"><b>+91</b><input inputMode="numeric" maxLength={10} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{10}" required value={phone} /></div></label>{!otpSent ? <button className="portal-primary" disabled={busy} onClick={() => void sendCustomerPhoneVerification()} type="button">{busy ? "Sending…" : "Send mobile OTP"}</button> : <><label className="portal-field"><span>6-digit OTP *</span><input inputMode="numeric" maxLength={6} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{6}" required value={otp} /></label><button className="portal-primary" disabled={busy || otp.length !== 6} onClick={() => void confirmCustomerPhoneVerification()} type="button">{busy ? "Verifying…" : "Verify mobile and activate"}</button></>}</div>}</div>}</div><button onClick={() => void signOut()} type="button"><LogOut size={16} /> Sign out</button></section>;
  }

  return <section className="portal-panel auth-panel-live">
    <div className="portal-panel-heading"><div><span className="portal-kicker">LIVE {role.toUpperCase()} ACCESS</span><h2>{mode === "register" ? `Create ${role} account` : `${roleLabels[role]} login`}</h2><p>{provisionedRole ? `${roleLabels[role]} access requires a pre-provisioned active profile. Public registration cannot create this role.` : "Supabase secures the account, Twilio sends phone OTPs, and verified email links return the user to URMED."}</p></div><ShieldCheck size={23} /></div>
    {!config?.supabase.ready && <div className="integration-warning"><KeyRound size={18} /><span><strong>Private integration setup</strong><small>The screens are ready. Connect the test keys to send real OTPs and verification emails.</small></span></div>}
    {!provisionedRole && <div className="auth-switch"><button className={mode === "register" ? "active" : ""} onClick={() => { setMode("register"); setMethod("email"); }} type="button">Register</button><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">Login</button></div>}
    {!provisionedRole && <div className="auth-switch compact"><button className={method === "email" ? "active" : ""} onClick={() => setMethod("email")} type="button"><MailCheck size={14} /> Email</button>{mode === "login" && <button className={method === "phone" ? "active" : ""} onClick={() => setMethod("phone")} type="button"><MessageSquareText size={14} /> Phone OTP</button>}</div>}
    {message && <div className="auth-message success">{message}</div>}{error && <div className="auth-message error">{error}</div>}
    {provisionedRole || method === "email" ? <form className="portal-form-grid one" onSubmit={submitEmail}>
      {mode === "register" && <><label className="portal-field"><span>{role === "vendor" ? "Owner name" : "Name"} *</span><input autoComplete="name" onChange={(event) => setName(event.target.value)} required value={name} /></label>{role === "vendor" && <label className="portal-field"><span>Shop / business name *</span><input onChange={(event) => setBusinessName(event.target.value)} required value={businessName} /></label>}{(role === "vendor" || role === "customer") && <label className="portal-field"><span>10-digit mobile number *</span><div className="phone-entry"><b>+91</b><input autoComplete="tel" inputMode="numeric" maxLength={10} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{10}" required value={phone} /></div></label>}</>}
      <label className="portal-field"><span>Email *</span><input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
      <label className="portal-field"><span>Password *</span><input autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
      {mode === "register" && role === "customer" && <label className="portal-field"><span>Confirm password *</span><input autoComplete="new-password" minLength={8} onChange={(event) => setConfirmPassword(event.target.value)} required type="password" value={confirmPassword} /></label>}
      <button className="portal-primary wide" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "register" ? "Register and verify email" : "Sign in securely"}</button>
    </form> : <div className="portal-form-grid one">
      <label className="portal-field"><span>Indian mobile number *</span><div className="phone-entry"><b>+91</b><input inputMode="numeric" maxLength={10} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))} value={phone} /></div></label>
      {!otpSent ? <button className="portal-primary wide" disabled={busy} onClick={() => void sendOtp()} type="button">{busy ? "Sending…" : "Send OTP"}</button> : <><label className="portal-field"><span>6-digit OTP *</span><input inputMode="numeric" maxLength={6} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))} value={otp} /></label><button className="portal-primary wide" disabled={busy || otp.length !== 6} onClick={() => void verifyOtp()} type="button">{busy ? "Verifying…" : "Verify and continue"}</button></>}
    </div>}
  </section>;
}
