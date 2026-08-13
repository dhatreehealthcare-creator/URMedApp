"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, CheckCircle2, MailCheck, ShieldCheck } from "lucide-react";
import { isRoleSessionAuthorized, type WorkspaceProfile } from "../lib/role-access";
import {
  inspectVendorVerificationReturn,
  vendorVerificationProfileSeed,
  type VendorVerificationUser,
} from "../lib/vendor-verification-return";
import { getAuthClient } from "./marketplace-client";

type ReturnState = { kind: "checking" | "signed_in" | "returned" | "error"; message: string };

const cleanReturnPath = "/vendor/verification-return";
const statusPath = "/vendor/registration/status";
const genericVerificationError = "This verification link is invalid, expired, or has already been used. Sign in with your vendor email to request a new link.";

async function finalizeVendorProfile(accessToken: string, user: VendorVerificationUser): Promise<WorkspaceProfile> {
  const headers = { Authorization: `Bearer ${accessToken}` };
  let response = await fetch("/api/auth/profile", { headers, cache: "no-store" });
  let payload = await response.json() as { profile?: WorkspaceProfile | null; error?: string };
  if (response.ok && !payload.profile) {
    const seed = vendorVerificationProfileSeed(user);
    if (!seed) throw new Error("The verified account is not a valid vendor registration. Sign in with the vendor account used during registration.");
    response = await fetch("/api/auth/profile", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(seed),
    });
    payload = await response.json() as { profile?: WorkspaceProfile | null; error?: string };
  }
  if (!response.ok || !payload.profile) throw new Error(payload.error || "The verified vendor profile could not be loaded. Sign in to continue.");
  if (!isRoleSessionAuthorized(payload.profile, "vendor")) {
    throw new Error("This verified session does not belong to an active vendor account. Sign in with the vendor account used during registration.");
  }
  return payload.profile;
}

export function VendorVerificationReturn({ initialProblem = false }: { initialProblem?: boolean }) {
  const mounted = useRef(false);
  const processingStarted = useRef(false);
  const [state, setState] = useState<ReturnState>(initialProblem
    ? { kind: "error", message: "This verification link is invalid or has expired. Return to vendor sign-in to request a new link." }
    : { kind: "checking", message: "Checking the verification return…" });

  useEffect(() => {
    mounted.current = true;
    if (processingStarted.current) return () => { mounted.current = false; };
    processingStarted.current = true;
    const inspection = inspectVendorVerificationReturn(window.location.href);
    const cleanUrl = () => window.history.replaceState({}, "", initialProblem ? `${cleanReturnPath}/problem` : cleanReturnPath);
    if (initialProblem) {
      cleanUrl();
      return () => { mounted.current = false; };
    }

    void (async () => {
      if (inspection.kind === "provider_error" || inspection.kind === "invalid") {
        cleanUrl();
        if (mounted.current) setState({ kind: "error", message: genericVerificationError });
        return;
      }
      try {
        const client = await getAuthClient();
        if (!client) throw new Error("Authentication is not connected yet. Sign in after the private Supabase keys are configured.");

        let session;
        if (inspection.kind === "session") {
          // Remove provider tokens before the validation request. setSession
          // validates them with Supabase and persists only a valid session.
          cleanUrl();
          const result = await client.auth.setSession({
            access_token: inspection.accessToken,
            refresh_token: inspection.refreshToken,
          });
          if (result.error) throw result.error;
          session = result.data.session;
        } else {
          cleanUrl();
          session = (await client.auth.getSession()).data.session;
        }

        if (!session) {
          if (mounted.current) setState({ kind: "returned", message: "No active verification session was found. Sign in with your vendor email to continue or request a new link." });
          return;
        }
        const { data: providerData, error: providerError } = await client.auth.getUser();
        if (providerError || !providerData.user?.email_confirmed_at) throw providerError ?? new Error(genericVerificationError);
        await finalizeVendorProfile(session.access_token, providerData.user);
        if (!mounted.current) return;
        setState({ kind: "signed_in", message: "Email verified and secure vendor session completed. Continuing to your registration status…" });
        window.location.replace(statusPath);
      } catch (reason) {
        cleanUrl();
        if (mounted.current) setState({
          kind: "error",
          message: reason instanceof Error && /not connected/i.test(reason.message) ? reason.message : genericVerificationError,
        });
      }
    })();
    return () => { mounted.current = false; };
  }, [initialProblem]);

  return <main className="vendor-milestone-page">
    <section className="vendor-milestone-shell verification-return-shell">
      <Link className="milestone-back" href="/"><ArrowLeft size={16} /> URMED marketplace</Link>
      <div className={`milestone-hero ${state.kind}`}>
        <span className="milestone-icon">{state.kind === "error" ? <AlertTriangle size={30} /> : state.kind === "returned" ? <MailCheck size={30} /> : state.kind === "signed_in" ? <CheckCircle2 size={30} /> : <ShieldCheck size={30} />}</span>
        <small>VENDOR EMAIL VERIFICATION</small>
        <h1>{state.kind === "error" ? "Verification needs attention" : state.kind === "returned" ? "Vendor sign-in required" : state.kind === "signed_in" ? "Verification completed" : "Securing verified session"}</h1>
        <p>{state.message}</p>
        <div className="milestone-actions">
          <Link className="portal-primary" href="/vendor/login">Sign in with vendor email</Link>
          <Link className="portal-outline" href={statusPath}>View registration status</Link>
        </div>
      </div>
      <div className="milestone-privacy"><CheckCircle2 size={18} /><span><strong>Provider verification remains authoritative.</strong><small>Callback tokens are removed from the address before validation, and URMED confirms the resulting provider session server-side. The vendor sign-in fallback remains available if the link is expired or the session cannot be completed.</small></span></div>
    </section>
  </main>;
}
