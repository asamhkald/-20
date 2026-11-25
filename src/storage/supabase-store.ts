import type { Cashbox, FiscalPeriod, LedgerAccount } from "../core/finance";
import type { JournalEntry } from "../core/journal";
import type { AccountingStore, AuditRecord } from "./types";

export class SupabaseAccountingStorePlaceholder implements AccountingStore {
  readonly kind = "supabase" as const;
  private fail(): never {
    throw new Error("SupabaseAccountingStore is reserved for Phase 3 after database & RLS verification.");
  }
  listAccounts(_tenantId: string): readonly LedgerAccount[] { return this.fail(); }
  saveAccount(_tenantId: string, _account: LedgerAccount): void { return this.fail(); }
  listCashboxes(_tenantId: string): readonly Cashbox[] { return this.fail(); }
  saveCashbox(_tenantId: string, _cashbox: Cashbox): void { return this.fail(); }
  listFiscalPeriods(_tenantId: string): readonly FiscalPeriod[] { return this.fail(); }
  saveFiscalPeriod(_tenantId: string, _period: FiscalPeriod): void { return this.fail(); }
  listJournals(_tenantId: string): readonly JournalEntry[] { return this.fail(); }
  listAuditLogs(_tenantId: string): readonly AuditRecord[] { return this.fail(); }
  findJournalByIdempotencyKey(_tenantId: string, _idempotencyKey: string): JournalEntry | undefined { return this.fail(); }
  findJournalBatchByIdempotencyKey(_tenantId: string, _idempotencyKey: string): readonly JournalEntry[] | undefined { return this.fail(); }
  findLinkedJournalIds(_tenantId: string, _journalId: string): readonly string[] { return this.fail(); }
  savePostedJournal(_tenantId: string, _idempotencyKey: string, _entry: JournalEntry, _audit: AuditRecord): void { return this.fail(); }
  savePostedJournalBatch(_tenantId: string, _idempotencyKey: string, _entries: readonly JournalEntry[], _audit: AuditRecord): void { return this.fail(); }
}
