import type { Cashbox, FiscalPeriod, LedgerAccount } from "../core/finance";
import type { JournalEntry } from "../core/journal";

export type AuditAction =
  | "journal.posted"
  | "journal.reversed"
  | "cashbox.created"
  | "cashbox.transfer"
  | "period.closed"
  | "period.opened";

export type AuditRecord = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  action: AuditAction;
  entityId: string;
  occurredAt: string;
  summary: string;
}>;

export interface AccountingStore {
  readonly kind: "memory" | "supabase";
  listAccounts(tenantId: string): readonly LedgerAccount[];
  saveAccount(tenantId: string, account: LedgerAccount): void;
  listCashboxes(tenantId: string): readonly Cashbox[];
  saveCashbox(tenantId: string, cashbox: Cashbox): void;
  listFiscalPeriods(tenantId: string): readonly FiscalPeriod[];
  saveFiscalPeriod(tenantId: string, period: FiscalPeriod): void;
  listJournals(tenantId: string): readonly JournalEntry[];
  listAuditLogs(tenantId: string): readonly AuditRecord[];
  findJournalByIdempotencyKey(tenantId: string, idempotencyKey: string): JournalEntry | undefined;
  findJournalBatchByIdempotencyKey(tenantId: string, idempotencyKey: string): readonly JournalEntry[] | undefined;
  findLinkedJournalIds(tenantId: string, journalId: string): readonly string[];
  savePostedJournal(tenantId: string, idempotencyKey: string, entry: JournalEntry, audit: AuditRecord): void;
  savePostedJournalBatch(tenantId: string, idempotencyKey: string, entries: readonly JournalEntry[], audit: AuditRecord): void;
}
