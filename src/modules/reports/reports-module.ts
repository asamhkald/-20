import { STANDARD_ACCOUNT_CODES, type CashboxStatement } from "../../core/finance";
import type { TenantContext } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";

export type IncomeStatementReport = Readonly<{
  currency: string;
  salesRevenueMinor: bigint;
  serviceRevenueMinor: bigint;
  salesReturnsMinor: bigint;
  netRevenueMinor: bigint;
  cogsMinor: bigint;
  grossProfitMinor: bigint;
  operatingExpensesMinor: bigint;
  damagedStockLossMinor: bigint;
  netProfitMinor: bigint;
}>;

export type BalanceSheetReport = Readonly<{
  currency: string;
  totalAssetsMinor: bigint;
  totalLiabilitiesMinor: bigint;
  recordedEquityMinor: bigint;
  currentPeriodNetProfitMinor: bigint;
  totalEquityMinor: bigint;
  isEquationBalanced: boolean;
}>;

export type FinancialStatementsPack = Readonly<{
  tenantId: string;
  currencies: readonly string[];
  incomeStatements: Readonly<Record<string, IncomeStatementReport>>;
  balanceSheets: Readonly<Record<string, BalanceSheetReport>>;
  cashboxStatements: readonly CashboxStatement[];
  allTrialBalancesBalanced: boolean;
}>;

export class FinancialReportsModuleService {
  private readonly accounting: AccountingWorkspaceService;

  constructor(accounting: AccountingWorkspaceService) {
    this.accounting = accounting;
  }

  generateFinancialStatements(actor: TenantContext): FinancialStatementsPack {
    const snap = this.accounting.getSnapshot(actor);
    const accountById = new Map(snap.accounts.map((a) => [a.id, a]));
    const currencies = snap.trialBalance.totals.map((t) => t.currency);

    const incomeStatements: Record<string, IncomeStatementReport> = {};
    const balanceSheets: Record<string, BalanceSheetReport> = {};

    for (const cur of currencies) {
      const rows = snap.trialBalance.rows.filter((r) => r.currency === cur);
      const byCode = new Map(rows.map((r) => [r.accountCode, r.normalBalanceMinor]));

      const salesRevenueMinor = byCode.get(STANDARD_ACCOUNT_CODES.SALES_REVENUE) ?? 0n;
      const serviceRevenueMinor = byCode.get(STANDARD_ACCOUNT_CODES.SERVICE_REVENUE) ?? 0n;
      const salesReturnsMinor = byCode.get(STANDARD_ACCOUNT_CODES.SALES_RETURNS) ?? 0n;
      const netRevenueMinor = salesRevenueMinor + serviceRevenueMinor - salesReturnsMinor;
      const cogsMinor = byCode.get(STANDARD_ACCOUNT_CODES.COGS) ?? 0n;
      const grossProfitMinor = netRevenueMinor - cogsMinor;
      const operatingExpensesMinor = byCode.get(STANDARD_ACCOUNT_CODES.OPERATING_EXPENSE) ?? 0n;
      const damagedStockLossMinor = byCode.get(STANDARD_ACCOUNT_CODES.DAMAGED_STOCK_LOSS) ?? 0n;

      let otherRev = 0n;
      let otherExp = 0n;
      let totalAssetsMinor = 0n;
      let totalLiabilitiesMinor = 0n;
      let recordedEquityMinor = 0n;

      for (const row of rows) {
        const acc = accountById.get(row.accountId);
        if (!acc) continue;
        if (acc.type === "asset") totalAssetsMinor += row.normalBalanceMinor;
        else if (acc.type === "liability") totalLiabilitiesMinor += row.normalBalanceMinor;
        else if (acc.type === "equity") recordedEquityMinor += row.normalBalanceMinor;
        else if (acc.type === "revenue" && acc.code !== STANDARD_ACCOUNT_CODES.SALES_REVENUE && acc.code !== STANDARD_ACCOUNT_CODES.SERVICE_REVENUE) otherRev += row.normalBalanceMinor;
        else if (acc.type === "expense" && acc.code !== STANDARD_ACCOUNT_CODES.SALES_RETURNS && acc.code !== STANDARD_ACCOUNT_CODES.COGS && acc.code !== STANDARD_ACCOUNT_CODES.OPERATING_EXPENSE && acc.code !== STANDARD_ACCOUNT_CODES.DAMAGED_STOCK_LOSS) otherExp += row.normalBalanceMinor;
      }

      const netProfitMinor = grossProfitMinor - operatingExpensesMinor - damagedStockLossMinor + otherRev - otherExp;
      incomeStatements[cur] = Object.freeze({
        currency: cur, salesRevenueMinor, serviceRevenueMinor, salesReturnsMinor,
        netRevenueMinor: netRevenueMinor + otherRev, cogsMinor, grossProfitMinor: grossProfitMinor + otherRev,
        operatingExpensesMinor: operatingExpensesMinor + otherExp, damagedStockLossMinor, netProfitMinor,
      });

      const totalEquityMinor = recordedEquityMinor + netProfitMinor;
      balanceSheets[cur] = Object.freeze({
        currency: cur, totalAssetsMinor, totalLiabilitiesMinor, recordedEquityMinor,
        currentPeriodNetProfitMinor: netProfitMinor, totalEquityMinor,
        isEquationBalanced: totalAssetsMinor === totalLiabilitiesMinor + totalEquityMinor,
      });
    }

    const cashboxStatements = snap.cashboxes.map((cb) => this.accounting.getCashboxStatement(actor, cb.id));
    return Object.freeze({
      tenantId: actor.tenantId,
      currencies: Object.freeze(currencies),
      incomeStatements: Object.freeze(incomeStatements),
      balanceSheets: Object.freeze(balanceSheets),
      cashboxStatements: Object.freeze(cashboxStatements),
      allTrialBalancesBalanced: snap.trialBalance.totals.every((t) => t.isBalanced),
    });
  }
}
