import { describe, expect, it } from "vitest";
import { createSandboxAccountingService } from "../src/services";
import { InventoryModuleService } from "../src/modules/inventory";
import { CrmDebtModuleService } from "../src/modules/crm";
import { SalesModuleService } from "../src/modules/sales";
import { ProcurementModuleService } from "../src/modules/procurement";

function setupCommerce(tenantId: string) {
  const owner = { tenantId, userId: "u-owner", role: "owner" as const };
  const salesActor = { tenantId, userId: "u-sales", role: "sales" as const };
  const accounting = createSandboxAccountingService(tenantId);
  const inventory = new InventoryModuleService(accounting);
  const crm = new CrmDebtModuleService(accounting);
  const sales = new SalesModuleService(accounting, inventory, crm);
  const procurement = new ProcurementModuleService(accounting, inventory, crm);

  accounting.postOpeningBalance(owner, { idempotencyKey: "ob-usd", businessDate: "2026-11-01", cashboxId: "cb-usd", amountText: "2000.00", memo: "رأس مال افتتاحي" });
  const whMain = inventory.createWarehouse(owner, { code: "MAIN", name: "المستودع الرئيسي" });
  const whShop = inventory.createWarehouse(owner, { code: "SHOP", name: "صالة العرض" });
  const screen = inventory.createProduct(owner, { sku: "INF-SCR-01", name: "شاشة إنفينكس أصلية", currency: "USD", costMinor: 0n, saleMinor: 10000n });
  const customer = crm.registerParty(owner, { name: "أحمد العلي", phone: "0933112233", type: "customer" });
  const supplier = crm.registerParty(owner, { name: "موزع الجملة - الشام", phone: "0944556677", type: "supplier" });

  return { owner, salesActor, accounting, inventory, crm, sales, procurement, whMain, whShop, screen, customer, supplier };
}

describe("Phase 4A: Integrated Inventory, CRM/Debts, Procurement & Sales Modules", () => {
  it("computes exact BigInt WAC on multi-batch purchases, transfers stock, and masks wholesale cost from sales staff", () => {
    const { owner, salesActor, inventory, procurement, whMain, whShop, screen, supplier } = setupCommerce("t-p4a-wac");

    // Batch 1: 10 units @ $60 (credit from supplier) -> WAC = $60.00
    procurement.postPurchaseBill(owner, {
      idempotencyKey: "po-1", businessDate: "2026-11-02", paymentMode: "credit", currency: "USD",
      warehouseId: whMain.id, supplierId: supplier.id, items: [{ productId: screen.id, quantity: 10, unitCostMinor: 6000n }],
    });
    expect(inventory.getProductInternal("t-p4a-wac", screen.id).costMinor).toBe(6000n);

    // Batch 2: 10 units @ $80 (cash) -> WAC = (600 + 800) / 20 = $70.00
    procurement.postPurchaseBill(owner, {
      idempotencyKey: "po-2", businessDate: "2026-11-03", paymentMode: "cash", currency: "USD",
      warehouseId: whMain.id, cashboxId: "cb-usd", items: [{ productId: screen.id, quantity: 10, unitCostMinor: 8000n }],
    });
    expect(inventory.getProductInternal("t-p4a-wac", screen.id).costMinor).toBe(7000n);
    expect(inventory.getStockQuantity("t-p4a-wac", whMain.id, screen.id)).toBe(20);

    // Transfer 5 units MAIN -> SHOP
    inventory.transferBetweenWarehouses(owner, { fromWarehouseId: whMain.id, toWarehouseId: whShop.id, productId: screen.id, quantity: 5 });
    expect(inventory.getStockQuantity("t-p4a-wac", whMain.id, screen.id)).toBe(15);
    expect(inventory.getStockQuantity("t-p4a-wac", whShop.id, screen.id)).toBe(5);

    // Cost masking: sales employee gets costMinor === null; owner sees 7000n
    expect(inventory.listCatalog(salesActor)[0].costMinor).toBeNull();
    expect(inventory.listCatalog(owner)[0].costMinor).toBe(7000n);
  });

  it("handles cash & credit sales with COGS, sales returns, atomic reversal, and blocks credit sale without customer", () => {
    const { owner, accounting, inventory, crm, sales, procurement, whMain, screen, customer, supplier } = setupCommerce("t-p4a-sales");

    procurement.postPurchaseBill(owner, {
      idempotencyKey: "po-init", businessDate: "2026-11-02", paymentMode: "credit", currency: "USD",
      warehouseId: whMain.id, supplierId: supplier.id, items: [{ productId: screen.id, quantity: 10, unitCostMinor: 7000n }],
    });

    // Credit sale without customer MUST fail
    expect(() =>
      sales.postSaleInvoice(owner, {
        idempotencyKey: "bad-credit", businessDate: "2026-11-05", paymentMode: "credit", currency: "USD",
        warehouseId: whMain.id, items: [{ productId: screen.id, quantity: 1 }],
      }),
    ).toThrow(/registered customer/);

    // Cash sale: 2 units @ $100 ($200 sale, $140 COGS)
    const cashInv = sales.postSaleInvoice(owner, {
      idempotencyKey: "sl-cash-1", businessDate: "2026-11-05", paymentMode: "cash", currency: "USD",
      warehouseId: whMain.id, cashboxId: "cb-usd", items: [{ productId: screen.id, quantity: 2 }],
    });
    expect(inventory.getStockQuantity("t-p4a-sales", whMain.id, screen.id)).toBe(8);
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(220000n);

    // Atomic reversal of cash sale restores stock to 10 and cashbox back to $2000!
    const revInv = sales.reverseSaleInvoice(owner, cashInv.id, "rev-sl-1", "2026-11-05");
    expect(revInv.status).toBe("reversed");
    expect(inventory.getStockQuantity("t-p4a-sales", whMain.id, screen.id)).toBe(10);
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(200000n);

    // Credit sale: 3 units @ $100 ($300) -> stock 7, customer debt $300
    sales.postSaleInvoice(owner, {
      idempotencyKey: "sl-cr-1", businessDate: "2026-10-01", paymentMode: "credit", currency: "USD",
      warehouseId: whMain.id, customerId: customer.id, items: [{ productId: screen.id, quantity: 3 }],
    });
    expect(inventory.getStockQuantity("t-p4a-sales", whMain.id, screen.id)).toBe(7);
    expect(crm.getPartyBalance(owner, customer.id).balancesByCurrency.USD).toBe(30000n);

    // Partial customer collection $120 -> remaining debt $180, Revenue NOT duplicated!
    const col = crm.collectCustomerPayment(owner, {
      idempotencyKey: "col-1", businessDate: "2026-11-10", customerId: customer.id, cashboxId: "cb-usd", amountText: "120.00",
    });
    expect(col.remainingDebtMinor).toBe(18000n);

    // Aging as of 2026-11-25 (55 days old -> 31-60 bucket = $180)
    const aging = crm.getDebtAging(owner, "customer", "USD", "2026-11-25T00:00:00.000Z");
    expect(aging.days31To60Minor).toBe(18000n);
    expect(aging.totalMinor).toBe(18000n);

    // Sales return of 1 unit (credit) -> stock 8, customer debt $80, COGS reduced by $70
    sales.postSalesReturn(owner, {
      idempotencyKey: "sr-1", businessDate: "2026-11-12", warehouseId: whMain.id,
      productId: screen.id, quantity: 1, refundMode: "credit", customerId: customer.id, reason: "عيب مصنعي",
    });
    expect(inventory.getStockQuantity("t-p4a-sales", whMain.id, screen.id)).toBe(8);
    expect(crm.getPartyBalance(owner, customer.id).balancesByCurrency.USD).toBe(8000n);

    expect(accounting.getSnapshot(owner).trialBalance.totals.every((t) => t.isBalanced)).toBe(true);
  });

  it("writes off damaged stock without touching cashbox and blocks unsafe purchase reversal if stock was sold", () => {
    const { owner, accounting, inventory, sales, procurement, whMain, screen, supplier } = setupCommerce("t-p4a-dmg");

    const po = procurement.postPurchaseBill(owner, {
      idempotencyKey: "po-only", businessDate: "2026-11-02", paymentMode: "credit", currency: "USD",
      warehouseId: whMain.id, supplierId: supplier.id, items: [{ productId: screen.id, quantity: 5, unitCostMinor: 7000n }],
    });

    const cashBefore = accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor;
    const dmg = inventory.recordDamagedStock(owner, {
      idempotencyKey: "dmg-1", businessDate: "2026-11-04", warehouseId: whMain.id, productId: screen.id, quantity: 1, reason: "كسر أثناء الفحص",
    });
    expect(dmg.lossMinor).toBe(7000n);
    expect(dmg.remainingQuantity).toBe(4);
    // Cashbox MUST be completely untouched by damaged stock write-off!
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(cashBefore);

    // Sell 2 units -> only 2 left, so reversing the original 5-unit purchase MUST fail atomically!
    sales.postSaleInvoice(owner, {
      idempotencyKey: "sl-2", businessDate: "2026-11-05", paymentMode: "cash", currency: "USD",
      warehouseId: whMain.id, cashboxId: "cb-usd", items: [{ productId: screen.id, quantity: 2 }],
    });
    const journalCountBefore = accounting.getSnapshot(owner).entries.length;
    expect(() => procurement.reversePurchaseBill(owner, po.id, "rev-po-fail", "2026-11-06")).toThrow(/Insufficient stock/);
    // Ensure failed reversal did NOT post any orphan journal!
    expect(accounting.getSnapshot(owner).entries.length).toBe(journalCountBefore);
    expect(accounting.getSnapshot(owner).trialBalance.totals.every((t) => t.isBalanced)).toBe(true);
  });
});
