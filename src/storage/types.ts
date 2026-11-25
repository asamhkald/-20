import type { FiscalPeriod, LedgerAccount } from "../core/finance";
import type { JournalEntry } from "../core/journal";

export type AuditRecord = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  action: "journal.posted" | "journal.reversed";
  entityId: string;
  occurredAt: string;
  summary: string;
}>;

export interface AccountingStore {
  readonly kind: "memory" | "supabase";
  listAccounts(tenantId: string): readonly LedgerAccount[];
  listFiscalPeriods(tenantId: string): readonly FiscalPeriod[];
  listJournals(tenantId: string): readonly JournalEntry[];
  listAuditLogs(tenantId: string): readonly AuditRecord[];
  findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): JournalEntry | undefined;
  savePostedJournal(
    tenantId: string,
    idempotencyKey: string,
    entry: JournalEntry,
    audit: AuditRecord,
  ): void;
}
