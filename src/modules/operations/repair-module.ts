import { generateHiddenUuid } from "../../core/enterprise";
import { STANDARD_ACCOUNT_CODES } from "../../core/finance";
import { hasPermission } from "../../core/permissions";
import type { TenantContext } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";
import type { CrmDebtModuleService } from "../crm";
import type { InventoryModuleService } from "../inventory";

export type RepairPartInput = Readonly<{ warehouseId: string; productId: string; quantity: number }>;

export type RepairPartUsed = Readonly<{
  warehouseId: string; productId: string; productName: string;
  quantity: number; unitCostMinor: bigint; totalCostMinor: bigint;
}>;

export type RepairOrderStatus = "received" | "completed" | "delivered" | "reversed";

export type RepairOrder = Readonly<{
  id: string; tenantId: string; ticketNumber: string; customerId?: string; customerName: string;
  phone?: string; deviceModel: string; imei?: string; issueDescription: string; warrantyDays: number;
  currency: "USD" | "SYP"; serviceFeeMinor: bigint; parts: readonly RepairPartUsed[];
  totalPartsCostMinor: bigint; status: RepairOrderStatus; journalEntryId?: string;
  reversalJournalId?: string; paymentMode?: "cash" | "credit"; createdBy: string; createdAt: string;
}>;

export class OperationsRepairModuleService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly inventory: InventoryModuleService;
  private readonly crm: CrmDebtModuleService;
  private readonly orders = new Map<string, RepairOrder[]>();

  constructor(accounting: AccountingWorkspaceService, inventory: InventoryModuleService, crm: CrmDebtModuleService) {
    this.accounting = accounting;
    this.inventory = inventory;
    this.crm = crm;
  }

  createRepairOrder(
    actor: TenantContext,
    input: Readonly<{
      customerId?: string; customerName: string; phone?: string; deviceModel: string;
      imei?: string; issueDescription: string; warrantyDays?: number; currency: "USD" | "SYP"; serviceFeeMinor: bigint;
    }>,
  ): RepairOrder {
    if (!hasPermission(actor.role, "operations.write")) throw new Error(`Permission denied: "${actor.role}" lacks "operations.write".`);
    const customerName = input.customerName.trim();
    const deviceModel = input.deviceModel.trim();
    const issueDescription = input.issueDescription.trim();
    if (!customerName || !deviceModel || !issueDescription) throw new Error("Customer name, device model, and issue are required.");
    if (input.serviceFeeMinor <= 0n) throw new Error("Repair service fee must be positive.");
    const warrantyDays = input.warrantyDays ?? 0;
    if (!Number.isInteger(warrantyDays) || warrantyDays < 0) throw new Error("Warranty days must be a non-negative integer.");
    if (input.customerId) this.crm.getPartyOrThrow(actor.tenantId, input.customerId, "customer");

    const list = this.orders.get(actor.tenantId) ?? [];
    const ticketNumber = `REP-${String(list.length + 1).padStart(4, "0")}`;
    const order: RepairOrder = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, ticketNumber, customerId: input.customerId,
      customerName, phone: input.phone?.trim() || undefined, deviceModel, imei: input.imei?.trim() || undefined,
      issueDescription, warrantyDays, currency: input.currency, serviceFeeMinor: input.serviceFeeMinor,
      parts: Object.freeze([]), totalPartsCostMinor: 0n, status: "received",
      createdBy: actor.userId, createdAt: new Date().toISOString(),
    });
    list.unshift(order);
    this.orders.set(actor.tenantId, list);
    return order;
  }

  markRepairCompleted(actor: TenantContext, orderId: string): RepairOrder {
    if (!hasPermission(actor.role, "operations.write")) throw new Error(`Permission denied: "${actor.role}" lacks "operations.write".`);
    const list = this.orders.get(actor.tenantId) ?? [];
    const idx = list.findIndex((o) => o.id === orderId);
    if (idx < 0) throw new Error(`Repair order ${orderId} not found.`);
    if (list[idx].status !== "received") throw new Error(`Repair order ${list[idx].ticketNumber} cannot be completed from "${list[idx].status}".`);
    const updated: RepairOrder = Object.freeze({ ...list[idx], status: "completed" });
    list[idx] = updated;
    return updated;
  }

  deliverRepairOrder(
    actor: TenantContext,
    input: Readonly<{
      orderId: string; idempotencyKey: string; businessDate: string;
      paymentMode: "cash" | "credit"; cashboxId?: string; parts?: readonly RepairPartInput[];
    }>,
  ): RepairOrder {
    const canPostFinance = hasPermission(actor.role, "finance.post");
    const canSell = hasPermission(actor.role, "sales.write");
    if (!canPostFinance && !canSell) throw new Error(`Permission denied: role "${actor.role}" cannot settle/deliver repair orders.`);

    const list = this.orders.get(actor.tenantId) ?? [];
    const idx = list.findIndex((o) => o.id === input.orderId);
    if (idx < 0) throw new Error(`Repair order ${input.orderId} not found.`);
    const orig = list[idx];
    if (orig.status === "delivered") return orig;
    if (orig.status === "reversed") throw new Error(`Repair order ${orig.ticketNumber} is reversed.`);
    if (input.paymentMode === "cash" && !input.cashboxId) throw new Error("Cash repair settlement requires cashboxId.");
    if (input.paymentMode === "credit" && !orig.customerId) throw new Error("Credit repair delivery requires a linked customer.");

    const partsUsed: RepairPartUsed[] = [];
    let totalPartsCostMinor = 0n;
    for (const part of input.parts ?? []) {
      if (!Number.isInteger(part.quantity) || part.quantity <= 0) throw new Error("Spare part quantity must be positive.");
      const product = this.inventory.getProductInternal(actor.tenantId, part.productId);
      if (product.currency !== orig.currency) throw new Error(`Currency mismatch for spare part "${product.name}".`);
      const available = this.inventory.getStockQuantity(actor.tenantId, part.warehouseId, product.id);
      if (available < part.quantity) throw new Error(`Insufficient spare part stock for "${product.name}" (available: ${available}).`);
      const lineCost = product.costMinor * BigInt(part.quantity);
      totalPartsCostMinor += lineCost;
      partsUsed.push(Object.freeze({ warehouseId: part.warehouseId, productId: product.id, productName: product.name, quantity: part.quantity, unitCostMinor: product.costMinor, totalCostMinor: lineCost }));
    }

    const debitLine = input.paymentMode === "cash"
      ? { accountId: this.accounting.getCashbox(actor, input.cashboxId!).ledgerAccountId, debitMinor: orig.serviceFeeMinor, creditMinor: 0n, description: `أجرة صيانة ${orig.deviceModel}` }
      : { accountCode: STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, debitMinor: orig.serviceFeeMinor, creditMinor: 0n, description: `ذمة صيانة: ${orig.customerName}` };

    const lines: Array<{ accountCode?: string; accountId?: string; debitMinor: bigint; creditMinor: bigint; description?: string }> = [
      debitLine,
      { accountCode: STANDARD_ACCOUNT_CODES.SERVICE_REVENUE, debitMinor: 0n, creditMinor: orig.serviceFeeMinor, description: `إيراد صيانة ${orig.ticketNumber}` },
    ];
    if (totalPartsCostMinor > 0n) {
      lines.push(
        { accountCode: STANDARD_ACCOUNT_CODES.COGS, debitMinor: totalPartsCostMinor, creditMinor: 0n, description: "تكلفة قطع غيار صيانة" },
        { accountCode: STANDARD_ACCOUNT_CODES.INVENTORY, debitMinor: 0n, creditMinor: totalPartsCostMinor, description: "صرف قطع غيار" },
      );
    }

    const je = this.accounting.postModuleJournal(actor, {
      idempotencyKey: input.idempotencyKey, businessDate: input.businessDate, entryPrefix: "RP", currency: orig.currency,
      memo: `تسليم صيانة ${orig.ticketNumber}: ${orig.deviceModel} (${orig.customerName})`,
      requiredPermission: canPostFinance ? "finance.post" : "sales.write", lines,
    });

    for (const part of partsUsed) {
      this.inventory.deductStock(actor, {
        warehouseId: part.warehouseId, productId: part.productId, quantity: part.quantity,
        movementType: "REPAIR_PART", referenceId: orig.id, journalEntryId: je.id, notes: `قطعة صيانة ${orig.ticketNumber}`,
      });
    }
    if (input.paymentMode === "credit" && orig.customerId) {
      this.crm.recordSubledgerEntry({
        tenantId: actor.tenantId, partyId: orig.customerId, currency: orig.currency,
        deltaMinor: orig.serviceFeeMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: `أجرة صيانة آجلة ${orig.ticketNumber}`,
      });
    }

    const updated: RepairOrder = Object.freeze({
      ...orig, parts: Object.freeze(partsUsed), totalPartsCostMinor, status: "delivered", paymentMode: input.paymentMode, journalEntryId: je.id,
    });
    list[idx] = updated;
    return updated;
  }

  reverseDeliveredRepair(actor: TenantContext, orderId: string, idempotencyKey: string, businessDate: string): RepairOrder {
    const list = this.orders.get(actor.tenantId) ?? [];
    const idx = list.findIndex((o) => o.id === orderId);
    if (idx < 0) throw new Error(`Repair order ${orderId} not found.`);
    const orig = list[idx];
    if (orig.status !== "delivered" || !orig.journalEntryId) throw new Error(`Only delivered repairs can be reversed (current: ${orig.status}).`);

    this.inventory.assertCanReverseMovementsForJournal(actor.tenantId, orig.journalEntryId);
    const revJournal = this.accounting.reverseEntry(actor, orig.journalEntryId, idempotencyKey, businessDate);
    this.inventory.reverseMovementsForJournal(actor, orig.journalEntryId, revJournal.id);
    if (orig.paymentMode === "credit" && orig.customerId) {
      this.crm.reverseSubledgerEntriesForJournal(actor.tenantId, orig.journalEntryId, revJournal.id, businessDate);
    }

    const updated: RepairOrder = Object.freeze({ ...orig, status: "reversed", reversalJournalId: revJournal.id });
    list[idx] = updated;
    return updated;
  }

  listOrders(actor: TenantContext): readonly RepairOrder[] {
    if (!hasPermission(actor.role, "operations.read")) throw new Error(`Permission denied: "${actor.role}" lacks "operations.read".`);
    return Object.freeze([...(this.orders.get(actor.tenantId) ?? [])]);
  }
}
