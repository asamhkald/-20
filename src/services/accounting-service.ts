import { generateHiddenUuid } from "../core/enterprise";
import {
  buildTrialBalance,
  closeFiscalPeriod,
  computeCashboxStatement,
  convertMoneyExact,
  createCashboxLedgerAccount,
  createReversal,
  createStandardChartOfAccounts,
  openNextFiscalPeriod,
  postJournalDraft,
  STANDARD_ACCOUNT_CODES,
  validateCashbox,
  type Cashbox,
  type CashboxKind,
  type CashboxStatement,
  type ClosePeriodOutcome,
  type FiscalPeriod,
  type FxRateQuote,
  type LedgerAccount,
  type PostingContext,
  type TrialBalance,
} from "../core/finance";
import type { JournalEntry, JournalLine } from "../core/journal";
import { moneyToDecimalString, parseMoney, type CurrencyDefinition } from "../core/money";
import { hasPermission, type Permission } from "../core/permissions";
import type { TenantContext } from "../core/tenant";
import { InMemoryAccountingStore, type AccountingStore, type AuditRecord } from "../storage";

export const SUPPORTED_CURRENCIES: Readonly<Record<string, CurrencyDefinition>> = Object.freeze({
  USD: Object.freeze({ code: "USD", decimalPlaces: 2 }),
  SYP: Object.freeze({ code: "SYP", decimalPlaces: 2 }),
});

function assertPermission(actor: TenantContext, permission: Permission): void {
  if (!hasPermission(actor.role, permission)) {
    throw new Error(`Permission denied: role "${actor.role}" lacks "${permission}".`);
  }
}

export type CashSaleWithCogsInput = Readonly<{
  idempotencyKey: string;
  businessDate: string;
  currency: "USD" | "SYP";
  cashboxId?: string;
  saleAmountText: string;
  costAmountText?: string;
  memo: string;
}>;

export type CreditSaleInput = Readonly<{
  idempotencyKey: string;
  businessDate: string;
  currency: "USD" | "SYP";
  customerName: string;
  saleAmountText: string;
  costAmountText?: string;
  memo?: string;
}>;

export type CashMovementInput = Readonly<{
  idempotencyKey: string;
  businessDate: string;
  cashboxId: string;
  amountText: string;
  memo: string;
  allowNegativeBalance?: boolean;
}>;

export type CashboxTransferInput = Readonly<{
  idempotencyKey: string;
  businessDate: string;
  fromCashboxId: string;
  toCashboxId: string;
  amountText: string;
  memo?: string;
  fxQuote?: FxRateQuote;
  allowNegativeBalance?: boolean;
}>;

export type RegisterCashboxInput = Readonly<{
  id?: string;
  branchId?: string;
  code: string;
  ledgerCode: string;
  name: string;
  kind: CashboxKind;
  currency: "USD" | "SYP";
}>;

export type WorkspaceSnapshot = Readonly<{
  accounts: readonly LedgerAccount[];
  cashboxes: readonly Cashbox[];
  fiscalPeriods: readonly FiscalPeriod[];
  entries: readonly JournalEntry[];
  reversedIds: ReadonlySet<string>;
  trialBalance: TrialBalance;
  auditLogs: readonly AuditRecord[];
  storageKind: AccountingStore["kind"];
}>;

export class AccountingWorkspaceService {
  private readonly store: AccountingStore;

  constructor(store: AccountingStore) {
    this.store = store;
  }

  private buildContext(tenantId: string): PostingContext {
    const accountsList = this.store.listAccounts(tenantId);
    const accounts = new Map<string, LedgerAccount>(accountsList.map((a) => [a.id, a]));
    const fiscalPeriods = this.store.listFiscalPeriods(tenantId);
    const journals = this.store.listJournals(tenantId);

    const existingReversalOfIds = new Set<string>();
    const reversalTargets = new Map<string, JournalEntry>();
    for (const entry of journals) {
      if (entry.reversalOfId) existingReversalOfIds.add(entry.reversalOfId);
      if (entry.status === "posted") reversalTargets.set(entry.id, entry);
    }

    return Object.freeze({ tenantId, accounts, fiscalPeriods, existingReversalOfIds, reversalTargets });
  }

  private findAccountByCode(context: PostingContext, code: string): string {
    const found = [...context.accounts.values()].find((a) => a.code === code);
    if (!found) throw new Error(`Required ledger account ${code} is missing.`);
    return found.id;
  }

  private getCurrencyDef(code: string): CurrencyDefinition {
    const def = SUPPORTED_CURRENCIES[code.toUpperCase()];
    if (!def) throw new Error(`Unsupported currency: ${code}`);
    return def;
  }

  private resolveCashbox(tenantId: string, cashboxId: string): Cashbox {
    const cashbox = this.store.listCashboxes(tenantId).find((c) => c.id === cashboxId);
    if (!cashbox) throw new Error(`Cashbox ${cashboxId} was not found.`);
    if (!cashbox.isActive) throw new Error(`Cashbox ${cashbox.code} is inactive.`);
    return cashbox;
  }

  private resolveDefaultCashAccount(tenantId: string, currency: "USD" | "SYP", cashboxId?: string): string {
    if (cashboxId) {
      const box = this.resolveCashbox(tenantId, cashboxId);
      if (box.currency !== currency) {
        throw new Error(`Cashbox ${box.code} (${box.currency}) does not match transaction currency ${currency}.`);
      }
      return box.ledgerAccountId;
    }
    const matchingBox = this.store.listCashboxes(tenantId).find((c) => c.isActive && c.currency === currency && c.kind === "cash");
    if (matchingBox) return matchingBox.ledgerAccountId;
    const context = this.buildContext(tenantId);
    const code = currency === "SYP"
      ? ([...context.accounts.values()].some((a) => a.code === STANDARD_ACCOUNT_CODES.CASH_SYP)
          ? STANDARD_ACCOUNT_CODES.CASH_SYP
          : STANDARD_ACCOUNT_CODES.CASH_USD)
      : STANDARD_ACCOUNT_CODES.CASH_USD;
    return this.findAccountByCode(context, code);
  }

  private assertSufficientCashboxBalance(cashbox: Cashbox, outgoingMinor: bigint, allowNegative?: boolean): void {
    if (allowNegative) return;
    const statement = computeCashboxStatement(cashbox, this.store.listJournals(cashbox.tenantId));
    if (statement.currentBalanceMinor < outgoingMinor) {
      throw new Error(`Insufficient balance in cashbox ${cashbox.code}.`);
    }
  }

  getSnapshot(actor: TenantContext): WorkspaceSnapshot {
    assertPermission(actor, "finance.read");
    const accounts = this.store.listAccounts(actor.tenantId);
    const accountMap = new Map<string, LedgerAccount>(accounts.map((a) => [a.id, a]));
    const entries = this.store.listJournals(actor.tenantId);
    const reversedIds = new Set<string>(entries.map((e) => e.reversalOfId).filter((id): id is string => Boolean(id)));
    const trialBalance = buildTrialBalance(entries, actor.tenantId, accountMap);
    return Object.freeze({
      accounts,
      cashboxes: this.store.listCashboxes(actor.tenantId),
      fiscalPeriods: this.store.listFiscalPeriods(actor.tenantId),
      entries,
      reversedIds,
      trialBalance,
      auditLogs: this.store.listAuditLogs(actor.tenantId),
      storageKind: this.store.kind,
    });
  }

  registerCashbox(actor: TenantContext, input: RegisterCashboxInput): Cashbox {
    assertPermission(actor, "settings.manage");
    const currencyDef = this.getCurrencyDef(input.currency);
    const ledgerAccount = createCashboxLedgerAccount({
      id: `acc-cb-${input.ledgerCode.trim()}`,
      tenantId: actor.tenantId,
      code: input.ledgerCode,
      name: input.name,
    });
    this.store.saveAccount(actor.tenantId, ledgerAccount);

    const accountsMap = new Map(this.store.listAccounts(actor.tenantId).map((a) => [a.id, a]));
    const cashbox: Cashbox = Object.freeze({
      id: input.id?.trim() || generateHiddenUuid(),
      tenantId: actor.tenantId,
      branchId: input.branchId?.trim() || undefined,
      code: input.code.trim().toUpperCase(),
      name: input.name.trim(),
      kind: input.kind,
      currency: currencyDef.code,
      ledgerAccountId: ledgerAccount.id,
      isActive: true,
    });
    validateCashbox(cashbox, accountsMap);
    this.store.saveCashbox(actor.tenantId, cashbox);
    return cashbox;
  }

  getCashboxStatement(actor: TenantContext, cashboxId: string): CashboxStatement {
    assertPermission(actor, "finance.read");
    const cashbox = this.resolveCashbox(actor.tenantId, cashboxId);
    return computeCashboxStatement(cashbox, this.store.listJournals(actor.tenantId));
  }

  postOpeningBalance(actor: TenantContext, input: CashMovementInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const cashbox = this.resolveCashbox(actor.tenantId, input.cashboxId);
    const currencyDef = this.getCurrencyDef(cashbox.currency);
    const money = parseMoney(input.amountText, currencyDef);
    if (money.amountMinor <= 0n) throw new Error("Opening balance must be greater than zero.");

    const context = this.buildContext(actor.tenantId);
    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `OB-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const posted = postJournalDraft(
      {
        id: entryId, tenantId: actor.tenantId, entryNumber,
        memo: input.memo.trim() || `Opening balance — ${cashbox.name}`,
        status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
        lines: [
          { id: `${entryId}-l1`, accountId: cashbox.ledgerAccountId, description: "Opening balance", debitMinor: money.amountMinor, creditMinor: 0n, currency: currencyDef.code },
          { id: `${entryId}-l2`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.OWNER_EQUITY), description: "Owner opening equity", debitMinor: 0n, creditMinor: money.amountMinor, currency: currencyDef.code },
        ],
      },
      nowIso, context,
    );

    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.posted", entityId: posted.id, occurredAt: nowIso,
      summary: `${posted.entryNumber}: Opening balance ${moneyToDecimalString(money, currencyDef.decimalPlaces)} ${currencyDef.code}`,
    });
    return posted;
  }

  postCashSale(actor: TenantContext, input: CashSaleWithCogsInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const currencyDef = this.getCurrencyDef(input.currency);
    const saleMoney = parseMoney(input.saleAmountText, currencyDef);
    if (saleMoney.amountMinor <= 0n) throw new Error("Sale amount must be greater than zero.");

    const costText = (input.costAmountText ?? "").trim();
    const costMoney = costText ? parseMoney(costText, currencyDef) : null;
    if (costMoney && costMoney.amountMinor < 0n) throw new Error("Cost amount cannot be negative.");

    const context = this.buildContext(actor.tenantId);
    const cashAccountId = this.resolveDefaultCashAccount(actor.tenantId, input.currency, input.cashboxId);

    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `JE-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const lines: JournalLine[] = [
      { id: `${entryId}-l1`, accountId: cashAccountId, description: "Cash received", debitMinor: saleMoney.amountMinor, creditMinor: 0n, currency: currencyDef.code },
      { id: `${entryId}-l2`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.SALES_REVENUE), description: "Sales revenue", debitMinor: 0n, creditMinor: saleMoney.amountMinor, currency: currencyDef.code },
    ];
    if (costMoney && costMoney.amountMinor > 0n) {
      lines.push(
        { id: `${entryId}-l3`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.COGS), description: "Cost of goods sold", debitMinor: costMoney.amountMinor, creditMinor: 0n, currency: currencyDef.code },
        { id: `${entryId}-l4`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.INVENTORY), description: "Inventory reduction", debitMinor: 0n, creditMinor: costMoney.amountMinor, currency: currencyDef.code },
      );
    }

    const posted = postJournalDraft(
      { id: entryId, tenantId: actor.tenantId, entryNumber, memo: input.memo.trim() || "Cash sale", status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso, lines },
      nowIso, context,
    );

    const formattedSale = `${moneyToDecimalString(saleMoney, currencyDef.decimalPlaces)} ${currencyDef.code}`;
    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.posted", entityId: posted.id, occurredAt: nowIso,
      summary: `${posted.entryNumber}: ${posted.memo} (${formattedSale})`,
    });
    return posted;
  }

  postCreditSale(actor: TenantContext, input: CreditSaleInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    if (!input.customerName.trim()) throw new Error("Customer name is required for credit sales.");
    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const currencyDef = this.getCurrencyDef(input.currency);
    const saleMoney = parseMoney(input.saleAmountText, currencyDef);
    if (saleMoney.amountMinor <= 0n) throw new Error("Sale amount must be greater than zero.");

    const costText = (input.costAmountText ?? "").trim();
    const costMoney = costText ? parseMoney(costText, currencyDef) : null;
    if (costMoney && costMoney.amountMinor < 0n) throw new Error("Cost amount cannot be negative.");

    const context = this.buildContext(actor.tenantId);
    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `CS-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const lines: JournalLine[] = [
      { id: `${entryId}-l1`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE), description: `Receivable: ${input.customerName.trim()}`, debitMinor: saleMoney.amountMinor, creditMinor: 0n, currency: currencyDef.code },
      { id: `${entryId}-l2`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.SALES_REVENUE), description: "Credit sales revenue", debitMinor: 0n, creditMinor: saleMoney.amountMinor, currency: currencyDef.code },
    ];
    if (costMoney && costMoney.amountMinor > 0n) {
      lines.push(
        { id: `${entryId}-l3`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.COGS), description: "Cost of goods sold", debitMinor: costMoney.amountMinor, creditMinor: 0n, currency: currencyDef.code },
        { id: `${entryId}-l4`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.INVENTORY), description: "Inventory reduction", debitMinor: 0n, creditMinor: costMoney.amountMinor, currency: currencyDef.code },
      );
    }

    const posted = postJournalDraft(
      { id: entryId, tenantId: actor.tenantId, entryNumber, memo: input.memo?.trim() || `Credit sale — ${input.customerName.trim()}`, status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso, lines },
      nowIso, context,
    );

    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.posted", entityId: posted.id, occurredAt: nowIso,
      summary: `${posted.entryNumber}: ${posted.memo}`,
    });
    return posted;
  }

  postCashExpense(actor: TenantContext, input: CashMovementInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const cashbox = this.resolveCashbox(actor.tenantId, input.cashboxId);
    const currencyDef = this.getCurrencyDef(cashbox.currency);
    const money = parseMoney(input.amountText, currencyDef);
    if (money.amountMinor <= 0n) throw new Error("Expense amount must be greater than zero.");
    this.assertSufficientCashboxBalance(cashbox, money.amountMinor, input.allowNegativeBalance);

    const context = this.buildContext(actor.tenantId);
    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `EX-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const posted = postJournalDraft(
      {
        id: entryId, tenantId: actor.tenantId, entryNumber,
        memo: input.memo.trim() || "Operating expense",
        status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
        lines: [
          { id: `${entryId}-l1`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.OPERATING_EXPENSE), description: input.memo.trim() || "Expense", debitMinor: money.amountMinor, creditMinor: 0n, currency: currencyDef.code },
          { id: `${entryId}-l2`, accountId: cashbox.ledgerAccountId, description: `Paid from ${cashbox.code}`, debitMinor: 0n, creditMinor: money.amountMinor, currency: currencyDef.code },
        ],
      },
      nowIso, context,
    );

    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.posted", entityId: posted.id, occurredAt: nowIso,
      summary: `${posted.entryNumber}: Expense ${moneyToDecimalString(money, currencyDef.decimalPlaces)} ${currencyDef.code}`,
    });
    return posted;
  }

  postCustomerDebtCollection(actor: TenantContext, input: CashMovementInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const cashbox = this.resolveCashbox(actor.tenantId, input.cashboxId);
    const currencyDef = this.getCurrencyDef(cashbox.currency);
    const money = parseMoney(input.amountText, currencyDef);
    if (money.amountMinor <= 0n) throw new Error("Collection amount must be greater than zero.");

    const context = this.buildContext(actor.tenantId);
    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `RC-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const posted = postJournalDraft(
      {
        id: entryId, tenantId: actor.tenantId, entryNumber,
        memo: input.memo.trim() || "Customer debt collection",
        status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
        lines: [
          { id: `${entryId}-l1`, accountId: cashbox.ledgerAccountId, description: "Cash collected", debitMinor: money.amountMinor, creditMinor: 0n, currency: currencyDef.code },
          { id: `${entryId}-l2`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE), description: "AR settled", debitMinor: 0n, creditMinor: money.amountMinor, currency: currencyDef.code },
        ],
      },
      nowIso, context,
    );

    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.posted", entityId: posted.id, occurredAt: nowIso,
      summary: `${posted.entryNumber}: Debt collection ${moneyToDecimalString(money, currencyDef.decimalPlaces)} ${currencyDef.code}`,
    });
    return posted;
  }

  postSupplierDebtPayment(actor: TenantContext, input: CashMovementInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const cashbox = this.resolveCashbox(actor.tenantId, input.cashboxId);
    const currencyDef = this.getCurrencyDef(cashbox.currency);
    const money = parseMoney(input.amountText, currencyDef);
    if (money.amountMinor <= 0n) throw new Error("Supplier payment amount must be greater than zero.");
    this.assertSufficientCashboxBalance(cashbox, money.amountMinor, input.allowNegativeBalance);

    const context = this.buildContext(actor.tenantId);
    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `SP-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const posted = postJournalDraft(
      {
        id: entryId, tenantId: actor.tenantId, entryNumber,
        memo: input.memo.trim() || "Supplier debt payment",
        status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
        lines: [
          { id: `${entryId}-l1`, accountId: this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.ACCOUNTS_PAYABLE), description: "AP settled", debitMinor: money.amountMinor, creditMinor: 0n, currency: currencyDef.code },
          { id: `${entryId}-l2`, accountId: cashbox.ledgerAccountId, description: `Paid from ${cashbox.code}`, debitMinor: 0n, creditMinor: money.amountMinor, currency: currencyDef.code },
        ],
      },
      nowIso, context,
    );

    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.posted", entityId: posted.id, occurredAt: nowIso,
      summary: `${posted.entryNumber}: Supplier payment ${moneyToDecimalString(money, currencyDef.decimalPlaces)} ${currencyDef.code}`,
    });
    return posted;
  }

  transferBetweenCashboxes(actor: TenantContext, input: CashboxTransferInput): readonly JournalEntry[] {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existingBatch = this.store.findJournalBatchByIdempotencyKey(actor.tenantId, cleanKey);
    if (existingBatch) return existingBatch;

    if (input.fromCashboxId === input.toCashboxId) {
      throw new Error("Source and destination cashboxes must be different.");
    }

    const fromBox = this.resolveCashbox(actor.tenantId, input.fromCashboxId);
    const toBox = this.resolveCashbox(actor.tenantId, input.toCashboxId);
    const fromDef = this.getCurrencyDef(fromBox.currency);
    const toDef = this.getCurrencyDef(toBox.currency);
    const fromMoney = parseMoney(input.amountText, fromDef);
    if (fromMoney.amountMinor <= 0n) throw new Error("Transfer amount must be greater than zero.");

    this.assertSufficientCashboxBalance(fromBox, fromMoney.amountMinor, input.allowNegativeBalance);

    const context = this.buildContext(actor.tenantId);
    const nowIso = new Date().toISOString();
    const baseSeq = this.store.listJournals(actor.tenantId).length;

    if (fromBox.currency === toBox.currency) {
      const entryId = generateHiddenUuid();
      const entryNumber = `TR-${String(baseSeq + 1).padStart(4, "0")}`;
      const posted = postJournalDraft(
        {
          id: entryId, tenantId: actor.tenantId, entryNumber,
          memo: input.memo?.trim() || `Transfer ${fromBox.code} -> ${toBox.code}`,
          status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
          lines: [
            { id: `${entryId}-l1`, accountId: toBox.ledgerAccountId, description: `In from ${fromBox.code}`, debitMinor: fromMoney.amountMinor, creditMinor: 0n, currency: fromDef.code },
            { id: `${entryId}-l2`, accountId: fromBox.ledgerAccountId, description: `Out to ${toBox.code}`, debitMinor: 0n, creditMinor: fromMoney.amountMinor, currency: fromDef.code },
          ],
        },
        nowIso, context,
      );

      this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
        id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
        action: "cashbox.transfer", entityId: posted.id, occurredAt: nowIso,
        summary: `${posted.entryNumber}: ${fromBox.code} -> ${toBox.code} (${moneyToDecimalString(fromMoney, fromDef.decimalPlaces)} ${fromDef.code})`,
      });
      return Object.freeze([posted]);
    }

    if (!input.fxQuote) {
      throw new Error("Cross-currency cashbox transfer requires a documented FX quote (rate, date, source).");
    }
    const toMoney = convertMoneyExact(fromMoney, fromDef, toDef, input.fxQuote);
    const fxClearingAccId = this.findAccountByCode(context, STANDARD_ACCOUNT_CODES.FX_CLEARING);
    const fxNote = `FX ${fromDef.code}->${toDef.code} @ ${input.fxQuote.rateText} (${input.fxQuote.effectiveDate} | ${input.fxQuote.source})`;

    const leg1Id = generateHiddenUuid();
    const leg2Id = generateHiddenUuid();
    const leg1 = postJournalDraft(
      {
        id: leg1Id, tenantId: actor.tenantId, entryNumber: `FX-${String(baseSeq + 1).padStart(4, "0")}`,
        memo: `${input.memo?.trim() || "FX Cashbox Transfer"} [OUT] ${fxNote}`,
        status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
        lines: [
          { id: `${leg1Id}-l1`, accountId: fxClearingAccId, description: "FX clearing out", debitMinor: fromMoney.amountMinor, creditMinor: 0n, currency: fromDef.code },
          { id: `${leg1Id}-l2`, accountId: fromBox.ledgerAccountId, description: `Out from ${fromBox.code}`, debitMinor: 0n, creditMinor: fromMoney.amountMinor, currency: fromDef.code },
        ],
      },
      nowIso, context,
    );

    const leg2 = postJournalDraft(
      {
        id: leg2Id, tenantId: actor.tenantId, entryNumber: `FX-${String(baseSeq + 2).padStart(4, "0")}`,
        memo: `${input.memo?.trim() || "FX Cashbox Transfer"} [IN] ${fxNote}`,
        status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso,
        lines: [
          { id: `${leg2Id}-l1`, accountId: toBox.ledgerAccountId, description: `In to ${toBox.code}`, debitMinor: toMoney.amountMinor, creditMinor: 0n, currency: toDef.code },
          { id: `${leg2Id}-l2`, accountId: fxClearingAccId, description: "FX clearing in", debitMinor: 0n, creditMinor: toMoney.amountMinor, currency: toDef.code },
        ],
      },
      nowIso, context,
    );

    const batch = Object.freeze([leg1, leg2]);
    this.store.savePostedJournalBatch(actor.tenantId, cleanKey, batch, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "cashbox.transfer", entityId: leg1.id, occurredAt: nowIso,
      summary: `${leg1.entryNumber}+${leg2.entryNumber}: ${fxNote}`,
    });
    return batch;
  }

  reverseEntry(actor: TenantContext, originalEntryId: string, idempotencyKey: string, businessDate: string): JournalEntry {
    return this.reverseEntryOrGroup(actor, originalEntryId, idempotencyKey, businessDate)[0];
  }

  reverseEntryOrGroup(actor: TenantContext, originalEntryId: string, idempotencyKey: string, businessDate: string): readonly JournalEntry[] {
    assertPermission(actor, "finance.reverse");
    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existingBatch = this.store.findJournalBatchByIdempotencyKey(actor.tenantId, cleanKey);
    if (existingBatch) return existingBatch;

    const context = this.buildContext(actor.tenantId);
    const linkedIds = this.store.findLinkedJournalIds(actor.tenantId, originalEntryId);
    const nowIso = new Date().toISOString();
    const baseSeq = this.store.listJournals(actor.tenantId).length;
    const reversals: JournalEntry[] = [];

    for (let i = 0; i < linkedIds.length; i++) {
      const targetId = linkedIds[i];
      const original = context.reversalTargets.get(targetId);
      if (!original) throw new Error(`Original posted journal ${targetId} was not found.`);
      const reversalId = generateHiddenUuid();
      const reversalNumber = `REV-${String(baseSeq + i + 1).padStart(4, "0")}`;
      const draft = createReversal(original, reversalId, reversalNumber, businessDate, nowIso, nowIso, context);
      reversals.push(postJournalDraft(draft, nowIso, context));
    }

    const frozenBatch = Object.freeze(reversals);
    this.store.savePostedJournalBatch(actor.tenantId, cleanKey, frozenBatch, {
      id: generateHiddenUuid(), tenantId: actor.tenantId, userId: actor.userId,
      action: "journal.reversed", entityId: frozenBatch[0].id, occurredAt: nowIso,
      summary: `Reversed ${linkedIds.length} entry(s): ${frozenBatch.map((r) => r.entryNumber).join(", ")}`,
    });
    return frozenBatch;
  }

  closePeriod(
    actor: TenantContext,
    periodId: string,
    nextPeriod?: Readonly<{ id: string; startsOn: string; endsOn: string }>,
  ): ClosePeriodOutcome {
    assertPermission(actor, "finance.reverse");
    const target = this.store.listFiscalPeriods(actor.tenantId).find((p) => p.id === periodId);
    if (!target) throw new Error(`Fiscal period ${periodId} was not found.`);

    const accounts = new Map(this.store.listAccounts(actor.tenantId).map((a) => [a.id, a]));
    const outcome = closeFiscalPeriod(target, this.store.listJournals(actor.tenantId), accounts, new Date().toISOString(), actor.userId);
    this.store.saveFiscalPeriod(actor.tenantId, outcome.closedPeriod);

    if (nextPeriod) {
      const updated = openNextFiscalPeriod(this.store.listFiscalPeriods(actor.tenantId), {
        id: nextPeriod.id, tenantId: actor.tenantId, startsOn: nextPeriod.startsOn, endsOn: nextPeriod.endsOn, status: "open",
      });
      this.store.saveFiscalPeriod(actor.tenantId, updated[updated.length - 1]);
    }
    return outcome;
  }
}

export function createSandboxAccountingService(tenantId: string): AccountingWorkspaceService {
  const year = new Date().getUTCFullYear();
  const accounts = createStandardChartOfAccounts(tenantId);
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const defaultCashboxes: readonly Cashbox[] = Object.freeze([
    { id: "cb-usd", tenantId, code: "CASH-USD", name: "صندوق الدولار الرئيسي", kind: "cash", currency: "USD", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_USD)!.id, isActive: true },
    { id: "cb-syp", tenantId, code: "CASH-SYP", name: "صندوق الليرة السورية الرئيسي", kind: "cash", currency: "SYP", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_SYP)!.id, isActive: true },
    { id: "cb-wallet-usd", tenantId, code: "WALLET-USD", name: "محفظة إلكترونية (دولار)", kind: "wallet", currency: "USD", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.WALLET_PRIMARY)!.id, isActive: true },
  ]);

  const fiscalPeriods: readonly FiscalPeriod[] = Object.freeze([
    { id: `fy-${year}`, tenantId, startsOn: `${year}-01-01`, endsOn: `${year}-12-31`, status: "open" },
  ]);

  return new AccountingWorkspaceService(
    new InMemoryAccountingStore({ tenantId, accounts, cashboxes: defaultCashboxes, fiscalPeriods }),
  );
}
