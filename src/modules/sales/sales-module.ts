import { generateHiddenUuid } from "../../core/enterprise";
import { STANDARD_ACCOUNT_CODES } from "../../core/finance";
import { hasPermission } from "../../core/permissions";
import type { TenantContext } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";
import type { CrmDebtModuleService } from "../crm";
import type { InventoryModuleService } from "../inventory";

export type SaleInvoiceItemInput = Readonly<{ productId: string; quantity: number; unitSaleMinorOverride?: bigint }>;

export type SaleInvoiceLine = Readonly<{
  productId: string; productName: string; quantity: number;
  unitSaleMinor: bigint; unitCostMinor: bigint; lineTotalMinor: bigint; lineCogsMinor: bigint;
}>;

export type SaleInvoice = Readonly<{
  id: string; tenantId: string; invoiceNumber: string; businessDate: string;
  paymentMode: "cash" | "credit"; currency: "USD" | "SYP"; warehouseId: string;
  cashboxId?: string; customerId?: string; lines: readonly SaleInvoiceLine[];
  totalMinor: bigint; totalCogsMinor: bigint; journalEntryId: string;
  status: "posted" | "reversed"; reversalJournalId?: string;
}>;

export type SalesReturnRecord = Readonly<{
  id: string; tenantId: string; businessDate: string; warehouseId: string; productId: string;
  quantity: number; refundMode: "cash" | "credit"; currency: "USD" | "SYP";
  refundMinor: bigint; cogsRestoredMinor: bigint; journalEntryId: string;
}>;

export class SalesModuleService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly inventory: InventoryModuleService;
  private readonly crm: CrmDebtModuleService;
  private readonly invoices = new Map<string, SaleInvoice[]>();
  private readonly invoiceByIdem = new Map<string, string>();
  private readonly returns = new Map<string, SalesReturnRecord[]>();

  constructor(accounting: AccountingWorkspaceService, inventory: InventoryModuleService, crm: CrmDebtModuleService) {
    this.accounting = accounting;
    this.inventory = inventory;
    this.crm = crm;
  }

  postSaleInvoice(
    actor: TenantContext,
    input: Readonly<{
      idempotencyKey: string; businessDate: string; paymentMode: "cash" | "credit"; currency: "USD" | "SYP";
      warehouseId: string; cashboxId?: string; customerId?: string; items: readonly SaleInvoiceItemInput[]; memo?: string;
    }>,
  ): SaleInvoice {
    if (!hasPermission(actor.role, "sales.write")) throw new Error(`Permission denied: "${actor.role}" lacks "sales.write".`);
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required for sale invoices.");

    const existingId = this.invoiceByIdem.get(`${actor.tenantId}::${cleanKey}`);
    if (existingId) {
      const found = (this.invoices.get(actor.tenantId) ?? []).find((inv) => inv.id === existingId);
      if (found) return found;
    }

    if (input.items.length === 0) throw new Error("Sale invoice requires at least one item.");
    if (input.paymentMode === "credit" && !input.customerId) throw new Error("Credit sales MUST be linked to a registered customer.");
    if (input.paymentMode === "cash" && !input.cashboxId) throw new Error("Cash sales require a target cashboxId.");

    const customer = input.customerId ? this.crm.getPartyOrThrow(actor.tenantId, input.customerId, "customer") : undefined;

    const computedLines: SaleInvoiceLine[] = [];
    let totalMinor = 0n;
    let totalCogsMinor = 0n;
    for (const item of input.items) {
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) throw new Error("Item quantity must be positive.");
      const product = this.inventory.getProductInternal(actor.tenantId, item.productId);
      if (product.currency !== input.currency) throw new Error(`Currency mismatch for "${product.name}".`);
      const available = this.inventory.getStockQuantity(actor.tenantId, input.warehouseId, product.id);
      if (available < item.quantity) throw new Error(`Insufficient stock for "${product.name}" (available: ${available}, requested: ${item.quantity}).`);
      const unitSale = item.unitSaleMinorOverride ?? product.saleMinor;
      if (unitSale <= 0n) throw new Error(`Sale price for "${product.name}" must be positive.`);
      const lineTotal = unitSale * BigInt(item.quantity);
      const lineCogs = product.costMinor * BigInt(item.quantity);
      totalMinor += lineTotal;
      totalCogsMinor += lineCogs;
      computedLines.push(Object.freeze({ productId: product.id, productName: product.name, quantity: item.quantity, unitSaleMinor: unitSale, unitCostMinor: product.costMinor, lineTotalMinor: lineTotal, lineCogsMinor: lineCogs }));
    }

    const debitLine = input.paymentMode === "cash"
      ? { accountId: this.accounting.getCashbox(actor, input.cashboxId!).ledgerAccountId, debitMinor: totalMinor, creditMinor: 0n, description: "مقبوضات بيع نقدي" }
      : { accountCode: STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, debitMinor: totalMinor, creditMinor: 0n, description: `ذمة عميل: ${customer!.name}` };

    const journalLines: Array<{ accountCode?: string; accountId?: string; debitMinor: bigint; creditMinor: bigint; description?: string }> = [
      debitLine,
      { accountCode: STANDARD_ACCOUNT_CODES.SALES_REVENUE, debitMinor: 0n, creditMinor: totalMinor, description: "إيرادات مبيعات" },
    ];
    if (totalCogsMinor > 0n) {
      journalLines.push(
        { accountCode: STANDARD_ACCOUNT_CODES.COGS, debitMinor: totalCogsMinor, creditMinor: 0n, description: "تكلفة البضاعة المباعة" },
        { accountCode: STANDARD_ACCOUNT_CODES.INVENTORY, debitMinor: 0n, creditMinor: totalCogsMinor, description: "تخفيض المخزون" },
      );
    }

    const invoiceId = generateHiddenUuid();
    const list = this.invoices.get(actor.tenantId) ?? [];
    const invoiceNumber = `INV-${String(list.length + 1).padStart(4, "0")}`;

    const je = this.accounting.postModuleJournal(actor, {
      idempotencyKey: cleanKey, businessDate: input.businessDate, entryPrefix: "SL", currency: input.currency,
      memo: input.memo?.trim() || `فاتورة مبيعات ${invoiceNumber} (${input.paymentMode === "cash" ? "نقدي" : "آجل"})`,
      requiredPermission: "sales.write", lines: journalLines,
    });

    for (const line of computedLines) {
      this.inventory.deductStock(actor, {
        warehouseId: input.warehouseId, productId: line.productId, quantity: line.quantity,
        movementType: "SALE", referenceId: invoiceId, journalEntryId: je.id, notes: `بيع ${invoiceNumber}`,
      });
    }

    if (input.paymentMode === "credit" && customer) {
      this.crm.recordSubledgerEntry({
        tenantId: actor.tenantId, partyId: customer.id, currency: input.currency,
        deltaMinor: totalMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: `فاتورة بيع آجل ${invoiceNumber}`,
      });
    }

    const invoice: SaleInvoice = Object.freeze({
      id: invoiceId, tenantId: actor.tenantId, invoiceNumber, businessDate: input.businessDate,
      paymentMode: input.paymentMode, currency: input.currency, warehouseId: input.warehouseId,
      cashboxId: input.cashboxId, customerId: input.customerId, lines: Object.freeze(computedLines),
      totalMinor, totalCogsMinor, journalEntryId: je.id, status: "posted",
    });
    list.unshift(invoice);
    this.invoices.set(actor.tenantId, list);
    this.invoiceByIdem.set(`${actor.tenantId}::${cleanKey}`, invoice.id);
    return invoice;
  }

  postSalesReturn(
    actor: TenantContext,
    input: Readonly<{
      idempotencyKey: string; businessDate: string; warehouseId: string; productId: string;
      quantity: number; refundMode: "cash" | "credit"; cashboxId?: string; customerId?: string; reason?: string;
    }>,
  ): SalesReturnRecord {
    if (!hasPermission(actor.role, "sales.write")) throw new Error(`Permission denied: "${actor.role}" lacks "sales.write".`);
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Return quantity must be positive.");
    if (input.refundMode === "credit" && !input.customerId) throw new Error("Credit sales return requires a customerId.");
    if (input.refundMode === "cash" && !input.cashboxId) throw new Error("Cash sales return requires a cashboxId.");

    const product = this.inventory.getProductInternal(actor.tenantId, input.productId);
    const customer = input.customerId ? this.crm.getPartyOrThrow(actor.tenantId, input.customerId, "customer") : undefined;
    const refundMinor = product.saleMinor * BigInt(input.quantity);
    const cogsRestoredMinor = product.costMinor * BigInt(input.quantity);

    const creditLine = input.refundMode === "cash"
      ? { accountId: this.accounting.getCashbox(actor, input.cashboxId!).ledgerAccountId, debitMinor: 0n, creditMinor: refundMinor, description: "رد نقدي لمرتجع" }
      : { accountCode: STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, debitMinor: 0n, creditMinor: refundMinor, description: `تخفيض ذمة ${customer!.name}` };

    const lines: Array<{ accountCode?: string; accountId?: string; debitMinor: bigint; creditMinor: bigint; description?: string }> = [
      { accountCode: STANDARD_ACCOUNT_CODES.SALES_RETURNS, debitMinor: refundMinor, creditMinor: 0n, description: "مردودات مبيعات" },
      creditLine,
    ];
    if (cogsRestoredMinor > 0n) {
      lines.push(
        { accountCode: STANDARD_ACCOUNT_CODES.INVENTORY, debitMinor: cogsRestoredMinor, creditMinor: 0n, description: "إعادة للمخزون" },
        { accountCode: STANDARD_ACCOUNT_CODES.COGS, debitMinor: 0n, creditMinor: cogsRestoredMinor, description: "عكس COGS" },
      );
    }

    const je = this.accounting.postModuleJournal(actor, {
      idempotencyKey: input.idempotencyKey, businessDate: input.businessDate, entryPrefix: "SR", currency: product.currency,
      memo: `مرتجع مبيعات: ${product.name} ×${input.quantity} — ${input.reason?.trim() || "مرتجع"}`,
      requiredPermission: "sales.write", lines,
    });

    this.inventory.receiveStockWithWac(actor, {
      warehouseId: input.warehouseId, productId: product.id, quantity: input.quantity, unitCostMinor: product.costMinor,
      movementType: "SALES_RETURN", journalEntryId: je.id, notes: input.reason || "مرتجع مبيعات", recomputeWac: false,
    });

    if (input.refundMode === "credit" && customer) {
      this.crm.recordSubledgerEntry({
        tenantId: actor.tenantId, partyId: customer.id, currency: product.currency,
        deltaMinor: -refundMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: je.memo,
      });
    }

    const record: SalesReturnRecord = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, businessDate: input.businessDate,
      warehouseId: input.warehouseId, productId: product.id, quantity: input.quantity,
      refundMode: input.refundMode, currency: product.currency, refundMinor, cogsRestoredMinor, journalEntryId: je.id,
    });
    const list = this.returns.get(actor.tenantId) ?? [];
    list.unshift(record);
    this.returns.set(actor.tenantId, list);
    return record;
  }

  reverseSaleInvoice(actor: TenantContext, invoiceId: string, idempotencyKey: string, businessDate: string): SaleInvoice {
    const list = this.invoices.get(actor.tenantId) ?? [];
    const idx = list.findIndex((inv) => inv.id === invoiceId);
    if (idx < 0) throw new Error(`Sale invoice ${invoiceId} not found.`);
    const orig = list[idx];
    if (orig.status === "reversed") throw new Error(`Sale invoice ${orig.invoiceNumber} is already reversed.`);

    this.inventory.assertCanReverseMovementsForJournal(actor.tenantId, orig.journalEntryId);
    const revJournal = this.accounting.reverseEntry(actor, orig.journalEntryId, idempotencyKey, businessDate);
    this.inventory.reverseMovementsForJournal(actor, orig.journalEntryId, revJournal.id);
    if (orig.paymentMode === "credit" && orig.customerId) {
      this.crm.reverseSubledgerEntriesForJournal(actor.tenantId, orig.journalEntryId, revJournal.id, businessDate);
    }

    const updated: SaleInvoice = Object.freeze({ ...orig, status: "reversed", reversalJournalId: revJournal.id });
    list[idx] = updated;
    return updated;
  }

  listInvoices(actor: TenantContext): readonly SaleInvoice[] {
    if (!hasPermission(actor.role, "sales.read")) throw new Error(`Permission denied: "${actor.role}" lacks "sales.read".`);
    return Object.freeze([...(this.invoices.get(actor.tenantId) ?? [])]);
  }
}
