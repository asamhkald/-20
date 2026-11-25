import type { FiscalPeriod, LedgerAccount } from "../core/finance";
import type { JournalEntry } from "../core/journal";
import type { AccountingStore, AuditRecord } from "./types";

export class SupabaseAccountingStorePlaceholder implements AccountingStore {
  readonly kind = "supabase" as const;

  private fail(): never {
    throw new Error("SupabaseAccountingStore is reserved for Phase 3 after database & RLS verification.");
  }

  listAccounts(_tenantId: string): readonly LedgerAccount[] { return this.fail(); }
  listFiscalPeriods(_tenantId: string): readonly FiscalPeriod[] { return this.fail(); }
  listJournals(_tenantId: string): readonly JournalEntry[] { return this.fail(); }
  listAuditLogs(_tenantId: string): readonly AuditRecord[] { return this.fail(); }
  findJournalByIdempotencyKey(_tenantId: string, _idempotencyKey: string): JournalEntry | undefined { return this.fail(); }
  savePostedJournal(_tenantId: string, _idempotencyKey: string, _entry: JournalEntry, _audit: AuditRecord): void { this.fail(); }
}
