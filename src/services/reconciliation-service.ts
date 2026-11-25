import { STANDARD_ACCOUNT_CODES } from "../core/finance";
import type { TenantContext } from "../core/tenant";
import type { AccountingWorkspaceService } from "./accounting-service";

export type LegacyCurrencyBalanceSnapshot = Readonly<{
  currency: "USD" | "SYP"; cashBalanceMinor: bigint; receivablesBalanceMinor: bigint; payablesBalanceMinor: bigint;
}>;

export type CurrencyReconciliationLine = Readonly<{
  currency: "USD" | "SYP"; cashLegacyMinor: bigint; cashNewMinor: bigint; cashVarianceMinor: bigint;
  arLegacyMinor: bigint; arNewMinor: bigint; arVarianceMinor: bigint;
  apLegacyMinor: bigint; apNewMinor: bigint; apVarianceMinor: bigint; isMatched: boolean;
}>;

export type MigrationReconciliationReport = Readonly<{
  tenantId: string; checkedAt: string; lines: readonly CurrencyReconciliationLine[];
  allMatched: boolean; approvedForCutover: boolean;
}>;

export function reconcileLegacyWithNewLedger(
  actor: TenantContext, accounting: AccountingWorkspaceService, legacySnapshots: readonly LegacyCurrencyBalanceSnapshot[],
): MigrationReconciliationReport {
  if (legacySnapshots.length === 0) throw new Error("At least one legacy snapshot is required.");
  const snap = accounting.getSnapshot(actor);
  const lines: CurrencyReconciliationLine[] = legacySnapshots.map((leg) => {
    const cashNew = snap.cashboxes.filter((c) => c.currency === leg.currency).reduce((s, c) => s + accounting.getCashboxStatement(actor, c.id).currentBalanceMinor, 0n);
    const byCode = new Map(snap.trialBalance.rows.filter((r) => r.currency === leg.currency).map((r) => [r.accountCode, r.normalBalanceMinor]));
    const arNew = byCode.get(STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE) ?? 0n;
    const apNew = byCode.get(STANDARD_ACCOUNT_CODES.ACCOUNTS_PAYABLE) ?? 0n;
    const cashVar = cashNew - leg.cashBalanceMinor, arVar = arNew - leg.receivablesBalanceMinor, apVar = apNew - leg.payablesBalanceMinor;
    return Object.freeze({
      currency: leg.currency, cashLegacyMinor: leg.cashBalanceMinor, cashNewMinor: cashNew, cashVarianceMinor: cashVar,
      arLegacyMinor: leg.receivablesBalanceMinor, arNewMinor: arNew, arVarianceMinor: arVar,
      apLegacyMinor: leg.payablesBalanceMinor, apNewMinor: apNew, apVarianceMinor: apVar,
      isMatched: cashVar === 0n && arVar === 0n && apVar === 0n,
    });
  });
  const allMatched = lines.every((l) => l.isMatched);
  return Object.freeze({ tenantId: actor.tenantId, checkedAt: new Date().toISOString(), lines: Object.freeze(lines), allMatched, approvedForCutover: allMatched && snap.trialBalance.totals.every((t) => t.isBalanced) });
}
