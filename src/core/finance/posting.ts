import { assertDateInOpenPeriod, type FiscalPeriod } from "./fiscal-period";
import { freezeJournal, validateJournal, type JournalEntry, type JournalLine, type JournalValidationContext } from "../journal";
import type { LedgerAccount } from "./accounts";

export type PostingContext = Readonly<{
  tenantId: string;
  accounts: ReadonlyMap<string, LedgerAccount>;
  fiscalPeriods: readonly FiscalPeriod[];
  /** Loaded from the database inside the same transaction used to post. */
  existingReversalOfIds: ReadonlySet<string>;
  /** Original posted entries loaded by the server for validating reversals. */
  reversalTargets: ReadonlyMap<string, JournalEntry>;
}>;

export type ReversalContext = PostingContext;

/** Pure domain use-case. The caller must persist the returned entry atomically on the server. */
export function postJournalDraft(
  draft: JournalEntry,
  postedAt: string,
  context: PostingContext,
): JournalEntry {
  if (draft.status !== "draft") throw new Error("Only draft journal entries can be posted.");
  if (draft.tenantId !== context.tenantId) throw new Error("Journal tenant does not match the authenticated tenant.");
  if (!Number.isFinite(Date.parse(postedAt))) throw new Error("Posting timestamp must be valid.");

  if (draft.reversalOfId) {
    const original = context.reversalTargets.get(draft.reversalOfId);
    if (!original || original.status !== "posted" || original.tenantId !== context.tenantId) {
      throw new Error("A reversal must reference an existing posted journal in the same tenant.");
    }
    validateJournal(original);
    if (context.existingReversalOfIds.has(draft.reversalOfId)) {
      throw new Error("This journal entry already has a recorded reversal.");
    }
  }

  const validation: JournalValidationContext = {
    accounts: context.accounts,
    fiscalPeriods: context.fiscalPeriods,
  };
  validateJournal(draft, validation);
  return freezeJournal({ ...draft, status: "posted", postedAt });
}

/** Create a separate reversing entry. The original posted entry is never mutated. */
export function createReversal(
  original: JournalEntry,
  reversalId: string,
  reversalNumber: string,
  businessDate: string,
  occurredAt: string,
  createdAt: string,
  context: ReversalContext,
): JournalEntry {
  if (original.status !== "posted") throw new Error("Only a posted journal entry can be reversed.");
  if (original.tenantId !== context.tenantId) throw new Error("Journal tenant does not match the authenticated tenant.");
  if (original.reversalOfId) throw new Error("A reversal entry cannot itself be reversed by this operation.");
  if (context.existingReversalOfIds.has(original.id)) throw new Error("This journal entry already has a recorded reversal.");
  if (!reversalId || !reversalNumber) throw new Error("Reversal ID and number are required.");
  validateJournal(original);

  // This pre-check ensures a closed period cannot accept the reversal.
  assertDateInOpenPeriod(businessDate, context.tenantId, context.fiscalPeriods);
  const lines: JournalLine[] = original.lines.map((line, index) => ({
    ...line,
    id: `${reversalId}-line-${index + 1}`,
    debitMinor: line.creditMinor,
    creditMinor: line.debitMinor,
    description: line.description ? `Reversal: ${line.description}` : "Reversal",
  }));

  const reversal: JournalEntry = {
    id: reversalId,
    tenantId: original.tenantId,
    entryNumber: reversalNumber,
    memo: `Reversal of ${original.entryNumber}`,
    status: "draft",
    businessDate,
    occurredAt,
    createdAt,
    reversalOfId: original.id,
    lines,
  };
  validateJournal(reversal, { accounts: context.accounts, fiscalPeriods: context.fiscalPeriods });
  return freezeJournal(reversal);
}
