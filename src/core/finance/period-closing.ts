import { validateAccount, type LedgerAccount } from "./accounts";
import { validateFiscalPeriod, type FiscalPeriod } from "./fiscal-period";
import { buildTrialBalance } from "./ledger";
import type { JournalEntry } from "../journal";

export type CurrencyClosingResult = Readonly<{
  currency: string;
  revenueMinor: bigint;
  expenseMinor: bigint;
  netIncomeMinor: bigint;
  isTrialBalanceBalanced: boolean;
}>;

export type PeriodClosingSummary = Readonly<{
  periodId: string;
  tenantId: string;
  startsOn: string;
  endsOn: string;
  closedAt: string;
  closedBy: string;
  postedEntryCount: number;
  currencies: readonly CurrencyClosingResult[];
}>;

export type ClosePeriodOutcome = Readonly<{
  closedPeriod: FiscalPeriod;
  summary: PeriodClosingSummary;
}>;

export function closeFiscalPeriod(
  period: FiscalPeriod,
  entries: readonly JournalEntry[],
  accounts: ReadonlyMap<string, LedgerAccount>,
  closedAt: string,
  closedBy: string,
): ClosePeriodOutcome {
  validateFiscalPeriod(period);
  if (period.status === "closed") {
    throw new Error(`Fiscal period ${period.id} is already closed.`);
  }
  if (!Number.isFinite(Date.parse(closedAt))) {
    throw new Error("Closing timestamp must be a valid ISO date.");
  }
  if (!closedBy.trim()) {
    throw new Error("Closing user ID is required.");
  }

  const periodEntries = entries.filter(
    (entry) =>
      entry.tenantId === period.tenantId &&
      entry.status === "posted" &&
      entry.businessDate >= period.startsOn &&
      entry.businessDate <= period.endsOn,
  );

  const trialBalance = buildTrialBalance(periodEntries, period.tenantId, accounts);
  for (const total of trialBalance.totals) {
    if (!total.isBalanced) {
      throw new Error(`Cannot close period ${period.id}: ${total.currency} trial balance is not balanced.`);
    }
  }

  const byCurrency = new Map<string, { revenue: bigint; expense: bigint }>();
  for (const row of trialBalance.rows) {
    const account = accounts.get(row.accountId);
    if (!account) throw new Error(`Account ${row.accountId} missing during closing.`);
    validateAccount(account);

    const bucket = byCurrency.get(row.currency) ?? { revenue: 0n, expense: 0n };
    if (account.type === "revenue") {
      bucket.revenue += row.normalBalanceMinor;
    } else if (account.type === "expense") {
      bucket.expense += row.normalBalanceMinor;
    }
    byCurrency.set(row.currency, bucket);
  }

  const currencies: CurrencyClosingResult[] = trialBalance.totals.map((total) => {
    const bucket = byCurrency.get(total.currency) ?? { revenue: 0n, expense: 0n };
    return Object.freeze({
      currency: total.currency,
      revenueMinor: bucket.revenue,
      expenseMinor: bucket.expense,
      netIncomeMinor: bucket.revenue - bucket.expense,
      isTrialBalanceBalanced: total.isBalanced,
    });
  });

  const closedPeriod: FiscalPeriod = Object.freeze({ ...period, status: "closed" });
  const summary: PeriodClosingSummary = Object.freeze({
    periodId: period.id,
    tenantId: period.tenantId,
    startsOn: period.startsOn,
    endsOn: period.endsOn,
    closedAt,
    closedBy: closedBy.trim(),
    postedEntryCount: periodEntries.length,
    currencies: Object.freeze(currencies),
  });

  return Object.freeze({ closedPeriod, summary });
}

export function openNextFiscalPeriod(
  existingPeriods: readonly FiscalPeriod[],
  nextPeriod: FiscalPeriod,
): readonly FiscalPeriod[] {
  validateFiscalPeriod(nextPeriod);
  if (nextPeriod.status !== "open") {
    throw new Error("A newly opened fiscal period must have status 'open'.");
  }
  for (const p of existingPeriods) {
    validateFiscalPeriod(p);
    if (p.tenantId !== nextPeriod.tenantId) continue;
    if (p.id === nextPeriod.id) {
      throw new Error(`Fiscal period ID ${nextPeriod.id} already exists.`);
    }
    const overlaps = !(nextPeriod.endsOn < p.startsOn || nextPeriod.startsOn > p.endsOn);
    if (overlaps) {
      throw new Error(`Fiscal period ${nextPeriod.id} overlaps with existing period ${p.id}.`);
    }
  }
  return Object.freeze([...existingPeriods, Object.freeze({ ...nextPeriod })]);
}
