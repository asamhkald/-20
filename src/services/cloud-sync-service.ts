import type { TenantContext } from "../core/tenant";
import { supabase } from "../lib/supabase";
import { encodeWorkspaceState, hydrateWorkspaceState } from "./state-codec";
import type { SamaWorkspace } from "./workspace-facade";

export type CloudSyncClient = Readonly<{
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string): {
        maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: { message: string } | null }>;
      };
    };
  };
  rpc(fn: string, params: Record<string, unknown>): Promise<{ data: unknown; error: { message: string } | null }>;
}>;

export type CloudLoadResult = Readonly<{
  workspace: SamaWorkspace;
  version: number | null;
  loadedFromCloud: boolean;
  updatedAt?: string;
}>;

export type CloudSaveResult = Readonly<{
  version: number;
  checksum: string;
  savedAt: string;
}>;

async function computeChecksumHex(text: string): Promise<string> {
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const bytes = new TextEncoder().encode(text);
    const buf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function getClient(override?: CloudSyncClient | null): CloudSyncClient {
  const client = override ?? (supabase as unknown as CloudSyncClient | null);
  if (!client) throw new Error("عميل Supabase غير مفعّل.");
  return client;
}
export async function loadCloudWorkspace(
  ws: SamaWorkspace, actor: TenantContext, clientOverride?: CloudSyncClient | null,
): Promise<CloudLoadResult> {
  const client = getClient(clientOverride);
  const { data, error } = await client
    .from("sama_v2_workspace_state")
    .select("version, state_json, checksum_sha256, updated_at")
    .eq("tenant_id", actor.tenantId)
    .maybeSingle();

  if (error) throw new Error(`تعذر تحميل البيانات السحابية: ${error.message}`);
  if (!data || !data.state_json || typeof data.version !== "number") {
    return Object.freeze({ workspace: ws, version: null, loadedFromCloud: false });
  }
  return Object.freeze({
    workspace: hydrateWorkspaceState(ws, data.state_json),
    version: data.version, loadedFromCloud: true,
    updatedAt: typeof data.updated_at === "string" ? data.updated_at : undefined,
  });
}

function collectLedgerEvents(ws: SamaWorkspace, actor: TenantContext): Array<Record<string, unknown>> {
  try {
    return ws.accounting.getSnapshot(actor).entries.map((je) => {
      const maybeIdem = (je as { idempotencyKey?: unknown }).idempotencyKey;
      const idempotencyKey = typeof maybeIdem === "string" && maybeIdem.trim() ? maybeIdem : je.id;
      return {
        idempotencyKey, entryId: je.id, entryNumber: je.entryNumber,
        businessDate: je.businessDate, memo: je.memo, reversalOfId: je.reversalOfId ?? "",
        lines: je.lines.map((l) => ({
          accountId: l.accountId, currency: l.currency,
          debitMinor: l.debitMinor.toString(), creditMinor: l.creditMinor.toString(),
        })),
      };
    });
  } catch { return []; }
}

export async function saveCloudWorkspace(
  ws: SamaWorkspace, actor: TenantContext, expectedVersion: number | null, clientOverride?: CloudSyncClient | null,
): Promise<CloudSaveResult> {
  const client = getClient(clientOverride);
  const jsonText = JSON.stringify(encodeWorkspaceState(ws));
  const checksum = await computeChecksumHex(jsonText);
  const { data, error } = await client.rpc("sama_v2_save_workspace", {
    p_expected_version: expectedVersion, p_state_json: JSON.parse(jsonText),
    p_checksum: checksum, p_new_events: collectLedgerEvents(ws, actor),
  });
  if (error) throw new Error(error.message);
  const rec = (data ?? {}) as Record<string, unknown>;
  return Object.freeze({
    version: typeof rec.version === "number" ? rec.version : (expectedVersion ?? 0) + 1,
    checksum, savedAt: typeof rec.saved_at === "string" ? rec.saved_at : new Date().toISOString(),
  });
}
