import { assertDateInOpenPeriod, type FiscalPeriod } from "./finance/fiscal-period";
import { requirePostingAccount, type LedgerAccount } from "./finance/accounts";

export type JournalLine = Readonly<{
  id: string;
  accountId: string;
  description?: string;
  debitMinor: bigint;
  creditMinor: bigint;
  currency: string;
}>;

export type JournalStatus = "draft" | "posted";

export type JournalEntry = Readonly<{
  id: string;
  tenantId: string;
  entryNumber: string;
  memo: string;
  status: JournalStatus;
  businessDate: string;
  occurredAt: string;
  createdAt: string;
  postedAt?: string;
  reversalOfId?: string;
  lines: readonly JournalLine[];
}>;

export type JournalValidationContext = Readonly<{
  accounts?: ReadonlyMap<string, LedgerAccount>;
  fiscalPeriods?: readonly FiscalPeriod[];
}>;

export function validateJournal(entry: JournalEntry, context: JournalValidationContext = {}): void {
  if (!entry.id.trim() || !entry.tenantId.trim()) throw new Error("Journal entry must have an ID and tenant.");
  if (!entry.entryNumber.trim()) throw new Error("Journal entry number is required.");
  if (entry.status !== "draft" && entry.status !== "posted") throw new Error("Journal status is invalid.");
  if (entry.reversalOfId !== undefined && (!entry.reversalOfId.trim() || entry.reversalOfId === entry.id)) throw new Error("Journal reversal reference is invalid.");
  if (entry.lines.length < 2) throw new Error("A journal entry requires at least two lines.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.businessDate) || Number.isNaN(Date.parse(`${entry.businessDate}T00:00:00.000Z`)) || new Date(`${entry.businessDate}T00:00:00.000Z`).toISOString().slice(0, 10) !== entry.businessDate) throw new Error("Journal business date must be a valid YYYY-MM-DD date.");
  if (!Number.isFinite(Date.parse(entry.occurredAt))) throw new Error("Journal timestamp must be valid.");
  if (!Number.isFinite(Date.parse(entry.createdAt))) throw new Error("Journal creation date must be valid.");

  const currencies = new Set(entry.lines.map((line) => line.currency));
  if (currencies.size !== 1) {
    throw new Error("A journal entry must balance within one transaction currency. Use explicit FX legs for conversions.");
  }

  const lineIds = new Set<string>();
  let debits = 0n;
  let credits = 0n;
  for (const line of entry.lines) {
    if (!line.id.trim() || lineIds.has(line.id)) throw new Error("Every journal line must have a unique ID.");
    lineIds.add(line.id);
    if (!line.accountId.trim()) throw new Error("Every journal line requires an account.");
    if (!/^[A-Z]{3}$/.test(line.currency)) throw new Error("Every journal line requires a valid three-letter currency code.");
    if (line.debitMinor < 0n || line.creditMinor < 0n) throw new Error("Debit and credit cannot be negative.");
    if (line.debitMinor.toString().length > 38 || line.creditMinor.toString().length > 38) throw new Error("Journal amount exceeds the 38-digit storage limit.");
    if (line.debitMinor > 0n && line.creditMinor > 0n) throw new Error("A line cannot contain both debit and credit.");
    if (line.debitMinor === 0n && line.creditMinor === 0n) throw new Error("A journal line cannot be zero on both sides.");
    debits += line.debitMinor;
    credits += line.creditMinor;

    if (context.accounts) requirePostingAccount(line.accountId, entry.tenantId, context.accounts);
  }
  if (debits === 0n || debits !== credits) throw new Error("Journal entry is not balanced.");
  if (entry.status === "posted" && !entry.postedAt) throw new Error("A posted journal entry requires a posting timestamp.");
  if (entry.postedAt !== undefined && !Number.isFinite(Date.parse(entry.postedAt))) throw new Error("Journal posting timestamp must be valid.");
  if (entry.status === "draft" && entry.postedAt) throw new Error("A draft journal entry cannot have a posting timestamp.");

  if (context.fiscalPeriods) {
    assertDateInOpenPeriod(entry.businessDate, entry.tenantId, context.fiscalPeriods);
  }
}


/** Clone and freeze every level so a posted journal cannot be mutated through a retained array reference. */
export function freezeJournal(entry: JournalEntry): JournalEntry {
  const lines = Object.freeze(entry.lines.map((line) => Object.freeze({ ...line })));
  return Object.freeze({ ...entry, lines });
}

/** Persistence DTO: serialize BigInt amounts as decimal strings. */
export type JournalLineRecord = Omit<JournalLine, "debitMinor" | "creditMinor"> & {
  debitMinor: string;
  creditMinor: string;
};

export type JournalRecord = Omit<JournalEntry, "lines"> & { lines: JournalLineRecord[] };

export function serializeJournal(entry: JournalEntry): JournalRecord {
  return {
    ...entry,
    lines: entry.lines.map((line) => ({
      ...line,
      debitMinor: line.debitMinor.toString(),
      creditMinor: line.creditMinor.toString(),
    })),
  };
}

export function deserializeJournal(record: JournalRecord): JournalEntry {
  return {
    ...record,
    lines: record.lines.map((line) => {
      if (!/^-?\d+$/.test(line.debitMinor) || !/^-?\d+$/.test(line.creditMinor)) {
        throw new Error("Stored journal amounts must be integer minor-unit strings.");
      }
      return { ...line, debitMinor: BigInt(line.debitMinor), creditMinor: BigInt(line.creditMinor) };
    }),
  };
}
