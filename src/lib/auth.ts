import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveVerifiedSession, type VerifiedSessionContext } from "../core/security";
import { TENANT_ROLES, type TenantRole } from "../core/tenant";
import { supabase } from "./supabase";

type ProfileRow = { id: string; tenant_id: string | null; full_name: string; role: string };
type TenantRow = { id: string; shop_name: string; is_active: boolean; expires_at: string };

function normalizeRole(rawRole: string): TenantRole {
  if (rawRole === "super_admin") return "owner";
  return (TENANT_ROLES as readonly string[]).includes(rawRole) ? (rawRole as TenantRole) : "readonly";
}

function requireClient(client?: SupabaseClient | null): SupabaseClient {
  const active = client ?? supabase;
  if (!active) throw new Error("Supabase client is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.");
  return active;
}

export async function signInWithEmailPassword(
  email: string,
  password: string,
  client?: SupabaseClient | null,
): Promise<VerifiedSessionContext> {
  const sb = requireClient(client);
  const { data, error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error || !data.user) throw new Error(error?.message || "Authentication failed.");
  return loadVerifiedSession(sb);
}

export async function signOutSession(client?: SupabaseClient | null): Promise<void> {
  const sb = requireClient(client);
  const { error } = await sb.auth.signOut();
  if (error) throw new Error(error.message);
}

export async function loadVerifiedSession(client?: SupabaseClient | null): Promise<VerifiedSessionContext> {
  const sb = requireClient(client);
  const { data: userData, error: userErr } = await sb.auth.getUser();
  if (userErr || !userData.user) throw new Error(userErr?.message || "No active authenticated session.");

  const userId = userData.user.id;
  const profRes = await sb.from("profiles").select("id, tenant_id, full_name, role").eq("id", userId).single();
  const profile = profRes.data as ProfileRow | null;
  if (profRes.error || !profile || !profile.tenant_id) {
    throw new Error(profRes.error?.message || "Server membership profile not found.");
  }

  const tenRes = await sb.from("tenants").select("id, shop_name, is_active, expires_at").eq("id", profile.tenant_id).single();
  const tenant = tenRes.data as TenantRow | null;
  if (tenRes.error || !tenant) throw new Error(tenRes.error?.message || "Organization record not found.");

  return resolveVerifiedSession({
    userId,
    organization: {
      id: tenant.id,
      legalName: tenant.shop_name,
      baseCurrency: "USD",
      timezone: "Asia/Damascus",
      locale: "ar-SY",
      fiscalYearStartMonth: 1,
      status: tenant.is_active ? "active" : "suspended",
    },
    membership: {
      id: `mem-${profile.id}`,
      tenantId: tenant.id,
      userId: profile.id,
      role: normalizeRole(profile.role),
      status: "active",
    },
    expiresAtIso: tenant.expires_at,
  });
}
