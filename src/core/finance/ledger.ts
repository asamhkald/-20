import { validateAccount, type LedgerAccount } from "./accounts";
import { validateJournal, type JournalEntry } from "../journal";

export type TrialBalanceRow = Readonly<{
  accountId: string;
  accountCode: string;
  accountName: string;
  currency: string;
  debitMinor: bigint;
  creditMinor: bigint;
  /** Positive means the account's normal side; negative means an abnormal balance. */
  normalBalanceMinor: bigint;
}>;

export type TrialBalanceTotal = Readonly<{
  currency: string;
  debitMinor: bigint;
  creditMinor: bigint;
  isBalanced: boolean;
}>;

export type TrialBalance = Readonly<{
  tenantId: string;
  rows: readonly TrialBalanceRow[];
  totals: readonly TrialBalanceTotal[];
}>;

/** Build a trial balance from posted journal lines, keeping each currency separate. */
export function buildTrialBalance(
  entries: readonly JournalEntry[],
  tenantId: string,
  accounts: ReadonlyMap<string, LedgerAccount>,
): TrialBalance {
  if (!tenantId.trim()) throw new Error("A tenant is required to build a trial balance.");

  const balances = new Map<string, { account: LedgerAccount; currency: string; debit: bigint; credit: bigint }>();
  const totals = new Map<string, { debit: bigint; credit: bigint }>();

  for (const entry of entries) {
    if (entry.tenantId !== tenantId) throw new Error("Cross-tenant journal data is not allowed in a trial balance.");
    if (entry.status !== "posted") continue;
    validateJournal(entry);

    for (const line of entry.lines) {
      const account = accounts.get(line.accountId);
      if (!account) throw new Error(`Account ${line.accountId} does not exist.`);
      validateAccount(account);
      if (account.tenantId !== tenantId) throw new Error("Cross-tenant account access is not allowed.");

      const key = `${account.id}::${line.currency}`;
      const current = balances.get(key) ?? { account, currency: line.currency, debit: 0n, credit: 0n };
      current.debit += line.debitMinor;
      current.credit += line.creditMinor;
      balances.set(key, current);

      const total = totals.get(line.currency) ?? { debit: 0n, credit: 0n };
      total.debit += line.debitMinor;
      total.credit += line.creditMinor;
      totals.set(line.currency, total);
    }
  }

  const rows: TrialBalanceRow[] = [...balances.values()]
    .sort((a, b) => a.account.code.localeCompare(b.account.code) || a.currency.localeCompare(b.currency))
    .map(({ account, currency, debit, credit }) => ({
      accountId: account.id,
      accountCode: account.code,
      accountName: account.name,
      currency,
      debitMinor: debit,
      creditMinor: credit,
      normalBalanceMinor: account.normalBalance === "debit" ? debit - credit : credit - debit,
    }));

  const totalRows: TrialBalanceTotal[] = [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({
      currency,
      debitMinor: amount.debit,
      creditMinor: amount.credit,
      isBalanced: amount.debit === amount.credit,
    }));

  return Object.freeze({ tenantId, rows: Object.freeze(rows), totals: Object.freeze(totalRows) });
}
