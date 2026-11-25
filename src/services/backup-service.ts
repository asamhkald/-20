import { buildTrialBalance, type Cashbox, type FiscalPeriod, type LedgerAccount } from "../core/finance";
import { deserializeJournal, serializeJournal, type JournalRecord } from "../core/journal";
import { hasPermission } from "../core/permissions";
import type { TenantContext } from "../core/tenant";
import { InMemoryAccountingStore, type AccountingStore, type AuditRecord } from "../storage";

export type BackupPayload = Readonly<{
  schemaVersion: "2.0.0";
  tenantId: string;
  exportedAt: string;
  exportedBy: string;
  accounts: readonly LedgerAccount[];
  cashboxes: readonly Cashbox[];
  fiscalPeriods: readonly FiscalPeriod[];
  journals: readonly JournalRecord[];
  auditLogs: readonly AuditRecord[];
}>;

export type SignedBackupEnvelope = Readonly<{
  algorithm: "SHA-256";
  checksumHex: string;
  payload: BackupPayload;
}>;

export type RestoreVerificationReport = Readonly<{
  tenantId: string;
  checksumVerified: boolean;
  restoredAccounts: number;
  restoredCashboxes: number;
  restoredPeriods: number;
  restoredJournals: number;
  trialBalanceMatched: boolean;
  reconciledCurrencies: readonly string[];
  restoredStore: InMemoryAccountingStore;
}>;

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto SHA-256 is required for backup verification.");
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function exportSignedTenantBackup(
  actor: TenantContext,
  store: AccountingStore,
): Promise<SignedBackupEnvelope> {
  if (!hasPermission(actor.role, "audit.read")) {
    throw new Error(`Permission denied: role "${actor.role}" cannot export backups.`);
  }
  const tenantId = actor.tenantId;
  const payload: BackupPayload = Object.freeze({
    schemaVersion: "2.0.0",
    tenantId,
    exportedAt: new Date().toISOString(),
    exportedBy: actor.userId,
    accounts: store.listAccounts(tenantId),
    cashboxes: store.listCashboxes(tenantId),
    fiscalPeriods: store.listFiscalPeriods(tenantId),
    journals: store.listJournals(tenantId).map((j) => serializeJournal(j)),
    auditLogs: store.listAuditLogs(tenantId),
  });
  const checksumHex = await sha256Hex(JSON.stringify(payload));
  return Object.freeze({ algorithm: "SHA-256", checksumHex, payload });
}

export async function restoreAndVerifyTenantBackup(
  actor: TenantContext,
  envelope: SignedBackupEnvelope,
): Promise<RestoreVerificationReport> {
  if (!hasPermission(actor.role, "settings.manage")) {
    throw new Error(`Permission denied: role "${actor.role}" cannot restore backups.`);
  }
  if (envelope.payload.tenantId !== actor.tenantId) {
    throw new Error("Cross-tenant backup restore blocked.");
  }
  if (envelope.algorithm !== "SHA-256") {
    throw new Error(`Unsupported backup checksum algorithm: ${String(envelope.algorithm)}`);
  }

  const actualChecksum = await sha256Hex(JSON.stringify(envelope.payload));
  if (actualChecksum !== envelope.checksumHex) {
    throw new Error("Backup integrity check failed: SHA-256 checksum mismatch (tampered or corrupted).");
  }

  const { payload } = envelope;
  const tenantId = payload.tenantId;
  const expectedAccounts = new Map(payload.accounts.map((a) => [a.id, a]));
  const expectedEntries = payload.journals.map((rec) => deserializeJournal(rec));
  const expectedTB = buildTrialBalance(expectedEntries, tenantId, expectedAccounts);

  const restoredStore = new InMemoryAccountingStore({
    tenantId,
    accounts: payload.accounts,
    cashboxes: payload.cashboxes,
    fiscalPeriods: payload.fiscalPeriods,
  });

  for (let i = 0; i < expectedEntries.length; i++) {
    const entry = expectedEntries[i];
    restoredStore.savePostedJournal(tenantId, `restore-${entry.id}`, entry, {
      id: `restore-audit-${i + 1}`,
      tenantId,
      userId: actor.userId,
      action: entry.reversalOfId ? "journal.reversed" : "journal.posted",
      entityId: entry.id,
      occurredAt: entry.postedAt ?? entry.createdAt,
      summary: `Restored ${entry.entryNumber}`,
    });
  }

  const restoredAccounts = new Map(restoredStore.listAccounts(tenantId).map((a) => [a.id, a]));
  const restoredTB = buildTrialBalance(restoredStore.listJournals(tenantId), tenantId, restoredAccounts);

  if (restoredTB.totals.length !== expectedTB.totals.length || restoredTB.rows.length !== expectedTB.rows.length) {
    throw new Error("Restore reconciliation failed: trial balance shape mismatch.");
  }
  for (let i = 0; i < expectedTB.totals.length; i++) {
    const exp = expectedTB.totals[i];
    const got = restoredTB.totals[i];
    if (exp.currency !== got.currency || exp.debitMinor !== got.debitMinor || exp.creditMinor !== got.creditMinor || !got.isBalanced) {
      throw new Error(`Restore reconciliation failed for currency ${exp.currency}.`);
    }
  }
  for (let i = 0; i < expectedTB.rows.length; i++) {
    const exp = expectedTB.rows[i];
    const got = restoredTB.rows[i];
    if (
      exp.accountId !== got.accountId || exp.currency !== got.currency ||
      exp.debitMinor !== got.debitMinor || exp.creditMinor !== got.creditMinor ||
      exp.normalBalanceMinor !== got.normalBalanceMinor
    ) {
      throw new Error(`Restore reconciliation failed for account ${exp.accountCode}.`);
    }
  }

  return Object.freeze({
    tenantId,
    checksumVerified: true,
    restoredAccounts: restoredStore.listAccounts(tenantId).length,
    restoredCashboxes: restoredStore.listCashboxes(tenantId).length,
    restoredPeriods: restoredStore.listFiscalPeriods(tenantId).length,
    restoredJournals: restoredStore.listJournals(tenantId).length,
    trialBalanceMatched: true,
    reconciledCurrencies: Object.freeze(restoredTB.totals.map((t) => t.currency)),
    restoredStore,
  });
}
