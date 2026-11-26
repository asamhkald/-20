import { describe, expect, it } from "vitest";
import {
  createSamaWorkspace, encodeWorkspaceState, hydrateWorkspaceState,
  loadCloudWorkspace, makeActor, newOperationKey, saveCloudWorkspace, type CloudSyncClient,
} from "../src/services";

describe("Phase 7: Permanent Cloud Persistence (BigInt Codec, SHA-256 & Supabase RPC Sync)", () => {
  it("serializes and hydrates full multi-module BigInt workspace state with zero precision loss", () => {
    const tid = "t-cloud-1";
    const owner = makeActor(tid, "owner");
    const ws1 = createSamaWorkspace(tid);

    ws1.accounting.postOpeningBalance(owner, { idempotencyKey: "ob-u", businessDate: "2026-11-26", cashboxId: "cb-usd", amountText: "1000.00", memo: "USD OB" });
    ws1.accounting.postOpeningBalance(owner, { idempotencyKey: "ob-s", businessDate: "2026-11-26", cashboxId: "cb-syp", amountText: "150000.00", memo: "SYP OB" });

    const prod = ws1.inventory.createProduct(owner, { name: "شاشة A16", currency: "USD", costMinor: 5000n, saleMinor: 8500n });
    const supp = ws1.crm.registerParty(owner, { name: "مورد الشام", type: "supplier" });
    const cust = ws1.crm.registerParty(owner, { name: "زبون كريم", type: "customer" });
    ws1.procurement.postPurchaseBill(owner, { idempotencyKey: "po-1", businessDate: "2026-11-26", paymentMode: "credit", currency: "USD", warehouseId: ws1.defaultWarehouseId, supplierId: supp.id, items: [{ productId: prod.id, quantity: 4, unitCostMinor: 5000n }] });
    ws1.sales.postSaleInvoice(owner, { idempotencyKey: "sl-1", businessDate: "2026-11-26", paymentMode: "credit", currency: "USD", warehouseId: ws1.defaultWarehouseId, customerId: cust.id, items: [{ productId: prod.id, quantity: 1 }] });
    ws1.repairs.createRepairOrder(owner, { customerName: "طارق", deviceModel: "A54", issueDescription: "شحن", currency: "USD", serviceFeeMinor: 2000n });
    ws1.telecom.rechargeWallet(owner, { idempotencyKey: "tr-1", businessDate: "2026-11-26", walletId: ws1.syriatelWalletId, faceAmountMinor: 5000000n, purchaseCostMinor: 4750000n, paymentMode: "cash", cashboxId: "cb-syp" });

    const jsonRoundTrip = JSON.parse(JSON.stringify(encodeWorkspaceState(ws1)));
    const ws2 = hydrateWorkspaceState(createSamaWorkspace(tid), jsonRoundTrip);

    expect(ws2.accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(100000n);
    expect(ws2.accounting.getCashboxStatement(owner, "cb-syp").currentBalanceMinor).toBe(10250000n);
    expect(ws2.inventory.getStockQuantity(tid, ws2.defaultWarehouseId, prod.id)).toBe(3);
    expect(ws2.crm.getPartyBalance(owner, cust.id).balancesByCurrency.USD).toBe(8500n);
    expect(ws2.repairs.listOrders(owner).length).toBe(1);
    expect(ws2.telecom.getWallet(tid, ws2.syriatelWalletId).faceBalanceMinor).toBe(5000000n);
    expect(ws2.reports.generateFinancialStatements(owner).allTrialBalancesBalanced).toBe(true);
  });
  it("saves via sama_v2_save_workspace RPC, reloads on another device, and detects version conflicts", async () => {
    const tid = "t-cloud-rpc";
    const owner = makeActor(tid, "owner");
    let row: { version: number; state_json: unknown; checksum_sha256: string; updated_at: string } | null = null;
    const savedEvents: unknown[] = [];

    const mockClient: CloudSyncClient = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row as Record<string, unknown> | null, error: null }) }) }) }),
      rpc: async (fn, params) => {
        if (fn !== "sama_v2_save_workspace") return { data: null, error: { message: "Unknown RPC" } };
        const exp = params.p_expected_version as number | null;
        if (row && exp !== null && row.version !== exp) return { data: null, error: { message: `SYNC_CONFLICT: cloud version ${row.version} differs from local ${exp}` } };
        const nextVer = row ? row.version + 1 : 1;
        row = { version: nextVer, state_json: params.p_state_json, checksum_sha256: String(params.p_checksum), updated_at: new Date().toISOString() };
        savedEvents.push(...(params.p_new_events as unknown[]));
        return { data: { version: nextVer, saved_at: row.updated_at }, error: null };
      },
    };

    const phoneWs = createSamaWorkspace(tid);
    phoneWs.accounting.postOpeningBalance(owner, { idempotencyKey: newOperationKey(), businessDate: "2026-11-26", cashboxId: "cb-usd", amountText: "750.00", memo: "Phone OB" });
    const save1 = await saveCloudWorkspace(phoneWs, owner, null, mockClient);
    expect(save1.version).toBe(1);
    expect(savedEvents.length).toBe(1);

    const tabletLoad = await loadCloudWorkspace(createSamaWorkspace(tid), owner, mockClient);
    expect(tabletLoad.loadedFromCloud).toBe(true);
    expect(tabletLoad.workspace.accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(75000n);

    tabletLoad.workspace.accounting.postCashSale(owner, { idempotencyKey: newOperationKey(), businessDate: "2026-11-26", currency: "USD", cashboxId: "cb-usd", saleAmountText: "50.00", memo: "Tablet sale" });
    const save2 = await saveCloudWorkspace(tabletLoad.workspace, owner, tabletLoad.version, mockClient);
    expect(save2.version).toBe(2);
    await expect(saveCloudWorkspace(phoneWs, owner, 1, mockClient)).rejects.toThrow(/SYNC_CONFLICT/);
  });
});
