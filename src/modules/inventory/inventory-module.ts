import { generateHiddenUuid } from "../../core/enterprise";
import { STANDARD_ACCOUNT_CODES } from "../../core/finance";
import { hasPermission } from "../../core/permissions";
import type { TenantContext, TenantRole } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";

export type Warehouse = Readonly<{ id: string; tenantId: string; code: string; name: string; isActive: boolean }>;

export type Product = Readonly<{
  id: string; tenantId: string; sku?: string; barcode?: string; name: string;
  currency: "USD" | "SYP"; costMinor: bigint; saleMinor: bigint; minStock: number; isActive: boolean;
}>;

export type MaskedProductView = Omit<Product, "costMinor"> & Readonly<{ costMinor: bigint | null }>;

export type StockMovementType =
  | "PURCHASE" | "SALE" | "SALES_RETURN" | "TRANSFER_OUT" | "TRANSFER_IN" | "DAMAGED" | "REPAIR_PART" | "REVERSAL";

export type StockMovement = Readonly<{
  id: string; tenantId: string; warehouseId: string; productId: string; type: StockMovementType;
  qtyDelta: number; unitCostMinor: bigint; currency: "USD" | "SYP";
  referenceId?: string; journalEntryId?: string; notes: string; createdBy: string; createdAt: string;
}>;

export type DamagedWriteOffResult = Readonly<{
  movement: StockMovement; journalEntryId: string | null; lossMinor: bigint; remainingQuantity: number;
}>;

export function canRoleViewCost(role: TenantRole): boolean {
  return hasPermission(role, "finance.post") || hasPermission(role, "procurement.write") || hasPermission(role, "audit.read");
}

export class InventoryModuleService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly warehouses = new Map<string, Warehouse[]>();
  private readonly products = new Map<string, Product[]>();
  private readonly stockQty = new Map<string, number>();
  private readonly movements = new Map<string, StockMovement[]>();

  constructor(accounting: AccountingWorkspaceService) {
    this.accounting = accounting;
  }

  private stockKey(tenantId: string, warehouseId: string, productId: string): string {
    return `${tenantId}::${warehouseId}::${productId}`;
  }

  private assertTenantWarehouse(tenantId: string, warehouseId: string): Warehouse {
    const wh = (this.warehouses.get(tenantId) ?? []).find((w) => w.id === warehouseId);
    if (!wh || !wh.isActive) throw new Error(`Active warehouse ${warehouseId} not found.`);
    return wh;
  }

  private assertTenantProduct(tenantId: string, productId: string): Product {
    const prod = (this.products.get(tenantId) ?? []).find((p) => p.id === productId);
    if (!prod || !prod.isActive) throw new Error(`Active product ${productId} not found.`);
    return prod;
  }

  createWarehouse(actor: TenantContext, input: Readonly<{ id?: string; code: string; name: string }>): Warehouse {
    if (!hasPermission(actor.role, "inventory.write")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.write".`);
    const code = input.code.trim().toUpperCase();
    const name = input.name.trim();
    if (!code || !name) throw new Error("Warehouse code and name are required.");
    const list = this.warehouses.get(actor.tenantId) ?? [];
    if (list.some((w) => w.code === code)) throw new Error(`Warehouse code ${code} already exists.`);
    const wh: Warehouse = Object.freeze({ id: input.id?.trim() || generateHiddenUuid(), tenantId: actor.tenantId, code, name, isActive: true });
    list.push(wh);
    this.warehouses.set(actor.tenantId, list);
    return wh;
  }

  listWarehouses(actor: TenantContext): readonly Warehouse[] {
    if (!hasPermission(actor.role, "inventory.read")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.read".`);
    return Object.freeze([...(this.warehouses.get(actor.tenantId) ?? [])]);
  }

  createProduct(
    actor: TenantContext,
    input: Readonly<{ id?: string; sku?: string; barcode?: string; name: string; currency: "USD" | "SYP"; costMinor: bigint; saleMinor: bigint; minStock?: number }>,
  ): Product {
    if (!hasPermission(actor.role, "inventory.write")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.write".`);
    const name = input.name.trim();
    if (!name) throw new Error("Product name is required.");
    if (input.costMinor < 0n || input.saleMinor < 0n) throw new Error("Product cost and sale price cannot be negative.");
    const minStock = input.minStock ?? 2;
    if (!Number.isInteger(minStock) || minStock < 0) throw new Error("minStock must be a non-negative integer.");

    const list = this.products.get(actor.tenantId) ?? [];
    const product: Product = Object.freeze({
      id: input.id?.trim() || generateHiddenUuid(), tenantId: actor.tenantId,
      sku: input.sku?.trim() || undefined, barcode: input.barcode?.trim() || undefined,
      name, currency: input.currency, costMinor: input.costMinor, saleMinor: input.saleMinor, minStock, isActive: true,
    });
    list.push(product);
    this.products.set(actor.tenantId, list);
    return product;
  }

  listCatalog(actor: TenantContext): readonly MaskedProductView[] {
    if (!hasPermission(actor.role, "inventory.read")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.read".`);
    const allowCost = canRoleViewCost(actor.role);
    return Object.freeze((this.products.get(actor.tenantId) ?? []).map((p) => Object.freeze({ ...p, costMinor: allowCost ? p.costMinor : null })));
  }

  getProductInternal(tenantId: string, productId: string): Product {
    return this.assertTenantProduct(tenantId, productId);
  }

  getStockQuantity(tenantId: string, warehouseId: string, productId: string): number {
    return this.stockQty.get(this.stockKey(tenantId, warehouseId, productId)) ?? 0;
  }

  getTotalStockAcrossWarehouses(tenantId: string, productId: string): number {
    let total = 0;
    for (const wh of this.warehouses.get(tenantId) ?? []) total += this.getStockQuantity(tenantId, wh.id, productId);
    return total;
  }

  listMovements(actor: TenantContext, productId?: string): readonly StockMovement[] {
    if (!hasPermission(actor.role, "inventory.read")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.read".`);
    const all = this.movements.get(actor.tenantId) ?? [];
    return Object.freeze(productId ? all.filter((m) => m.productId === productId) : [...all]);
  }

  receiveStockWithWac(
    actor: TenantContext,
    input: Readonly<{
      warehouseId: string; productId: string; quantity: number; unitCostMinor: bigint;
      movementType: "PURCHASE" | "SALES_RETURN" | "REVERSAL";
      referenceId?: string; journalEntryId?: string; notes?: string; recomputeWac?: boolean;
    }>,
  ): StockMovement {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Incoming stock quantity must be positive.");
    if (input.unitCostMinor < 0n) throw new Error("Incoming unit cost cannot be negative.");
    this.assertTenantWarehouse(actor.tenantId, input.warehouseId);
    const product = this.assertTenantProduct(actor.tenantId, input.productId);

    if (input.recomputeWac) {
      const existingQty = this.getTotalStockAcrossWarehouses(actor.tenantId, product.id);
      const oldVal = BigInt(existingQty) * product.costMinor;
      const newVal = BigInt(input.quantity) * input.unitCostMinor;
      const newTotal = BigInt(existingQty + input.quantity);
      const wacMinor = newTotal > 0n ? (oldVal + newVal) / newTotal : input.unitCostMinor;
      const list = this.products.get(actor.tenantId) ?? [];
      const idx = list.findIndex((p) => p.id === product.id);
      if (idx >= 0) list[idx] = Object.freeze({ ...product, costMinor: wacMinor });
    }

    const key = this.stockKey(actor.tenantId, input.warehouseId, product.id);
    this.stockQty.set(key, (this.stockQty.get(key) ?? 0) + input.quantity);

    const movement: StockMovement = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, warehouseId: input.warehouseId, productId: product.id,
      type: input.movementType, qtyDelta: input.quantity, unitCostMinor: input.unitCostMinor, currency: product.currency,
      referenceId: input.referenceId, journalEntryId: input.journalEntryId,
      notes: input.notes?.trim() || input.movementType, createdBy: actor.userId, createdAt: new Date().toISOString(),
    });
    const list = this.movements.get(actor.tenantId) ?? [];
    list.unshift(movement);
    this.movements.set(actor.tenantId, list);
    return movement;
  }

  deductStock(
    actor: TenantContext,
    input: Readonly<{
      warehouseId: string; productId: string; quantity: number;
      movementType: "SALE" | "DAMAGED" | "REPAIR_PART" | "REVERSAL";
      referenceId?: string; journalEntryId?: string; notes?: string;
    }>,
  ): StockMovement {
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Outgoing stock quantity must be positive.");
    this.assertTenantWarehouse(actor.tenantId, input.warehouseId);
    const product = this.assertTenantProduct(actor.tenantId, input.productId);

    const key = this.stockKey(actor.tenantId, input.warehouseId, product.id);
    const prevQty = this.stockQty.get(key) ?? 0;
    if (prevQty < input.quantity) throw new Error(`Insufficient stock for "${product.name}" (available: ${prevQty}, requested: ${input.quantity}).`);
    this.stockQty.set(key, prevQty - input.quantity);

    const movement: StockMovement = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, warehouseId: input.warehouseId, productId: product.id,
      type: input.movementType, qtyDelta: -input.quantity, unitCostMinor: product.costMinor, currency: product.currency,
      referenceId: input.referenceId, journalEntryId: input.journalEntryId,
      notes: input.notes?.trim() || input.movementType, createdBy: actor.userId, createdAt: new Date().toISOString(),
    });
    const list = this.movements.get(actor.tenantId) ?? [];
    list.unshift(movement);
    this.movements.set(actor.tenantId, list);
    return movement;
  }

  transferBetweenWarehouses(
    actor: TenantContext,
    input: Readonly<{ fromWarehouseId: string; toWarehouseId: string; productId: string; quantity: number; notes?: string }>,
  ): Readonly<{ outMovement: StockMovement; inMovement: StockMovement }> {
    if (!hasPermission(actor.role, "inventory.write")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.write".`);
    if (input.fromWarehouseId === input.toWarehouseId) throw new Error("Source and destination warehouses must differ.");
    const fromWh = this.assertTenantWarehouse(actor.tenantId, input.fromWarehouseId);
    const toWh = this.assertTenantWarehouse(actor.tenantId, input.toWarehouseId);
    const product = this.assertTenantProduct(actor.tenantId, input.productId);
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Transfer quantity must be positive.");

    const fromKey = this.stockKey(actor.tenantId, fromWh.id, product.id);
    const prevFrom = this.stockQty.get(fromKey) ?? 0;
    if (prevFrom < input.quantity) throw new Error(`Insufficient stock in warehouse ${fromWh.code}.`);

    const transferId = generateHiddenUuid();
    const nowIso = new Date().toISOString();
    this.stockQty.set(fromKey, prevFrom - input.quantity);
    const toKey = this.stockKey(actor.tenantId, toWh.id, product.id);
    this.stockQty.set(toKey, (this.stockQty.get(toKey) ?? 0) + input.quantity);

    const outMovement: StockMovement = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, warehouseId: fromWh.id, productId: product.id,
      type: "TRANSFER_OUT", qtyDelta: -input.quantity, unitCostMinor: product.costMinor, currency: product.currency,
      referenceId: transferId, notes: input.notes?.trim() || `تحويل إلى ${toWh.name}`, createdBy: actor.userId, createdAt: nowIso,
    });
    const inMovement: StockMovement = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, warehouseId: toWh.id, productId: product.id,
      type: "TRANSFER_IN", qtyDelta: input.quantity, unitCostMinor: product.costMinor, currency: product.currency,
      referenceId: transferId, notes: input.notes?.trim() || `استلام من ${fromWh.name}`, createdBy: actor.userId, createdAt: nowIso,
    });
    const list = this.movements.get(actor.tenantId) ?? [];
    list.unshift(inMovement, outMovement);
    this.movements.set(actor.tenantId, list);
    return Object.freeze({ outMovement, inMovement });
  }

  recordDamagedStock(
    actor: TenantContext,
    input: Readonly<{ idempotencyKey: string; businessDate: string; warehouseId: string; productId: string; quantity: number; reason: string }>,
  ): DamagedWriteOffResult {
    if (!hasPermission(actor.role, "inventory.write")) throw new Error(`Permission denied: "${actor.role}" lacks "inventory.write".`);
    this.assertTenantWarehouse(actor.tenantId, input.warehouseId);
    const product = this.assertTenantProduct(actor.tenantId, input.productId);
    if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("Damaged quantity must be positive.");
    const available = this.getStockQuantity(actor.tenantId, input.warehouseId, product.id);
    if (available < input.quantity) throw new Error(`Insufficient stock for damaged write-off (available: ${available}).`);

    const lossMinor = product.costMinor * BigInt(input.quantity);
    let journalEntryId: string | null = null;
    if (lossMinor > 0n) {
      const je = this.accounting.postModuleJournal(actor, {
        idempotencyKey: input.idempotencyKey, businessDate: input.businessDate, entryPrefix: "DMG",
        currency: product.currency, memo: `إتلاف مخزون: ${product.name} ×${input.quantity} — ${input.reason.trim() || "تلف"}`,
        requiredPermission: "inventory.write",
        lines: [
          { accountCode: STANDARD_ACCOUNT_CODES.DAMAGED_STOCK_LOSS, debitMinor: lossMinor, creditMinor: 0n, description: input.reason },
          { accountCode: STANDARD_ACCOUNT_CODES.INVENTORY, debitMinor: 0n, creditMinor: lossMinor, description: `تلف ${product.name}` },
        ],
      });
      journalEntryId = je.id;
    }

    const movement = this.deductStock(actor, {
      warehouseId: input.warehouseId, productId: product.id, quantity: input.quantity,
      movementType: "DAMAGED", journalEntryId: journalEntryId ?? undefined, notes: input.reason,
    });
    return Object.freeze({ movement, journalEntryId, lossMinor, remainingQuantity: this.getStockQuantity(actor.tenantId, input.warehouseId, product.id) });
  }

  assertCanReverseMovementsForJournal(tenantId: string, originalJournalId: string): void {
    const linked = (this.movements.get(tenantId) ?? []).filter((m) => m.journalEntryId === originalJournalId && m.type !== "REVERSAL");
    for (const mv of linked) {
      const undoDelta = -mv.qtyDelta;
      if (undoDelta < 0) {
        const curQty = this.getStockQuantity(tenantId, mv.warehouseId, mv.productId);
        if (curQty + undoDelta < 0) throw new Error(`Insufficient stock to reverse movement ${mv.id} (available: ${curQty}, needed: ${-undoDelta}).`);
      }
    }
  }

  reverseMovementsForJournal(actor: TenantContext, originalJournalId: string, reversalJournalId: string): readonly StockMovement[] {
    this.assertCanReverseMovementsForJournal(actor.tenantId, originalJournalId);
    const linked = (this.movements.get(actor.tenantId) ?? []).filter((m) => m.journalEntryId === originalJournalId && m.type !== "REVERSAL");
    const reversed: StockMovement[] = [];
    for (const mv of linked) {
      const undoDelta = -mv.qtyDelta;
      if (undoDelta > 0) {
        reversed.push(this.receiveStockWithWac(actor, {
          warehouseId: mv.warehouseId, productId: mv.productId, quantity: undoDelta, unitCostMinor: mv.unitCostMinor,
          movementType: "REVERSAL", referenceId: mv.id, journalEntryId: reversalJournalId, notes: `عكس حركة (${mv.type})`, recomputeWac: false,
        }));
      } else if (undoDelta < 0) {
        reversed.push(this.deductStock(actor, {
          warehouseId: mv.warehouseId, productId: mv.productId, quantity: -undoDelta,
          movementType: "REVERSAL", referenceId: mv.id, journalEntryId: reversalJournalId, notes: `عكس حركة (${mv.type})`,
        }));
      }
    }
    return Object.freeze(reversed);
  }
}
