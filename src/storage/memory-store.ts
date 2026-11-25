import type { FiscalPeriod, LedgerAccount } from "../core/finance";
import { deserializeJournal, freezeJournal, serializeJournal, type JournalEntry, type JournalRecord } from "../core/journal";
import type { AccountingStore, AuditRecord } from "./types";

export type MemoryStoreSeed = Readonly<{
  tenantId: string;
  accounts: readonly LedgerAccount[];
  fiscalPeriods: readonly FiscalPeriod[];
}>;

export class InMemoryAccountingStore implements AccountingStore {
  readonly kind = "memory" as const;

  private readonly accountsByTenant = new Map<string, readonly LedgerAccount[]>();
  private readonly periodsByTenant = new Map<string, readonly FiscalPeriod[]>();
  private readonly journalsByTenant = new Map<string, JournalRecord[]>();
  private readonly idempotencyIndex = new Map<string, string>();
  private readonly auditsByTenant = new Map<string, AuditRecord[]>();

  constructor(seed?: MemoryStoreSeed) {
    if (seed) this.seedTenant(seed);
  }

  seedTenant(seed: MemoryStoreSeed): void {
    this.accountsByTenant.set(seed.tenantId, Object.freeze([...seed.accounts]));
    this.periodsByTenant.set(seed.tenantId, Object.freeze([...seed.fiscalPeriods]));
    if (!this.journalsByTenant.has(seed.tenantId)) this.journalsByTenant.set(seed.tenantId, []);
    if (!this.auditsByTenant.has(seed.tenantId)) this.auditsByTenant.set(seed.tenantId, []);
  }

  listAccounts(tenantId: string): readonly LedgerAccount[] {
    return this.accountsByTenant.get(tenantId) ?? [];
  }

  listFiscalPeriods(tenantId: string): readonly FiscalPeriod[] {
    return this.periodsByTenant.get(tenantId) ?? [];
  }

  listJournals(tenantId: string): readonly JournalEntry[] {
    const records = this.journalsByTenant.get(tenantId) ?? [];
    return Object.freeze(records.map((r) => freezeJournal(deserializeJournal(r))));
  }

  listAuditLogs(tenantId: string): readonly AuditRecord[] {
    return Object.freeze([...(this.auditsByTenant.get(tenantId) ?? [])]);
  }

  findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): JournalEntry | undefined {
    const existingId = this.idempotencyIndex.get(`${tenantId}::${idempotencyKey}`);
    if (!existingId) return undefined;
    const found = (this.journalsByTenant.get(tenantId) ?? []).find((r) => r.id === existingId);
    return found ? freezeJournal(deserializeJournal(found)) : undefined;
  }

  savePostedJournal(tenantId: string, idempotencyKey: string, entry: JournalEntry, audit: AuditRecord): void {
    if (entry.tenantId !== tenantId) throw new Error("Cross-tenant storage write blocked.");
    const key = `${tenantId}::${idempotencyKey}`;
    if (this.idempotencyIndex.has(key)) throw new Error(`Duplicate idempotency key: ${idempotencyKey}`);

    const list = this.journalsByTenant.get(tenantId) ?? [];
    list.push(serializeJournal(entry));
    this.journalsByTenant.set(tenantId, list);
    this.idempotencyIndex.set(key, entry.id);

    const audits = this.auditsByTenant.get(tenantId) ?? [];
    audits.unshift(Object.freeze({ ...audit }));
    this.auditsByTenant.set(tenantId, audits);
  }
}
