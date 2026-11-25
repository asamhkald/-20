export const ACCOUNT_TYPES = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type NormalBalance = "debit" | "credit";

export type LedgerAccount = Readonly<{
  id: string;
  tenantId: string;
  code: string;
  name: string;
  type: AccountType;
  normalBalance: NormalBalance;
  isActive: boolean;
  allowPosting: boolean;
}>;

const EXPECTED_NORMAL_BALANCE: Record<AccountType, NormalBalance> = {
  asset: "debit",
  expense: "debit",
  liability: "credit",
  equity: "credit",
  revenue: "credit",
};

export function validateAccount(account: LedgerAccount): void {
  if (!account.id.trim() || !account.tenantId.trim()) {
    throw new Error("Every account must have an ID and tenant.");
  }
  if (!account.code.trim() || !account.name.trim()) {
    throw new Error("Every account must have a code and name.");
  }
  if (!ACCOUNT_TYPES.includes(account.type)) throw new Error("Unsupported account type.");
  if (account.normalBalance !== EXPECTED_NORMAL_BALANCE[account.type]) {
    throw new Error(`The normal balance for ${account.type} accounts must be ${EXPECTED_NORMAL_BALANCE[account.type]}.`);
  }
}

export function requirePostingAccount(
  accountId: string,
  tenantId: string,
  accounts: ReadonlyMap<string, LedgerAccount>,
): LedgerAccount {
  const account = accounts.get(accountId);
  if (!account) throw new Error(`Account ${accountId} does not exist.`);
  validateAccount(account);
  if (account.tenantId !== tenantId) throw new Error("Cross-tenant account access is not allowed.");
  if (!account.isActive || !account.allowPosting) throw new Error(`Account ${account.code} is not open for posting.`);
  return account;
}
