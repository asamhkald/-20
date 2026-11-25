import { validateAccount, type AccountType, type LedgerAccount, type NormalBalance } from "./accounts";

export const STANDARD_ACCOUNT_CODES = Object.freeze({
  CASH_USD: "1010",
  CASH_SYP: "1011",
  WALLET_PRIMARY: "1020",
  ACCOUNTS_RECEIVABLE: "1200",
  INVENTORY: "1300",
  TELECOM_WALLETS: "1400",
  FX_CLEARING: "1999",
  ACCOUNTS_PAYABLE: "2100",
  OWNER_EQUITY: "3000",
  RETAINED_EARNINGS: "3100",
  SALES_REVENUE: "4000",
  SERVICE_REVENUE: "4100",
  COGS: "5000",
  OPERATING_EXPENSE: "5100",
  DAMAGED_STOCK_LOSS: "5200",
  SALES_RETURNS: "5400",
} as const);

type SeedAccountSpec = Readonly<{
  idSuffix: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
}>;

const DEFAULT_CHART_SPECS: readonly SeedAccountSpec[] = Object.freeze([
  { idSuffix: "cash-usd", code: STANDARD_ACCOUNT_CODES.CASH_USD, name: "صندوق الدولار · Cash Box (USD)", type: "asset", normalBalance: "debit" },
  { idSuffix: "cash-syp", code: STANDARD_ACCOUNT_CODES.CASH_SYP, name: "صندوق الليرة السورية · Cash Box (SYP)", type: "asset", normalBalance: "debit" },
  { idSuffix: "wallet-main", code: STANDARD_ACCOUNT_CODES.WALLET_PRIMARY, name: "صندوق المحفظة الإلكترونية · E-Wallet", type: "asset", normalBalance: "debit" },
  { idSuffix: "ar", code: STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, name: "ذمم العملاء · Accounts Receivable", type: "asset", normalBalance: "debit" },
  { idSuffix: "inv", code: STANDARD_ACCOUNT_CODES.INVENTORY, name: "المخزون السلعي · Inventory", type: "asset", normalBalance: "debit" },
  { idSuffix: "telecom-wallets", code: STANDARD_ACCOUNT_CODES.TELECOM_WALLETS, name: "محافظ رصيد الاتصالات · Telecom Wallets", type: "asset", normalBalance: "debit" },
  { idSuffix: "fx-clear", code: STANDARD_ACCOUNT_CODES.FX_CLEARING, name: "حساب تسوية الصرف · FX Clearing", type: "asset", normalBalance: "debit" },
  { idSuffix: "ap", code: STANDARD_ACCOUNT_CODES.ACCOUNTS_PAYABLE, name: "ذمم الموردين · Accounts Payable", type: "liability", normalBalance: "credit" },
  { idSuffix: "equity", code: STANDARD_ACCOUNT_CODES.OWNER_EQUITY, name: "رأس المال والأرصدة الافتتاحية · Owner Equity", type: "equity", normalBalance: "credit" },
  { idSuffix: "retained", code: STANDARD_ACCOUNT_CODES.RETAINED_EARNINGS, name: "الأرباح المبقاة · Retained Earnings", type: "equity", normalBalance: "credit" },
  { idSuffix: "rev-sales", code: STANDARD_ACCOUNT_CODES.SALES_REVENUE, name: "إيرادات المبيعات · Sales Revenue", type: "revenue", normalBalance: "credit" },
  { idSuffix: "rev-service", code: STANDARD_ACCOUNT_CODES.SERVICE_REVENUE, name: "إيرادات الصيانة والخدمات · Service Revenue", type: "revenue", normalBalance: "credit" },
  { idSuffix: "cogs", code: STANDARD_ACCOUNT_CODES.COGS, name: "تكلفة البضاعة المباعة · COGS", type: "expense", normalBalance: "debit" },
  { idSuffix: "opex", code: STANDARD_ACCOUNT_CODES.OPERATING_EXPENSE, name: "المصروفات التشغيلية · Operating Expenses", type: "expense", normalBalance: "debit" },
  { idSuffix: "damage", code: STANDARD_ACCOUNT_CODES.DAMAGED_STOCK_LOSS, name: "خسائر التالف والهالك · Damaged Stock Loss", type: "expense", normalBalance: "debit" },
  { idSuffix: "returns", code: STANDARD_ACCOUNT_CODES.SALES_RETURNS, name: "مردودات المبيعات · Sales Returns", type: "expense", normalBalance: "debit" },
]);

export function createStandardChartOfAccounts(tenantId: string): readonly LedgerAccount[] {
  const cleanTenant = tenantId.trim();
  if (!cleanTenant) throw new Error("Tenant ID is required to build a chart of accounts.");

  const list = DEFAULT_CHART_SPECS.map((spec) => {
    const account: LedgerAccount = Object.freeze({
      id: `acc-${spec.idSuffix}`,
      tenantId: cleanTenant,
      code: spec.code,
      name: spec.name,
      type: spec.type,
      normalBalance: spec.normalBalance,
      isActive: true,
      allowPosting: true,
    });
    validateAccount(account);
    return account;
  });
  return Object.freeze(list);
}

export function createCashboxLedgerAccount(input: {
  id: string;
  tenantId: string;
  code: string;
  name: string;
}): LedgerAccount {
  const account: LedgerAccount = Object.freeze({
    id: input.id.trim(),
    tenantId: input.tenantId.trim(),
    code: input.code.trim(),
    name: input.name.trim(),
    type: "asset",
    normalBalance: "debit",
    isActive: true,
    allowPosting: true,
  });
  validateAccount(account);
  return account;
}
