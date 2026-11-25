import { generateHiddenUuid } from "../core/enterprise";
import {
  buildTrialBalance,
  createReversal,
  postJournalDraft,
  type FiscalPeriod,
  type LedgerAccount,
  type PostingContext,
  type TrialBalance,
} from "../core/finance";
import type { JournalEntry } from "../core/journal";
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
  saleAmountText: string;
  costAmountText?: string;
  memo: string;
}>;

export type WorkspaceSnapshot = Readonly<{
  accounts: readonly LedgerAccount[];
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

  getSnapshot(actor: TenantContext): WorkspaceSnapshot {
    assertPermission(actor, "finance.read");
    const accounts = this.store.listAccounts(actor.tenantId);
    const accountMap = new Map<string, LedgerAccount>(accounts.map((a) => [a.id, a]));
    const entries = this.store.listJournals(actor.tenantId);
    const reversedIds = new Set<string>(entries.map((e) => e.reversalOfId).filter((id): id is string => Boolean(id)));
    const trialBalance = buildTrialBalance(entries, actor.tenantId, accountMap);
    return Object.freeze({
      accounts,
      entries,
      reversedIds,
      trialBalance,
      auditLogs: this.store.listAuditLogs(actor.tenantId),
      storageKind: this.store.kind,
    });
  }

  postCashSale(actor: TenantContext, input: CashSaleWithCogsInput): JournalEntry {
    assertPermission(actor, "finance.post");
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");

    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const currencyDef = SUPPORTED_CURRENCIES[input.currency];
    if (!currencyDef) throw new Error(`Unsupported currency: ${input.currency}`);

    const saleMoney = parseMoney(input.saleAmountText, currencyDef);
    if (saleMoney.amountMinor <= 0n) throw new Error("Sale amount must be greater than zero.");

    const costText = (input.costAmountText ?? "").trim();
    const costMoney = costText ? parseMoney(costText, currencyDef) : null;
    if (costMoney && costMoney.amountMinor < 0n) throw new Error("Cost amount cannot be negative.");

    const context = this.buildContext(actor.tenantId);
    const findByCode = (code: string): string => {
      const found = [...context.accounts.values()].find((a) => a.code === code);
      if (!found) throw new Error(`Required account ${code} is missing.`);
      return found.id;
    };

    const nowIso = new Date().toISOString();
    const entryId = generateHiddenUuid();
    const entryNumber = `JE-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const lines = [
      { id: `${entryId}-l1`, accountId: findByCode("1010"), description: "Cash received", debitMinor: saleMoney.amountMinor, creditMinor: 0n, currency: currencyDef.code },
      { id: `${entryId}-l2`, accountId: findByCode("4000"), description: "Sales revenue", debitMinor: 0n, creditMinor: saleMoney.amountMinor, currency: currencyDef.code },
    ];

    if (costMoney && costMoney.amountMinor > 0n) {
      lines.push(
        { id: `${entryId}-l3`, accountId: findByCode("5000"), description: "Cost of goods sold", debitMinor: costMoney.amountMinor, creditMinor: 0n, currency: currencyDef.code },
        { id: `${entryId}-l4`, accountId: findByCode("1300"), description: "Inventory reduction", debitMinor: 0n, creditMinor: costMoney.amountMinor, currency: currencyDef.code },
      );
    }

    const posted = postJournalDraft(
      { id: entryId, tenantId: actor.tenantId, entryNumber, memo: input.memo.trim() || "Cash sale", status: "draft", businessDate: input.businessDate, occurredAt: nowIso, createdAt: nowIso, lines },
      nowIso,
      context,
    );

    const formattedSale = `${moneyToDecimalString(saleMoney, currencyDef.decimalPlaces)} ${currencyDef.code}`;
    this.store.savePostedJournal(actor.tenantId, cleanKey, posted, {
      id: generateHiddenUuid(),
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "journal.posted",
      entityId: posted.id,
      occurredAt: nowIso,
      summary: `${posted.entryNumber}: ${posted.memo} (${formattedSale})`,
    });
    return posted;
  }

  reverseEntry(actor: TenantContext, originalEntryId: string, idempotencyKey: string, businessDate: string): JournalEntry {
    assertPermission(actor, "finance.reverse");
    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");

    const existing = this.store.findJournalByIdempotencyKey(actor.tenantId, cleanKey);
    if (existing) return existing;

    const context = this.buildContext(actor.tenantId);
    const original = context.reversalTargets.get(originalEntryId);
    if (!original) throw new Error("Original posted journal was not found.");

    const nowIso = new Date().toISOString();
    const reversalId = generateHiddenUuid();
    const reversalNumber = `REV-${String(this.store.listJournals(actor.tenantId).length + 1).padStart(4, "0")}`;

    const draft = createReversal(original, reversalId, reversalNumber, businessDate, nowIso, nowIso, context);
    const postedReversal = postJournalDraft(draft, nowIso, context);

    this.store.savePostedJournal(actor.tenantId, cleanKey, postedReversal, {
      id: generateHiddenUuid(),
      tenantId: actor.tenantId,
      userId: actor.userId,
      action: "journal.reversed",
      entityId: postedReversal.id,
      occurredAt: nowIso,
      summary: `${postedReversal.entryNumber}: Reversed ${original.entryNumber}`,
    });
    return postedReversal;
  }
}

export function createSandboxAccountingService(tenantId: string): AccountingWorkspaceService {
  const year = new Date().getUTCFullYear();
  const accounts: readonly LedgerAccount[] = [
    { id: "acc-cash", tenantId, code: "1010", name: "الصندوق النقدي · Cash", type: "asset", normalBalance: "debit", isActive: true, allowPosting: true },
    { id: "acc-ar", tenantId, code: "1200", name: "ذمم العملاء · Accounts Receivable", type: "asset", normalBalance: "debit", isActive: true, allowPosting: true },
    { id: "acc-inv", tenantId, code: "1300", name: "المخزون · Inventory", type: "asset", normalBalance: "debit", isActive: true, allowPosting: true },
    { id: "acc-rev", tenantId, code: "4000", name: "إيرادات المبيعات · Sales Revenue", type: "revenue", normalBalance: "credit", isActive: true, allowPosting: true },
    { id: "acc-cogs", tenantId, code: "5000", name: "تكلفة البضاعة المباعة · COGS", type: "expense", normalBalance: "debit", isActive: true, allowPosting: true },
  ];
  const fiscalPeriods: readonly FiscalPeriod[] = [
    { id: `fy-${year}`, tenantId, startsOn: `${year}-01-01`, endsOn: `${year}-12-31`, status: "open" },
  ];
  return new AccountingWorkspaceService(new InMemoryAccountingStore({ tenantId, accounts, fiscalPeriods }));
}
