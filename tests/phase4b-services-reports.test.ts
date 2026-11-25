import { describe, expect, it } from "vitest";
import { createSandboxAccountingService } from "../src/services";
import { InventoryModuleService } from "../src/modules/inventory";
import { CrmDebtModuleService } from "../src/modules/crm";
import { ProcurementModuleService } from "../src/modules/procurement";
import { OperationsRepairModuleService } from "../src/modules/operations";
import { TelecomModuleService } from "../src/modules/telecom";
import { FinancialReportsModuleService } from "../src/modules/reports";

describe("Phase 4B: Maintenance/Repairs, Telecom WAC Wallets & IFRS Financial Reports", () => {
  it("separates technician intake from financial delivery, deducts spare parts, and reverses atomically", () => {
    const tenantId = "t-p4b-repairs";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const technician = { tenantId, userId: "u-tech", role: "technician" as const };
    const cashier = { tenantId, userId: "u-cashier", role: "cashier" as const };

    const accounting = createSandboxAccountingService(tenantId);
    const inventory = new InventoryModuleService(accounting);
    const crm = new CrmDebtModuleService(accounting);
    const procurement = new ProcurementModuleService(accounting, inventory, crm);
    const repairs = new OperationsRepairModuleService(accounting, inventory, crm);

    accounting.postOpeningBalance(owner, { idempotencyKey: "ob-rep", businessDate: "2026-11-01", cashboxId: "cb-usd", amountText: "500.00", memo: "Opening" });
    const whParts = inventory.createWarehouse(owner, { code: "PARTS", name: "مخزن قطع الصيانة" });
    const battery = inventory.createProduct(owner, { name: "بطارية سامسونج أصلية", currency: "USD", costMinor: 1500n, saleMinor: 2500n });
    procurement.postPurchaseBill(owner, {
      idempotencyKey: "po-bat", businessDate: "2026-11-02", paymentMode: "cash", currency: "USD",
      warehouseId: whParts.id, cashboxId: "cb-usd", items: [{ productId: battery.id, quantity: 4, unitCostMinor: 1500n }],
    });

    // Technician creates & completes repair order
    const order = repairs.createRepairOrder(technician, {
      customerName: "خالد محمود", deviceModel: "Samsung A16", imei: "354812098765432",
      issueDescription: "تبديل بطارية", warrantyDays: 30, currency: "USD", serviceFeeMinor: 3500n,
    });
    const completed = repairs.markRepairCompleted(technician, order.id);
    expect(completed.status).toBe("completed");

    // Technician CANNOT settle/post financial delivery
    expect(() =>
      repairs.deliverRepairOrder(technician, {
        orderId: order.id, idempotencyKey: "tech-deliv", businessDate: "2026-11-05", paymentMode: "cash", cashboxId: "cb-usd",
      }),
    ).toThrow(/Permission denied/);

    // Cashier delivers & deducts 1 battery ($15 cost, $35 fee -> $20 gross profit)
    const delivered = repairs.deliverRepairOrder(cashier, {
      orderId: order.id, idempotencyKey: "cash-deliv", businessDate: "2026-11-05", paymentMode: "cash", cashboxId: "cb-usd",
      parts: [{ warehouseId: whParts.id, productId: battery.id, quantity: 1 }],
    });
    expect(delivered.status).toBe("delivered");
    expect(delivered.totalPartsCostMinor).toBe(1500n);
    expect(inventory.getStockQuantity(tenantId, whParts.id, battery.id)).toBe(3);

    // Owner reverses delivered repair -> restores battery stock to 4 and reverses cash & revenue
    const reversed = repairs.reverseDeliveredRepair(owner, order.id, "rev-rep-1", "2026-11-06");
    expect(reversed.status).toBe("reversed");
    expect(inventory.getStockQuantity(tenantId, whParts.id, battery.id)).toBe(4);
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(44000n); // 500 - 60 battery purchase
  });

  it("tracks telecom wallets with exact BigInt WAC, blocks overdraft, reverses atomically, and balances IFRS reports", () => {
    const tenantId = "t-p4b-telecom";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const accounting = createSandboxAccountingService(tenantId);
    const crm = new CrmDebtModuleService(accounting);
    const telecom = new TelecomModuleService(accounting, crm);
    const reports = new FinancialReportsModuleService(accounting);

    accounting.postOpeningBalance(owner, { idempotencyKey: "ob-syp", businessDate: "2026-11-01", cashboxId: "cb-syp", amountText: "200000.00", memo: "Opening SYP" });
    accounting.postOpeningBalance(owner, { idempotencyKey: "ob-usd", businessDate: "2026-11-01", cashboxId: "cb-usd", amountText: "1000.00", memo: "Opening USD" });

    const syriatel = telecom.registerWallet(owner, { networkCode: "SYRIATEL", label: "محفظة سيريتل", currency: "SYP" });

    // Buy 100,000 SYP face credit for 95,000 SYP cash (WAC = 95%)
    telecom.rechargeWallet(owner, {
      idempotencyKey: "rch-1", businessDate: "2026-11-02", walletId: syriatel.id,
      faceAmountMinor: 10000000n, purchaseCostMinor: 9500000n, paymentMode: "cash", cashboxId: "cb-syp",
    });

    // Overdraft attempt (120,000 > 100,000) MUST throw (never silently clamp!)
    expect(() =>
      telecom.postTopupSale(owner, {
        idempotencyKey: "top-over", businessDate: "2026-11-03", walletId: syriatel.id,
        faceAmountMinor: 12000000n, chargedMinor: 12500000n, paymentMode: "cash", cashboxId: "cb-syp",
      }),
    ).toThrow(/Insufficient wallet balance/);

    // Sell 20,000 SYP face credit (package المريخ) for 21,000 SYP -> WAC cost = 19,000 SYP, Gross Profit = 2,000 SYP
    const top1 = telecom.postTopupSale(owner, {
      idempotencyKey: "top-1", businessDate: "2026-11-03", walletId: syriatel.id,
      faceAmountMinor: 2000000n, chargedMinor: 2100000n, paymentMode: "cash", cashboxId: "cb-syp",
      recipientPhone: "0933000111", packageName: "باقة المريخ",
    });
    expect(top1.wacCostMinor).toBe(1900000n);
    expect(top1.grossProfitMinor).toBe(200000n);

    const wAfterSale = telecom.getWallet(tenantId, syriatel.id);
    expect(wAfterSale.faceBalanceMinor).toBe(8000000n);
    expect(wAfterSale.costPoolMinor).toBe(7600000n);

    // Sell a second top-up and reverse it -> wallet must remain at exact 80,000 face / 76,000 cost
    const top2 = telecom.postTopupSale(owner, {
      idempotencyKey: "top-2", businessDate: "2026-11-04", walletId: syriatel.id,
      faceAmountMinor: 1000000n, chargedMinor: 1050000n, paymentMode: "cash", cashboxId: "cb-syp",
    });
    telecom.reverseTopupSale(owner, top2.id, "rev-top-2", "2026-11-04");
    expect(telecom.getWallet(tenantId, syriatel.id).faceBalanceMinor).toBe(8000000n);
    expect(telecom.getWallet(tenantId, syriatel.id).costPoolMinor).toBe(7600000n);

    // Generate full IFRS Financial Statements Pack (Income Statement + Balance Sheet)
    const pack = reports.generateFinancialStatements(owner);
    expect(pack.allTrialBalancesBalanced).toBe(true);

    const sypPnl = pack.incomeStatements.SYP;
    expect(sypPnl.serviceRevenueMinor).toBe(2100000n);
    expect(sypPnl.cogsMinor).toBe(1900000n);
    expect(sypPnl.netProfitMinor).toBe(200000n); // Exact 2,000.00 SYP net profit

    const sypBs = pack.balanceSheets.SYP;
    expect(sypBs.isEquationBalanced).toBe(true); // Assets === Liabilities + Equity
    expect(sypBs.totalAssetsMinor).toBe(20200000n); // 126,000 cash + 76,000 wallet = 202,000 SYP
    expect(sypBs.totalEquityMinor).toBe(20200000n); // 200,000 equity + 2,000 profit = 202,000 SYP

    const usdBs = pack.balanceSheets.USD;
    expect(usdBs.isEquationBalanced).toBe(true);
    expect(usdBs.totalAssetsMinor).toBe(100000n);
  });
});
