import { generateHiddenUuid } from "../../core/enterprise";
import { STANDARD_ACCOUNT_CODES } from "../../core/finance";
import { hasPermission } from "../../core/permissions";
import type { TenantContext } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";
import type { CrmDebtModuleService } from "../crm";
import type { InventoryModuleService } from "../inventory";

export type PurchaseItemInput = Readonly<{ productId: string; quantity: number; unitCostMinor: bigint }>;

export type PurchaseBill = Readonly<{
  id: string; tenantId: string; billNumber: string; businessDate: string;
  paymentMode: "cash" | "credit"; currency: "USD" | "SYP"; warehouseId: string;
  cashboxId?: string; supplierId?: string; totalMinor: bigint; journalEntryId: string;
  status: "posted" | "reversed"; reversalJournalId?: string;
}>;

export class ProcurementModuleService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly inventory: InventoryModuleService;
  private readonly crm: CrmDebtModuleService;
  private readonly bills = new Map<string, PurchaseBill[]>();
  private readonly billByIdem = new Map<string, string>();

  constructor(accounting: AccountingWorkspaceService, inventory: InventoryModuleService, crm: CrmDebtModuleService) {
    this.accounting = accounting;
    this.inventory = inventory;
    this.crm = crm;
  }

  postPurchaseBill(
    actor: TenantContext,
    input: Readonly<{
      idempotencyKey: string; businessDate: string; paymentMode: "cash" | "credit"; currency: "USD" | "SYP";
      warehouseId: string; cashboxId?: string; supplierId?: string; items: readonly PurchaseItemInput[]; memo?: string;
    }>,
  ): PurchaseBill {
    if (!hasPermission(actor.role, "procurement.write")) throw new Error(`Permission denied: "${actor.role}" lacks "procurement.write".`);
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required for purchase bills.");

    const existingId = this.billByIdem.get(`${actor.tenantId}::${cleanKey}`);
    if (existingId) {
      const found = (this.bills.get(actor.tenantId) ?? []).find((b) => b.id === existingId);
      if (found) return found;
    }

    if (input.items.length === 0) throw new Error("Purchase bill requires at least one item.");
    if (input.paymentMode === "credit" && !input.supplierId) throw new Error("Credit purchases MUST be linked to a registered supplier.");
    if (input.paymentMode === "cash" && !input.cashboxId) throw new Error("Cash purchases require a source cashboxId.");

    const supplier = input.supplierId ? this.crm.getPartyOrThrow(actor.tenantId, input.supplierId, "supplier") : undefined;

    let totalMinor = 0n;
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("Purchase quantity must be positive.");
      if (item.unitCostMinor <= 0n) throw new Error("Purchase unit cost must be positive.");
      const product = this.inventory.getProductInternal(actor.tenantId, item.productId);
      if (product.currency !== input.currency) throw new Error(`Currency mismatch for "${product.name}".`);
      totalMinor += item.unitCostMinor * BigInt(item.quantity);
    }

    const billId = generateHiddenUuid();
    const list = this.bills.get(actor.tenantId) ?? [];
    const billNumber = `PO-${String(list.length + 1).padStart(4, "0")}`;

    const creditLine = input.paymentMode === "cash"
      ? { accountId: this.accounting.getCashbox(actor, input.cashboxId!).ledgerAccountId, debitMinor: 0n, creditMinor: totalMinor, description: "سداد نقدي لفاتورة شراء" }
      : { accountCode: STANDARD_ACCOUNT_CODES.ACCOUNTS_PAYABLE, debitMinor: 0n, creditMinor: totalMinor, description: `ذمة مورد: ${supplier!.name}` };

    const je = this.accounting.postModuleJournal(actor, {
      idempotencyKey: cleanKey, businessDate: input.businessDate, entryPrefix: "PO", currency: input.currency,
      memo: input.memo?.trim() || `فاتورة شراء ${billNumber} (${input.paymentMode === "cash" ? "نقدي" : "آجل"})`,
      requiredPermission: "procurement.write",
      lines: [
        { accountCode: STANDARD_ACCOUNT_CODES.INVENTORY, debitMinor: totalMinor, creditMinor: 0n, description: "توريد للمخزون" },
        creditLine,
      ],
    });

    for (const item of input.items) {
      this.inventory.receiveStockWithWac(actor, {
        warehouseId: input.warehouseId, productId: item.productId, quantity: item.quantity, unitCostMinor: item.unitCostMinor,
        movementType: "PURCHASE", referenceId: billId, journalEntryId: je.id, notes: `شراء ${billNumber}`, recomputeWac: true,
      });
    }

    if (input.paymentMode === "credit" && supplier) {
      this.crm.recordSubledgerEntry({
        tenantId: actor.tenantId, partyId: supplier.id, currency: input.currency,
        deltaMinor: totalMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: `فاتورة شراء آجل ${billNumber}`,
      });
    }

    const bill: PurchaseBill = Object.freeze({
      id: billId, tenantId: actor.tenantId, billNumber, businessDate: input.businessDate,
      paymentMode: input.paymentMode, currency: input.currency, warehouseId: input.warehouseId,
      cashboxId: input.cashboxId, supplierId: input.supplierId, totalMinor, journalEntryId: je.id, status: "posted",
    });
    list.unshift(bill);
    this.bills.set(actor.tenantId, list);
    this.billByIdem.set(`${actor.tenantId}::${cleanKey}`, bill.id);
    return bill;
  }

  reversePurchaseBill(actor: TenantContext, billId: string, idempotencyKey: string, businessDate: string): PurchaseBill {
    const list = this.bills.get(actor.tenantId) ?? [];
    const idx = list.findIndex((b) => b.id === billId);
    if (idx < 0) throw new Error(`Purchase bill ${billId} not found.`);
    const orig = list[idx];
    if (orig.status === "reversed") throw new Error(`Purchase bill ${orig.billNumber} is already reversed.`);

    this.inventory.assertCanReverseMovementsForJournal(actor.tenantId, orig.journalEntryId);
    const revJournal = this.accounting.reverseEntry(actor, orig.journalEntryId, idempotencyKey, businessDate);
    this.inventory.reverseMovementsForJournal(actor, orig.journalEntryId, revJournal.id);
    if (orig.paymentMode === "credit" && orig.supplierId) {
      this.crm.reverseSubledgerEntriesForJournal(actor.tenantId, orig.journalEntryId, revJournal.id, businessDate);
    }

    const updated: PurchaseBill = Object.freeze({ ...orig, status: "reversed", reversalJournalId: revJournal.id });
    list[idx] = updated;
    return updated;
  }
}
