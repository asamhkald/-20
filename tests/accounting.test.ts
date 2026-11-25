import { generateHiddenUuid, assertValidHiddenUuid, IdempotencyGuard, createInventoryItem, calculateUnitProfit, transferWarehouseStock, recordDamagedStock, reconcileCashbox, calculateFxConversion, computeIncomeStatement, computeDebtAging, normalizeArabicDigits } from "../src/core/enterprise";
import { describe, expect, it } from "vitest";
import { createMoney, moneyToDecimalString, parseMoney, addMoney } from "../src/core/money";
import { validateJournal, serializeJournal, deserializeJournal, type JournalEntry } from "../src/core/journal";
import { postJournalDraft, createReversal } from "../src/core/finance/posting";
import { buildTrialBalance } from "../src/core/finance/ledger";
import type { LedgerAccount } from "../src/core/finance/accounts";
import type { FiscalPeriod } from "../src/core/finance/fiscal-period";
import { hasPermission } from "../src/core/permissions";
import { resolveTenantContext, validateOrganization, validateBranch } from "../src/core/tenant";

const accounts = new Map<string, LedgerAccount>([
  ["cash", { id: "cash", tenantId: "tenant-1", code: "1000", name: "Cash", type: "asset", normalBalance: "debit", isActive: true, allowPosting: true }],
  ["sales", { id: "sales", tenantId: "tenant-1", code: "4000", name: "Sales", type: "revenue", normalBalance: "credit", isActive: true, allowPosting: true }],
]);
const periods: FiscalPeriod[] = [
  { id: "fy-2026", tenantId: "tenant-1", startsOn: "2026-01-01", endsOn: "2026-12-31", status: "open" },
];

const postingContext = { tenantId: "tenant-1", accounts, fiscalPeriods: periods, existingReversalOfIds: new Set<string>(), reversalTargets: new Map<string, JournalEntry>() };

const draft: JournalEntry = {
  id: "j-1",
  tenantId: "tenant-1",
  entryNumber: "JE-0001",
  memo: "Test sale",
  status: "draft",
  businessDate: "2026-01-01",
  occurredAt: "2026-01-01T10:00:00.000Z",
  createdAt: "2026-01-01T10:00:00.000Z",
  lines: [
    { id: "jl-1", accountId: "cash", debitMinor: 10000n, creditMinor: 0n, currency: "USD" },
    { id: "jl-2", accountId: "sales", debitMinor: 0n, creditMinor: 10000n, currency: "USD" },
  ],
};

describe("exact money", () => {
  it("parses and formats decimal strings without floating point", () => {
    const money = parseMoney("123456789012345.67", { code: "USD", decimalPlaces: 2 });
    expect(money.amountMinor).toBe(12345678901234567n);
    expect(moneyToDecimalString(money, 2)).toBe("123456789012345.67");
  });

  it("rejects excess precision and mixed currencies", () => {
    expect(() => parseMoney("1.001", { code: "USD", decimalPlaces: 2 })).toThrow(/at most 2/);
    expect(() => createMoney(10n ** 38n, "USD")).toThrow(/38-digit storage limit/);
    expect(() => addMoney(createMoney(100n, "USD"), createMoney(100n, "EUR"))).toThrow(/Currency mismatch/);
  });

  it("adds amounts using integer arithmetic", () => {
    expect(addMoney(createMoney(125n, "USD"), createMoney(75n, "USD")).amountMinor).toBe(200n);
  });
});

describe("journal integrity", () => {
  it("accepts a balanced journal", () => {
    expect(() => validateJournal(draft)).not.toThrow();
  });

  it("rejects an invalid business date", () => {
    expect(() => validateJournal({ ...draft, businessDate: "2026-02-30" })).toThrow(/business date/i);
  });

  it("rejects an unbalanced journal", () => {
    const invalid: JournalEntry = { ...draft, lines: [{ ...draft.lines[0], debitMinor: 9000n }, draft.lines[1]] };
    expect(() => validateJournal(invalid)).toThrow(/not balanced/i);
  });

  it("rejects zero, dual-sided and duplicate journal lines", () => {
    const zero: JournalEntry = { ...draft, lines: [{ ...draft.lines[0], debitMinor: 0n }, draft.lines[1]] };
    const dual: JournalEntry = { ...draft, lines: [{ ...draft.lines[0], creditMinor: 1n }, draft.lines[1]] };
    const duplicate: JournalEntry = { ...draft, lines: [{ ...draft.lines[0] }, { ...draft.lines[1], id: "jl-1" }] };
    expect(() => validateJournal(zero)).toThrow(/cannot be zero/);
    expect(() => validateJournal(dual)).toThrow(/both debit and credit/);
    expect(() => validateJournal(duplicate)).toThrow(/unique ID/);
  });

  it("serializes BigInt amounts as strings and restores them exactly", () => {
    const restored = deserializeJournal(serializeJournal(draft));
    expect(restored.lines[0].debitMinor).toBe(10000n);
    expect(restored.lines[1].creditMinor).toBe(10000n);
  });

  it("posts only balanced drafts for the same tenant and an open fiscal period", () => {
    const posted = postJournalDraft(draft, "2026-01-01T10:05:00.000Z", postingContext);
    expect(posted.status).toBe("posted");
    expect(posted.postedAt).toBe("2026-01-01T10:05:00.000Z");
    expect(Object.isFrozen(posted)).toBe(true);
    expect(Object.isFrozen(posted.lines)).toBe(true);
    expect(() => postJournalDraft(posted, "2026-01-01T10:06:00.000Z", postingContext)).toThrow(/Only draft/);
    expect(() => postJournalDraft(draft, "2026-01-01T10:05:00.000Z", { ...postingContext, tenantId: "tenant-2" })).toThrow(/tenant/);
  });

  it("rejects posting to a closed period or another tenant's account", () => {
    const closed = [{ ...periods[0], status: "closed" as const }];
    expect(() => postJournalDraft(draft, "2026-01-01T10:05:00.000Z", { ...postingContext, fiscalPeriods: closed })).toThrow(/closed/);
    const wrongTenantAccounts = new Map(accounts);
    wrongTenantAccounts.set("cash", { ...accounts.get("cash")!, tenantId: "tenant-2" });
    expect(() => postJournalDraft(draft, "2026-01-01T10:05:00.000Z", { ...postingContext, accounts: wrongTenantAccounts })).toThrow(/Cross-tenant/);
  });

  it("creates a separate reversal without mutating the posted original", () => {
    const posted = postJournalDraft(draft, "2026-01-01T10:05:00.000Z", postingContext);
    const reversal = createReversal(posted, "j-2", "JE-0002", "2026-01-02", "2026-01-02T10:00:00.000Z", "2026-01-02T10:00:00.000Z", postingContext);
    expect(reversal.reversalOfId).toBe(posted.id);
    expect(reversal.lines[0].debitMinor).toBe(0n);
    expect(reversal.lines[0].creditMinor).toBe(10000n);
    expect(posted.lines[0].debitMinor).toBe(10000n);
    const reversalPostingContext = { ...postingContext, reversalTargets: new Map([[posted.id, posted]]) };
    const postedReversal = postJournalDraft(reversal, "2026-01-02T10:01:00.000Z", reversalPostingContext);
    expect(postedReversal.status).toBe("posted");
    expect(() => postJournalDraft(reversal, "2026-01-02T10:01:00.000Z", { ...reversalPostingContext, existingReversalOfIds: new Set([posted.id]) })).toThrow(/already has a recorded reversal/);
    expect(() => createReversal(posted, "j-3", "JE-0003", "2026-01-02", "2026-01-02T10:00:00.000Z", "2026-01-02T10:00:00.000Z", { ...postingContext, existingReversalOfIds: new Set([posted.id]) })).toThrow(/already has a recorded reversal/);
  });
});

describe("ledger reporting", () => {
  it("builds a balanced trial balance per currency from posted entries only", () => {
    const posted = postJournalDraft(draft, "2026-01-01T10:05:00.000Z", postingContext);
    const trialBalance = buildTrialBalance([draft, posted], "tenant-1", accounts);
    expect(trialBalance.rows).toHaveLength(2);
    expect(trialBalance.totals).toEqual([{ currency: "USD", debitMinor: 10000n, creditMinor: 10000n, isBalanced: true }]);
    expect(() => buildTrialBalance([posted], "tenant-2", accounts)).toThrow(/Cross-tenant/);
  });
});

describe("organization boundaries", () => {
  it("validates organization settings and supported time zones", () => {
    expect(() => validateOrganization({ id: "org-1", legalName: "Example Ltd", baseCurrency: "USD", timezone: "Europe/Sofia", locale: "en-US", fiscalYearStartMonth: 1, status: "active" })).not.toThrow();
    expect(() => validateOrganization({ id: "org-1", legalName: "Example Ltd", baseCurrency: "US", timezone: "Not/A_Timezone", locale: "en-US", fiscalYearStartMonth: 13, status: "active" })).toThrow();
  });

  it("requires a matching active membership before creating tenant context", () => {
    const membership = { id: "m-1", tenantId: "tenant-1", userId: "user-1", role: "accountant" as const, status: "active" as const };
    expect(resolveTenantContext("user-1", membership).tenantId).toBe("tenant-1");
    expect(() => resolveTenantContext("user-2", membership)).toThrow(/authenticated user/);
    expect(() => resolveTenantContext("user-1", { ...membership, status: "suspended" })).toThrow(/active/);
  });

  it("requires branches to stay attached to a tenant", () => {
    expect(() => validateBranch({ id: "br-1", tenantId: "tenant-1", code: "HQ", name: "Head office", isActive: true })).not.toThrow();
    expect(() => validateBranch({ id: "br-1", tenantId: "", code: "HQ", name: "Head office", isActive: true })).toThrow(/tenant/);
  });
});

describe("authorization", () => {
  it("does not grant posting permission to read-only auditors", () => {
    expect(hasPermission("auditor", "finance.read")).toBe(true);
    expect(hasPermission("auditor", "finance.post")).toBe(false);
    expect(hasPermission("readonly", "sales.write")).toBe(false);
    expect(hasPermission("technician", "operations.write")).toBe(true);
  });
});

describe("enterprise hidden UUID, inventory, voice digits & cashbox reconciliation", () => {
  it("generates valid RFC-4122 v4 hidden UUIDs and blocks duplicate claims", () => {
    const uuid = generateHiddenUuid();
    expect(() => assertValidHiddenUuid(uuid)).not.toThrow();
    const guard = new IdempotencyGuard();
    expect(() => guard.claim(uuid)).not.toThrow();
    expect(guard.has(uuid)).toBe(true);
    expect(() => guard.claim(uuid)).toThrow(/Duplicate operation blocked/);
  });

  it("creates immutable hidden-UUID inventory items with exact BigInt unit profit", () => {
    const item = createInventoryItem({
      tenantId: "tenant-1",
      name: "iPhone Fast Charger",
      costMinor: 850n,
      saleMinor: 1500n,
      currency: "USD",
      quantity: 12,
      minStock: 3,
    });
    expect(() => assertValidHiddenUuid(item.hiddenUuid)).not.toThrow();
    expect(Object.isFrozen(item)).toBe(true);
    expect(calculateUnitProfit(item).amountMinor).toBe(650n);
  });

  it("reconciles physical cashbox counts and normalizes Arabic speech digits", () => {
    const matched = reconcileCashbox(createMoney(50000n, "USD"), createMoney(50000n, "USD"));
    expect(matched.status).toBe("matched");
    const shortage = reconcileCashbox(createMoney(50000n, "USD"), createMoney(48500n, "USD"));
    expect(shortage.status).toBe("shortage");
    expect(normalizeArabicDigits("قبض ٢٥٠ دولار")).toBe("قبض 250 دولار");
  });
});

describe("IFRS reports, IAS 21 FX, multi-warehouse stock & debt aging", () => {
  it("transfers stock between warehouses and records damaged write-offs accurately", () => {
    const item = createInventoryItem({
      tenantId: "tenant-1",
      warehouseId: "wh-main",
      name: "Samsung A16 Screen",
      costMinor: 2000n,
      saleMinor: 3500n,
      currency: "USD",
      quantity: 10,
      minStock: 2,
    });
    const transfer = transferWarehouseStock(item, "wh-repair", 4);
    expect(transfer.sourceItem.quantity).toBe(6);
    expect(transfer.destinationItem.quantity).toBe(4);
    expect(transfer.destinationItem.warehouseId).toBe("wh-repair");
    expect(() => assertValidHiddenUuid(transfer.transferUuid)).not.toThrow();

    const damage = recordDamagedStock(transfer.sourceItem, 2);
    expect(damage.updatedItem.quantity).toBe(4);
    expect(damage.lossMinor).toBe(4000n);
  });

  it("computes exact IAS 21 FX conversion variance and IFRS income statement", () => {
    const fx = calculateFxConversion({
      sourceAmount: createMoney(10000n, "USD"),
      toCurrency: "SYP",
      appliedRateScaled: 122000000n,
      referenceRateScaled: 120000000n,
      rateScale: 10000n,
    });
    expect(fx.convertedMinor).toBe(122000000n);
    expect(fx.fxGainLossMinor).toBe(2000000n);

    const pnl = computeIncomeStatement({
      currency: "USD",
      revenueMinor: 50000n,
      cogsMinor: 30000n,
      operatingExpensesMinor: 5000n,
      fxGainLossMinor: 1000n,
    });
    expect(pnl.grossProfitMinor).toBe(20000n);
    expect(pnl.netProfitMinor).toBe(16000n);
  });

  it("buckets overdue receivables into standard 0-30, 31-60, 61-90 and 90+ day aging periods", () => {
    const aging = computeDebtAging(
      [
        { id: "d-1", outstandingMinor: 1000n, currency: "USD", issuedAtIso: "2026-11-15T00:00:00.000Z" },
        { id: "d-2", outstandingMinor: 2000n, currency: "USD", issuedAtIso: "2026-10-10T00:00:00.000Z" },
        { id: "d-3", outstandingMinor: 3000n, currency: "USD", issuedAtIso: "2026-09-10T00:00:00.000Z" },
        { id: "d-4", outstandingMinor: 4000n, currency: "USD", issuedAtIso: "2026-07-01T00:00:00.000Z" },
      ],
      "USD",
      "2026-11-25T00:00:00.000Z",
    );
    expect(aging.days0To30Minor).toBe(1000n);
    expect(aging.days31To60Minor).toBe(2000n);
    expect(aging.days61To90Minor).toBe(3000n);
    expect(aging.daysOver90Minor).toBe(4000n);
    expect(aging.totalMinor).toBe(10000n);
  });
});
