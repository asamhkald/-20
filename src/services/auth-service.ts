import { resolveVerifiedSession, toTenantContext, type VerifiedSessionContext } from "../core/security";
import type { TenantContext } from "../core/tenant";
import { loadVerifiedSession, signInWithEmailPassword, signOutSession } from "../lib/auth";
import { supabase } from "../lib/supabase";

export type AuthMode = "cloud" | "sandbox";

export type ActiveUserSession = Readonly<{
  mode: AuthMode;
  verified: VerifiedSessionContext;
}>;

export function isCloudAuthConfigured(): boolean {
  return supabase !== null;
}

export async function restoreCloudSession(): Promise<ActiveUserSession | null> {
  if (!supabase) return null;
  try {
    const verified = await loadVerifiedSession(supabase);
    return Object.freeze({ mode: "cloud", verified });
  } catch {
    return null;
  }
}

export async function signInCloud(email: string, password: string): Promise<ActiveUserSession> {
  if (!email.trim() || !password) throw new Error("يرجى إدخال البريد الإلكتروني وكلمة المرور.");
  const verified = await signInWithEmailPassword(email, password, supabase);
  return Object.freeze({ mode: "cloud", verified });
}

export async function signOutCloud(): Promise<void> {
  if (!supabase) return;
  await signOutSession(supabase);
}

export function createSandboxSession(shopName = "بيئة التجربة المعزولة"): ActiveUserSession {
  const verified = resolveVerifiedSession({
    userId: "sandbox-owner",
    organization: { id: "sama-main-shop", legalName: shopName, baseCurrency: "USD", timezone: "Asia/Damascus", locale: "ar-SY", fiscalYearStartMonth: 1, status: "active" },
    membership: { id: "sandbox-mem-1", tenantId: "sama-main-shop", userId: "sandbox-owner", role: "owner", status: "active" },
  });
  return Object.freeze({ mode: "sandbox", verified });
}

export function sessionToActor(session: ActiveUserSession): TenantContext {
  return toTenantContext(session.verified);
}
