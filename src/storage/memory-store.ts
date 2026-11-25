import type { Cashbox, FiscalPeriod, LedgerAccount } from "../core/finance";
import { deserializeJournal, freezeJournal, serializeJournal, type JournalEntry, type JournalRecord } from "../core/journal";
import type { AccountingStore, AuditRecord } from "./types";

export type MemoryStoreSeed = Readonly<{
  tenantId: string;
  accounts: readonly LedgerAccount[];
  cashboxes?: readonly Cashbox[];
  fiscalPeriods: readonly FiscalPeriod[];
}>;

export class InMemoryAccountingStore implements AccountingStore {
  readonly kind = "memory" as const;

  private readonly accountsByTenant = new Map<string, LedgerAccount[]>();
  private readonly cashboxesByTenant = new Map<string, Cashbox[]>();
  private readonly periodsByTenant = new Map<string, FiscalPeriod[]>();
  private readonly journalsByTenant = new Map<string, JournalRecord[]>();
  private readonly idempotencyIndex = new Map<string, readonly string[]>();
  private readonly linkedGroupsByJournal = new Map<string, readonly string[]>();
  private readonly auditsByTenant = new Map<string, AuditRecord[]>();

  constructor(seed?: MemoryStoreSeed) {
    if (seed) this.seedTenant(seed);
  }

  seedTenant(seed: MemoryStoreSeed): void {
    this.accountsByTenant.set(seed.tenantId, [...seed.accounts]);
    this.cashboxesByTenant.set(seed.tenantId, [...(seed.cashboxes ?? [])]);
    this.periodsByTenant.set(seed.tenantId, [...seed.fiscalPeriods]);
    if (!this.journalsByTenant.has(seed.tenantId)) this.journalsByTenant.set(seed.tenantId, []);
    if (!this.auditsByTenant.has(seed.tenantId)) this.auditsByTenant.set(seed.tenantId, []);
  }

  listAccounts(tenantId: string): readonly LedgerAccount[] {
    return Object.freeze([...(this.accountsByTenant.get(tenantId) ?? [])]);
  }

  saveAccount(tenantId: string, account: LedgerAccount): void {
    if (account.tenantId !== tenantId) throw new Error("Cross-tenant account write blocked.");
    const list = this.accountsByTenant.get(tenantId) ?? [];
    if (list.some((a) => a.id === account.id || a.code === account.code)) {
      throw new Error(`Account ${account.code} already exists.`);
    }
    list.push(Object.freeze({ ...account }));
    this.accountsByTenant.set(tenantId, list);
  }

  listCashboxes(tenantId: string): readonly Cashbox[] {
    return Object.freeze([...(this.cashboxesByTenant.get(tenantId) ?? [])]);
  }

  saveCashbox(tenantId: string, cashbox: Cashbox): void {
    if (cashbox.tenantId !== tenantId) throw new Error("Cross-tenant cashbox write blocked.");
    const list = this.cashboxesByTenant.get(tenantId) ?? [];
    if (list.some((c) => c.id === cashbox.id || c.code === cashbox.code)) {
      throw new Error(`Cashbox ${cashbox.code} already exists.`);
    }
    list.push(Object.freeze({ ...cashbox }));
    this.cashboxesByTenant.set(tenantId, list);
  }

  listFiscalPeriods(tenantId: string): readonly FiscalPeriod[] {
    return Object.freeze([...(this.periodsByTenant.get(tenantId) ?? [])]);
  }

  saveFiscalPeriod(tenantId: string, period: FiscalPeriod): void {
    if (period.tenantId !== tenantId) throw new Error("Cross-tenant fiscal period write blocked.");
    const list = this.periodsByTenant.get(tenantId) ?? [];
    const idx = list.findIndex((p) => p.id === period.id);
    if (idx >= 0) list[idx] = Object.freeze({ ...period });
    else list.push(Object.freeze({ ...period }));
    this.periodsByTenant.set(tenantId, list);
  }

  listJournals(tenantId: string): readonly JournalEntry[] {
    const records = this.journalsByTenant.get(tenantId) ?? [];
    return Object.freeze(records.map((r) => freezeJournal(deserializeJournal(r))));
  }

  listAuditLogs(tenantId: string): readonly AuditRecord[] {
    return Object.freeze([...(this.auditsByTenant.get(tenantId) ?? [])]);
  }

  findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): JournalEntry | undefined {
    return this.findJournalBatchByIdempotencyKey(tenantId, idempotencyKey)?.[0];
  }

  findJournalBatchByIdempotencyKey(tenantId: string, idempotencyKey: string): readonly JournalEntry[] | undefined {
    const ids = this.idempotencyIndex.get(`${tenantId}::${idempotencyKey}`);
    if (!ids || ids.length === 0) return undefined;
    const map = new Map((this.journalsByTenant.get(tenantId) ?? []).map((r) => [r.id, r]));
    const found: JournalEntry[] = [];
    for (const id of ids) {
      const rec = map.get(id);
      if (rec) found.push(freezeJournal(deserializeJournal(rec)));
    }
    return found.length === ids.length ? Object.freeze(found) : undefined;
  }

  findLinkedJournalIds(tenantId: string, journalId: string): readonly string[] {
    return this.linkedGroupsByJournal.get(`${tenantId}::${journalId}`) ?? Object.freeze([journalId]);
  }

  savePostedJournal(tenantId: string, idempotencyKey: string, entry: JournalEntry, audit: AuditRecord): void {
    this.savePostedJournalBatch(tenantId, idempotencyKey, [entry], audit);
  }

  savePostedJournalBatch(tenantId: string, idempotencyKey: string, entries: readonly JournalEntry[], audit: AuditRecord): void {
    if (entries.length === 0) throw new Error("At least one journal entry is required.");
    for (const entry of entries) {
      if (entry.tenantId !== tenantId) throw new Error("Cross-tenant storage write blocked.");
    }
    const key = `${tenantId}::${idempotencyKey}`;
    if (this.idempotencyIndex.has(key)) throw new Error(`Duplicate idempotency key: ${idempotencyKey}`);

    const list = this.journalsByTenant.get(tenantId) ?? [];
    const ids: string[] = [];
    for (const entry of entries) {
      list.push(serializeJournal(entry));
      ids.push(entry.id);
    }
    this.journalsByTenant.set(tenantId, list);
    const frozenIds = Object.freeze(ids);
    this.idempotencyIndex.set(key, frozenIds);

    if (ids.length > 1) {
      for (const id of ids) this.linkedGroupsByJournal.set(`${tenantId}::${id}`, frozenIds);
    }

    const audits = this.auditsByTenant.get(tenantId) ?? [];
    audits.unshift(Object.freeze({ ...audit }));
    this.auditsByTenant.set(tenantId, audits);
  }
}
