"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, LogOut, MailCheck, MessageSquareText, ShieldCheck } from "lucide-react";
import { isWorkspaceRoleAuthorized, type WorkspaceProfile, type WorkspaceRole } from "../lib/role-access";
import { clearTestAccessToken, getAuthClient, getRuntimeConfig, getTestAccessToken, setTestAccessToken, type RuntimeConfig } from "./marketplace-client";

const roleLabels: Record<WorkspaceRole, string> = {
  customer: "Customer",
  vendor: "Vendor",
  admin: "Administrator",
  delivery: "Delivery agent",
};

export function AuthPanel({ role, onProfileChange }: { role: WorkspaceRole; onProfileChange?: (profile: WorkspaceProfile | null) => void }) {
  const provisionedRole = role === "admin" || role === "delivery";
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [mode, setMode] = useState<"register" | "login">(provisionedRole ? "login" : "register");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
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
    const nextProfile = payload.profile ?? null;
    if (nextProfile && !isWorkspaceRoleAuthorized(nextProfile, role)) throw new Error(`Sign in with an active ${role} account to continue`);
    setProfile(nextProfile);
    onProfileChange?.(nextProfile);
  }, [onProfileChange, provisionedRole, role]);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void getRuntimeConfig().then((value) => active && setConfig(value)).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Configuration unavailable"));
    const testToken = getTestAccessToken();
    void getAuthClient().then(async (client) => {
      if (testToken) {
        await syncProfile(testToken).catch(() => { clearTestAccessToken(); onProfileChange?.(null); });
        return;
      }
      if (!client) return;
      const session = (await client.auth.getSession()).data.session;
      if (session && active) {
        const metadata = session.user.user_metadata ?? {};
        await syncProfile(session.access_token, {
          role: metadata.role || role,
          name: metadata.name || metadata.owner_name || session.user.email?.split("@")[0] || "URMED user",
          businessName: metadata.business_name || "Pharmacy registration",
          phone: session.user.phone || String(metadata.phone || ""),
        }).catch((reason) => active && setError(reason instanceof Error ? reason.message : "Profile unavailable"));
      }
      const { data } = client.auth.onAuthStateChange((_event, sessionValue) => {
        if (!active) return;
        if (!sessionValue) { setProfile(null); onProfileChange?.(null); }
      });
      unsubscribe = () => data.subscription.unsubscribe();
    });
    return () => { active = false; unsubscribe?.(); };
  }, [onProfileChange, role, syncProfile]);

  const finishSignIn = async (accessToken: string) => {
    await syncProfile(accessToken, provisionedRole ? undefined : { role, name: name || email.split("@")[0] || "URMED user", businessName, phone });
    setMessage(`${roleLabels[role]} sign-in completed.`);
  };

  const submitEmail = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      if (mode === "login" && email.trim().toLowerCase().endsWith("@urmed.test")) {
        const response = await fetch("/api/auth/test-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
        const payload = await response.json() as { token?: string; error?: string };
        if (!response.ok || !payload.token) throw new Error(payload.error || "Test login failed");
        setTestAccessToken(payload.token);
        try { await syncProfile(payload.token); }
        catch (error) { clearTestAccessToken(); throw error; }
        setMessage(`${roleLabels[role]} test sign-in completed. Session expires in 8 hours.`);
        return;
      }
      const client = await getAuthClient();
      if (!client) throw new Error("Authentication keys are not connected yet");
      if (mode === "register") {
        if (!name.trim()) throw new Error("Name is required");
        if (role === "vendor" && !businessName.trim()) throw new Error("Shop or business name is required");
        if (role === "vendor" && !/^\d{10}$/.test(phone)) throw new Error("Enter the vendor’s 10-digit mobile number");
        const { data, error: authError } = await client.auth.signUp({
          email: email.trim(), password,
          options: { emailRedirectTo: window.location.origin, data: { role, name: name.trim(), owner_name: name.trim(), business_name: businessName.trim(), phone } },
        });
        if (authError) throw authError;
        if (data.session) await finishSignIn(data.session.access_token);
        else setMessage("Registration received. Open the verification email, then return here to continue.");
      } else {
        const { data, error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (authError && /email not confirmed/i.test(authError.message)) {
          const { error: resendError } = await client.auth.resend({ type: "signup", email: email.trim(), options: { emailRedirectTo: window.location.origin } });
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
      if (mode === "register" && !name.trim()) throw new Error("Enter the account holder name first");
      if (mode === "register" && role === "vendor" && !businessName.trim()) throw new Error("Enter the shop or business name first");
      const client = await getAuthClient();
      if (!client) throw new Error("OTP keys are not connected yet");
      const { error: authError } = await client.auth.signInWithOtp({ phone: `+91${phone}`, options: { data: { role, name: name.trim(), owner_name: name.trim(), business_name: businessName.trim() } } });
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

  const signOut = async () => {
    const testToken = getTestAccessToken();
    if (testToken) await fetch("/api/auth/test-login", { method: "DELETE", headers: { Authorization: `Bearer ${testToken}` } });
    clearTestAccessToken();
    const client = await getAuthClient();
    await client?.auth.signOut();
    setProfile(null); onProfileChange?.(null); setMessage("Signed out securely.");
  };

  if (profile) return <section className="auth-live-card"><span><CheckCircle2 size={28} /></span><div><small>AUTHENTICATED {profile.role.toUpperCase()}</small><h3>{profile.name}</h3><p>{profile.email || profile.phone} · Account {profile.status}</p></div><button onClick={() => void signOut()} type="button"><LogOut size={16} /> Sign out</button></section>;

  return <section className="portal-panel auth-panel-live">
    <div className="portal-panel-heading"><div><span className="portal-kicker">LIVE {role.toUpperCase()} ACCESS</span><h2>{mode === "register" ? `Create ${role} account` : `${roleLabels[role]} login`}</h2><p>{provisionedRole ? `${roleLabels[role]} access requires a pre-provisioned active profile. Public registration cannot create this role.` : "Supabase secures the account, Twilio sends phone OTPs, and verified email links return the user to URMED."}</p></div><ShieldCheck size={23} /></div>
    {!config?.supabase.ready && <div className="integration-warning"><KeyRound size={18} /><span><strong>Private integration setup</strong><small>The screens are ready. Connect the test keys to send real OTPs and verification emails.</small></span></div>}
    {!provisionedRole && <div className="auth-switch"><button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")} type="button">Register</button><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")} type="button">Login</button></div>}
    {!provisionedRole && <div className="auth-switch compact"><button className={method === "email" ? "active" : ""} onClick={() => setMethod("email")} type="button"><MailCheck size={14} /> Email</button><button className={method === "phone" ? "active" : ""} onClick={() => setMethod("phone")} type="button"><MessageSquareText size={14} /> Phone OTP</button></div>}
    <div className="test-credentials-card"><div><strong>{roleLabels[role]} test account</strong><small>{role}@urmed.test · Urmed@Test2026!</small></div><button onClick={() => { setMode("login"); setMethod("email"); setEmail(`${role}@urmed.test`); setPassword("Urmed@Test2026!"); setMessage("Test credentials filled. Select Sign in securely."); }} type="button">Fill test credentials</button></div>
    {message && <div className="auth-message success">{message}</div>}{error && <div className="auth-message error">{error}</div>}
    {provisionedRole || method === "email" ? <form className="portal-form-grid one" onSubmit={submitEmail}>
      {mode === "register" && <><label className="portal-field"><span>{role === "vendor" ? "Owner name" : "Name"} *</span><input onChange={(event) => setName(event.target.value)} required value={name} /></label>{role === "vendor" && <><label className="portal-field"><span>Shop / business name *</span><input onChange={(event) => setBusinessName(event.target.value)} required value={businessName} /></label><label className="portal-field"><span>10-digit mobile number *</span><div className="phone-entry"><b>+91</b><input inputMode="numeric" maxLength={10} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))} pattern="[0-9]{10}" required value={phone} /></div></label></>}</>}
      <label className="portal-field"><span>Email *</span><input autoComplete="email" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} /></label>
      <label className="portal-field"><span>Password *</span><input autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} onChange={(event) => setPassword(event.target.value)} required type="password" value={password} /></label>
      <button className="portal-primary wide" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "register" ? "Register and verify email" : "Sign in securely"}</button>
    </form> : <div className="portal-form-grid one">
      {mode === "register" && <><label className="portal-field"><span>{role === "vendor" ? "Owner name" : "Name"} *</span><input onChange={(event) => setName(event.target.value)} value={name} /></label>{role === "vendor" && <label className="portal-field"><span>Shop / business name *</span><input onChange={(event) => setBusinessName(event.target.value)} value={businessName} /></label>}</>}
      <label className="portal-field"><span>Indian mobile number *</span><div className="phone-entry"><b>+91</b><input inputMode="numeric" maxLength={10} onChange={(event) => setPhone(event.target.value.replace(/\D/g, ""))} value={phone} /></div></label>
      {!otpSent ? <button className="portal-primary wide" disabled={busy} onClick={() => void sendOtp()} type="button">{busy ? "Sending…" : "Send OTP"}</button> : <><label className="portal-field"><span>6-digit OTP *</span><input inputMode="numeric" maxLength={6} onChange={(event) => setOtp(event.target.value.replace(/\D/g, ""))} value={otp} /></label><button className="portal-primary wide" disabled={busy || otp.length !== 6} onClick={() => void verifyOtp()} type="button">{busy ? "Verifying…" : "Verify and continue"}</button></>}
    </div>}
  </section>;
}
