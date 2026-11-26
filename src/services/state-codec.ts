import type { SamaWorkspace } from "./workspace-facade";

type EncodedBigInt = { __t: "bi"; v: string };
type EncodedMap = { __t: "map"; e: Array<[unknown, unknown]> };
type EncodedSet = { __t: "set"; v: unknown[] };
type EncodedInst = { __t: "inst"; f: Record<string, unknown> };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!isRecord(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encodeValue(val: unknown, skip: Set<unknown>): unknown {
  if (val === null || val === undefined) return val;
  if (typeof val === "bigint") return { __t: "bi", v: val.toString() } satisfies EncodedBigInt;
  if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") return val;
  if (typeof val === "function" || skip.has(val)) return undefined;
  if (val instanceof Map) {
    const e: Array<[unknown, unknown]> = [];
    for (const [k, v] of val.entries()) e.push([encodeValue(k, skip), encodeValue(v, skip)]);
    return { __t: "map", e } satisfies EncodedMap;
  }
  if (val instanceof Set) {
    return { __t: "set", v: Array.from(val.values()).map((x) => encodeValue(x, skip)) } satisfies EncodedSet;
  }
  if (Array.isArray(val)) return val.map((x) => encodeValue(x, skip));
  if (isPlainObject(val)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      const ev = encodeValue(v, skip);
      if (ev !== undefined) out[k] = ev;
    }
    return out;
  }
  if (isRecord(val)) return { __t: "inst", f: encodeInstance(val, skip) } satisfies EncodedInst;
  return undefined;
}

function encodeInstance(inst: Record<string, unknown>, skip: Set<unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inst)) {
    if (typeof v === "function" || skip.has(v)) continue;
    const ev = encodeValue(v, skip);
    if (ev !== undefined) fields[k] = ev;
  }
  return fields;
}
function decodeValue(val: unknown): unknown {
  if (val === null || val === undefined || typeof val !== "object") return val;
  if (Array.isArray(val)) return val.map((x) => decodeValue(x));
  const rec = val as Record<string, unknown>;
  if (rec.__t === "bi" && typeof rec.v === "string") return BigInt(rec.v);
  if (rec.__t === "map" && Array.isArray(rec.e)) {
    const m = new Map<unknown, unknown>();
    for (const pair of rec.e as Array<[unknown, unknown]>) m.set(decodeValue(pair[0]), decodeValue(pair[1]));
    return m;
  }
  if (rec.__t === "set" && Array.isArray(rec.v)) {
    return new Set<unknown>(rec.v.map((x) => decodeValue(x)));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = decodeValue(v);
  return out;
}

function hydrateInstance(target: Record<string, unknown>, fields: Record<string, unknown>): void {
  for (const [k, raw] of Object.entries(fields)) {
    if (isRecord(raw) && raw.__t === "inst" && isRecord(raw.f) && isRecord(target[k])) {
      hydrateInstance(target[k] as Record<string, unknown>, raw.f);
      continue;
    }
    const decoded = decodeValue(raw);
    const cur = target[k];
    if (cur instanceof Map && decoded instanceof Map) {
      cur.clear();
      for (const [mk, mv] of decoded.entries()) cur.set(mk, mv);
    } else if (cur instanceof Set && decoded instanceof Set) {
      cur.clear();
      for (const sv of decoded.values()) cur.add(sv);
    } else if (Array.isArray(cur) && Array.isArray(decoded) && !Object.isFrozen(cur)) {
      cur.splice(0, cur.length, ...decoded);
    } else {
      try { target[k] = decoded; } catch { /* non-writable */ }
    }
  }
}
const SERVICE_KEYS = ["accounting", "inventory", "crm", "sales", "procurement", "repairs", "telecom", "ai", "offline"] as const;

export type SerializedWorkspaceSnapshot = Readonly<{
  schemaVersion: 2;
  tenantId: string;
  meta: Readonly<{
    defaultWarehouseId: string; partsWarehouseId: string;
    syriatelWalletId: string; mtnWalletId: string; shamCashWalletId: string;
  }>;
  services: Readonly<Record<string, Record<string, unknown>>>;
}>;

export function encodeWorkspaceState(ws: SamaWorkspace): SerializedWorkspaceSnapshot {
  const skip = new Set<unknown>(SERVICE_KEYS.map((k) => ws[k]));
  skip.add(ws.reports);
  const services: Record<string, Record<string, unknown>> = {};
  for (const key of SERVICE_KEYS) {
    services[key] = encodeInstance(ws[key] as unknown as Record<string, unknown>, skip);
  }
  return Object.freeze({
    schemaVersion: 2, tenantId: ws.tenantId,
    meta: Object.freeze({
      defaultWarehouseId: ws.defaultWarehouseId, partsWarehouseId: ws.partsWarehouseId,
      syriatelWalletId: ws.syriatelWalletId, mtnWalletId: ws.mtnWalletId, shamCashWalletId: ws.shamCashWalletId,
    }),
    services: Object.freeze(services),
  });
}

export function hydrateWorkspaceState(ws: SamaWorkspace, raw: unknown): SamaWorkspace {
  if (!isRecord(raw) || raw.schemaVersion !== 2 || !isRecord(raw.services)) return ws;
  for (const key of SERVICE_KEYS) {
    const fields = raw.services[key];
    if (isRecord(fields)) hydrateInstance(ws[key] as unknown as Record<string, unknown>, fields);
  }
  const m = isRecord(raw.meta) ? raw.meta : null;
  if (!m) return ws;
  return Object.freeze({
    ...ws,
    defaultWarehouseId: typeof m.defaultWarehouseId === "string" ? m.defaultWarehouseId : ws.defaultWarehouseId,
    partsWarehouseId: typeof m.partsWarehouseId === "string" ? m.partsWarehouseId : ws.partsWarehouseId,
    syriatelWalletId: typeof m.syriatelWalletId === "string" ? m.syriatelWalletId : ws.syriatelWalletId,
    mtnWalletId: typeof m.mtnWalletId === "string" ? m.mtnWalletId : ws.mtnWalletId,
    shamCashWalletId: typeof m.shamCashWalletId === "string" ? m.shamCashWalletId : ws.shamCashWalletId,
  });
}
