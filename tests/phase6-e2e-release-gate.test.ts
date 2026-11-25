import { describe, expect, it } from "vitest";
import { createStandardChartOfAccounts, STANDARD_ACCOUNT_CODES } from "../src/core/finance";
import {
  AccountingWorkspaceService,
  createSandboxAccountingService,
  exportSignedTenantBackup,
  OfflineSyncQueueService,
  reconcileLegacyWithNewLedger,
  restoreAndVerifyTenantBackup,
} from "../src/services";
import { InMemoryAccountingStore } from "../src/storage";
import { InventoryModuleService } from "../src/modules/inventory";
import { CrmDebtModuleService } from "../src/modules/crm";
import { SalesModuleService } from "../src/modules/sales";
import { ProcurementModuleService } from "../src/modules/procurement";
import { FinancialReportsModuleService } from "../src/modules/reports";

describe("Phase 6: E2E Release Gate (Offline Sync, Multi-Branch, Isolation, Reconciliation & Backup)", () => {
  it("handles offline operations with flaky 4G drops and repeated retries with ZERO duplicate journals", () => {
    const tenantId = "t-p6-offline";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const accounting = createSandboxAccountingService(tenantId);
    const offline = new OfflineSyncQueueService(accounting);

    accounting.postOpeningBalance(owner, { idempotencyKey: "ob-off", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "500.00", memo: "Opening" });

    const op1 = offline.enqueue(owner, { kind: "cash_sale", businessDate: "2026-11-25", currency: "USD", cashboxId: "cb-usd", saleAmountText: "100.00", costAmountText: "60.00", memo: "بيع أوفلاين 1" });
    const op2 = offline.enqueue(owner, { kind: "cash_expense", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "20.00", memo: "مصروف أوفلاين 2" });
    const op3 = offline.enqueue(owner, { kind: "cash_sale", businessDate: "2026-11-25", currency: "USD", cashboxId: "cb-usd", saleAmountText: "50.00", memo: "بيع أوفلاين 3" });
    const opCancel = offline.enqueue(owner, { kind: "cash_sale", businessDate: "2026-11-25", currency: "USD", cashboxId: "cb-usd", saleAmountText: "999.00", memo: "ملغاة قبل المزامنة" });

    expect(offline.enqueue(owner, op1.payload, op1.idempotencyKey).localId).toBe(op1.localId);
    expect(offline.cancelPendingItem(owner, opCancel.localId).status).toBe("cancelled");

    const f1 = offline.flush(owner, { shouldDropConnection: (item) => item.localId === op2.localId || item.localId === op3.localId });
    expect(f1.syncedCount).toBe(1);
    expect(f1.failedCount).toBe(2);

    const f2 = offline.flush(owner);
    expect(f2.syncedCount).toBe(2);
    expect(f2.remainingPending).toBe(0);

    const f3 = offline.flush(owner);
    expect(f3.attempted).toBe(0);

    expect(() => offline.cancelPendingItem(owner, op1.localId)).toThrow(/reversal/i);
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(63000n);
    expect(accounting.getSnapshot(owner).entries.length).toBe(4);
  });

  it("supports multi-branch & multi-currency cashboxes with balanced IFRS statements and strict tenant isolation", () => {
    const store = new InMemoryAccountingStore();
    for (const tid of ["tenant-alpha", "tenant-beta"]) {
      const accounts = createStandardChartOfAccounts(tid);
      const byCode = new Map(accounts.map((a) => [a.code, a]));
      store.seedTenant({
        tenantId: tid, accounts,
        cashboxes: [
          { id: `${tid}-usd`, tenantId: tid, branchId: "br-main", code: "MAIN-USD", name: "صندوق الفرع الرئيسي $", kind: "cash", currency: "USD", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_USD)!.id, isActive: true },
          { id: `${tid}-syp`, tenantId: tid, branchId: "br-main", code: "MAIN-SYP", name: "صندوق الفرع الرئيسي ل.س", kind: "cash", currency: "SYP", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_SYP)!.id, isActive: true },
        ],
        fiscalPeriods: [{ id: `fy-${tid}`, tenantId: tid, startsOn: "2026-01-01", endsOn: "2026-12-31", status: "open" }],
      });
    }

    const accounting = new AccountingWorkspaceService(store);
    const reports = new FinancialReportsModuleService(accounting);
    const ownerA = { tenantId: "tenant-alpha", userId: "u-a", role: "owner" as const };
    const ownerB = { tenantId: "tenant-beta", userId: "u-b", role: "owner" as const };

    const br2Box = accounting.registerCashbox(ownerA, {
      id: "alpha-br2-usd", branchId: "br-2", code: "BR2-USD", ledgerCode: "1012", name: "صندوق الفرع الثاني ($)", kind: "cash", currency: "USD",
    });

    accounting.postOpeningBalance(ownerA, { idempotencyKey: "a-ob-usd", businessDate: "2026-11-25", cashboxId: "tenant-alpha-usd", amountText: "1000.00", memo: "Opening A USD" });
    accounting.postOpeningBalance(ownerA, { idempotencyKey: "a-ob-syp", businessDate: "2026-11-25", cashboxId: "tenant-alpha-syp", amountText: "50000.00", memo: "Opening A SYP" });
    accounting.transferBetweenCashboxes(ownerA, { idempotencyKey: "a-tr-br2", businessDate: "2026-11-25", fromCashboxId: "tenant-alpha-usd", toCashboxId: br2Box.id, amountText: "250.00", memo: "تمويل الفرع الثاني" });
    accounting.postOpeningBalance(ownerB, { idempotencyKey: "b-ob-usd", businessDate: "2026-11-25", cashboxId: "tenant-beta-usd", amountText: "400.00", memo: "Opening B USD" });

    expect(() => accounting.getCashboxStatement(ownerA, "tenant-beta-usd")).toThrow(/not found/i);
    expect(accounting.getCashboxStatement(ownerA, "tenant-alpha-usd").currentBalanceMinor).toBe(75000n);
    expect(accounting.getCashboxStatement(ownerA, br2Box.id).currentBalanceMinor).toBe(25000n);
    expect(accounting.getCashboxStatement(ownerB, "tenant-beta-usd").currentBalanceMinor).toBe(40000n);

    const packA = reports.generateFinancialStatements(ownerA);
    expect(packA.allTrialBalancesBalanced).toBe(true);
    expect(packA.balanceSheets.USD.isEquationBalanced).toBe(true);
    expect(packA.balanceSheets.SYP.isEquationBalanced).toBe(true);
  });

  it("enforces zero-variance legacy-to-new reconciliation and verified SHA-256 backup/restore sign-off", async () => {
    const tenantId = "t-p6-cutover";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const accounts = createStandardChartOfAccounts(tenantId);
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const store = new InMemoryAccountingStore({
      tenantId, accounts,
      cashboxes: [
        { id: "cb-usd", tenantId, code: "CASH-USD", name: "صندوق الدولار", kind: "cash", currency: "USD", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_USD)!.id, isActive: true },
        { id: "cb-syp", tenantId, code: "CASH-SYP", name: "صندوق الليرة", kind: "cash", currency: "SYP", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_SYP)!.id, isActive: true },
      ],
      fiscalPeriods: [{ id: "fy-2026", tenantId, startsOn: "2026-01-01", endsOn: "2026-12-31", status: "open" }],
    });

    const accounting = new AccountingWorkspaceService(store);
    const inventory = new InventoryModuleService(accounting);
    const crm = new CrmDebtModuleService(accounting);
    const procurement = new ProcurementModuleService(accounting, inventory, crm);
    const sales = new SalesModuleService(accounting, inventory, crm);

    accounting.postOpeningBalance(owner, { idempotencyKey: "c-ob-usd", businessDate: "2026-11-01", cashboxId: "cb-usd", amountText: "1000.00", memo: "Opening USD" });
    accounting.postOpeningBalance(owner, { idempotencyKey: "c-ob-syp", businessDate: "2026-11-01", cashboxId: "cb-syp", amountText: "100000.00", memo: "Opening SYP" });

    const wh = inventory.createWarehouse(owner, { code: "MAIN", name: "المستودع الرئيسي" });
    const item = inventory.createProduct(owner, { name: "شاشة", currency: "USD", costMinor: 5000n, saleMinor: 8000n });
    const cust = crm.registerParty(owner, { name: "زبون 1", type: "customer" });
    const supp = crm.registerParty(owner, { name: "مورد 1", type: "supplier" });

    procurement.postPurchaseBill(owner, { idempotencyKey: "c-po", businessDate: "2026-11-02", paymentMode: "credit", currency: "USD", warehouseId: wh.id, supplierId: supp.id, items: [{ productId: item.id, quantity: 10, unitCostMinor: 5000n }] });
    sales.postSaleInvoice(owner, { idempotencyKey: "c-sl", businessDate: "2026-11-03", paymentMode: "credit", currency: "USD", warehouseId: wh.id, customerId: cust.id, items: [{ productId: item.id, quantity: 2 }] });
    crm.collectCustomerPayment(owner, { idempotencyKey: "c-col", businessDate: "2026-11-04", customerId: cust.id, cashboxId: "cb-usd", amountText: "60.00" });

    const okReport = reconcileLegacyWithNewLedger(owner, accounting, [
      { currency: "USD", cashBalanceMinor: 106000n, receivablesBalanceMinor: 10000n, payablesBalanceMinor: 50000n },
      { currency: "SYP", cashBalanceMinor: 10000000n, receivablesBalanceMinor: 0n, payablesBalanceMinor: 0n },
    ]);
    expect(okReport.allMatched).toBe(true);
    expect(okReport.approvedForCutover).toBe(true);

    const badReport = reconcileLegacyWithNewLedger(owner, accounting, [
      { currency: "USD", cashBalanceMinor: 106001n, receivablesBalanceMinor: 10000n, payablesBalanceMinor: 50000n },
    ]);
    expect(badReport.allMatched).toBe(false);
    expect(badReport.approvedForCutover).toBe(false);
    expect(badReport.lines[0].cashVarianceMinor).toBe(-1n);

    const backup = await exportSignedTenantBackup(owner, store);
    const restore = await restoreAndVerifyTenantBackup(owner, backup);
    expect(restore.checksumVerified).toBe(true);
    expect(restore.trialBalanceMatched).toBe(true);
  });
});
