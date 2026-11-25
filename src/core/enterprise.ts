import { createMoney, subtractMoney, type Money } from "./money";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function generateHiddenUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("Cryptographic UUID generation is unavailable.");
}

export function assertValidHiddenUuid(uuid: string): void {
  if (!UUID_V4_PATTERN.test(uuid)) {
    throw new Error("Hidden entity UUID must be a valid RFC-4122 v4 UUID.");
  }
}

export class IdempotencyGuard {
  private readonly committed = new Set<string>();

  claim(hiddenUuid: string): void {
    assertValidHiddenUuid(hiddenUuid);
    if (this.committed.has(hiddenUuid)) {
      throw new Error(`Duplicate operation blocked for hidden UUID ${hiddenUuid}.`);
    }
    this.committed.add(hiddenUuid);
  }

  has(hiddenUuid: string): boolean {
    return this.committed.has(hiddenUuid);
  }
}

export type HiddenInventoryItem = Readonly<{
  hiddenUuid: string;
  tenantId: string;
  warehouseId: string;
  name: string;
  sku?: string;
  costMinor: bigint;
  saleMinor: bigint;
  currency: string;
  quantity: number;
  minStock: number;
}>;

export function createInventoryItem(input: {
  tenantId: string;
  warehouseId?: string;
  name: string;
  sku?: string;
  costMinor: bigint;
  saleMinor: bigint;
  currency: string;
  quantity: number;
  minStock?: number;
  hiddenUuid?: string;
}): HiddenInventoryItem {
  const hiddenUuid = input.hiddenUuid ?? generateHiddenUuid();
  assertValidHiddenUuid(hiddenUuid);
  if (!input.tenantId.trim()) throw new Error("Inventory item requires a tenant.");
  if (!input.name.trim()) throw new Error("Inventory item requires a name.");
  if (input.costMinor < 0n || input.saleMinor < 0n) {
    throw new Error("Inventory cost and sale prices cannot be negative.");
  }
  if (!Number.isInteger(input.quantity) || input.quantity < 0) {
    throw new Error("Inventory quantity must be a non-negative integer.");
  }
  const minStock = input.minStock ?? 0;
  if (!Number.isInteger(minStock) || minStock < 0) {
    throw new Error("Minimum stock threshold must be a non-negative integer.");
  }
  const normalizedCurrency = createMoney(input.saleMinor, input.currency).currency;
  return Object.freeze({
    hiddenUuid,
    tenantId: input.tenantId.trim(),
    warehouseId: (input.warehouseId ?? "wh-main").trim() || "wh-main",
    name: input.name.trim(),
    sku: input.sku?.trim() || undefined,
    costMinor: input.costMinor,
    saleMinor: input.saleMinor,
    currency: normalizedCurrency,
    quantity: input.quantity,
    minStock,
  });
}

export function calculateUnitProfit(item: HiddenInventoryItem): Money {
  return subtractMoney(
    createMoney(item.saleMinor, item.currency),
    createMoney(item.costMinor, item.currency),
  );
}

export type StockTransferResult = Readonly<{
  sourceItem: HiddenInventoryItem;
  destinationItem: HiddenInventoryItem;
  transferUuid: string;
  quantityMoved: number;
}>;

/** Multi-warehouse stock transfer without losing hidden UUID traceability. */
export function transferWarehouseStock(
  source: HiddenInventoryItem,
  destinationWarehouseId: string,
  quantity: number,
): StockTransferResult {
  const destWh = destinationWarehouseId.trim();
  if (!destWh) throw new Error("Destination warehouse is required.");
  if (destWh === source.warehouseId) throw new Error("Destination warehouse must differ from source warehouse.");
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Transfer quantity must be a positive integer.");
  if (quantity > source.quantity) throw new Error("Insufficient stock in source warehouse.");

  const sourceItem = Object.freeze({ ...source, quantity: source.quantity - quantity });
  const destinationItem = createInventoryItem({
    tenantId: source.tenantId,
    warehouseId: destWh,
    name: source.name,
    sku: source.sku,
    costMinor: source.costMinor,
    saleMinor: source.saleMinor,
    currency: source.currency,
    quantity,
    minStock: source.minStock,
  });

  return Object.freeze({
    sourceItem,
    destinationItem,
    transferUuid: generateHiddenUuid(),
    quantityMoved: quantity,
  });
}

export type DamagedStockResult = Readonly<{
  updatedItem: HiddenInventoryItem;
  lossMinor: bigint;
  currency: string;
  eventUuid: string;
}>;

/** Records damaged/expired stock write-off and computes exact BigInt cost loss. */
export function recordDamagedStock(
  item: HiddenInventoryItem,
  damagedQuantity: number,
): DamagedStockResult {
  if (!Number.isInteger(damagedQuantity) || damagedQuantity <= 0) {
    throw new Error("Damaged quantity must be a positive integer.");
  }
  if (damagedQuantity > item.quantity) {
    throw new Error("Damaged quantity exceeds available stock.");
  }
  const updatedItem = Object.freeze({ ...item, quantity: item.quantity - damagedQuantity });
  const lossMinor = item.costMinor * BigInt(damagedQuantity);
  return Object.freeze({
    updatedItem,
    lossMinor,
    currency: item.currency,
    eventUuid: generateHiddenUuid(),
  });
}

export type CashboxReconciliation = Readonly<{
  currency: string;
  bookBalanceMinor: bigint;
  countedBalanceMinor: bigint;
  varianceMinor: bigint;
  status: "matched" | "surplus" | "shortage";
}>;

export function reconcileCashbox(
  bookBalance: Money,
  countedBalance: Money,
): CashboxReconciliation {
  const variance = subtractMoney(countedBalance, bookBalance);
  const status: CashboxReconciliation["status"] =
    variance.amountMinor === 0n
      ? "matched"
      : variance.amountMinor > 0n
        ? "surplus"
        : "shortage";

  return Object.freeze({
    currency: variance.currency,
    bookBalanceMinor: bookBalance.amountMinor,
    countedBalanceMinor: countedBalance.amountMinor,
    varianceMinor: variance.amountMinor,
    status,
  });
}

export type FxConversionResult = Readonly<{
  fromCurrency: string;
  toCurrency: string;
  sourceMinor: bigint;
  convertedMinor: bigint;
  referenceConvertedMinor: bigint;
  fxGainLossMinor: bigint;
  conversionUuid: string;
}>;

/**
 * Exact IAS 21 multi-currency conversion using BigInt scaled rates (rateScale = 10000n).
 * Positive fxGainLossMinor indicates realized FX gain relative to reference rate.
 */
export function calculateFxConversion(input: {
  sourceAmount: Money;
  toCurrency: string;
  appliedRateScaled: bigint;
  referenceRateScaled: bigint;
  rateScale?: bigint;
}): FxConversionResult {
  const toCurrency = input.toCurrency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(toCurrency)) throw new Error("Target currency must be a 3-letter code.");
  if (toCurrency === input.sourceAmount.currency) throw new Error("FX conversion requires two distinct currencies.");
  if (input.sourceAmount.amountMinor <= 0n) throw new Error("FX source amount must be positive.");
  if (input.appliedRateScaled <= 0n || input.referenceRateScaled <= 0n) {
    throw new Error("FX rates must be positive.");
  }
  const scale = input.rateScale ?? 10000n;
  const convertedMinor = (input.sourceAmount.amountMinor * input.appliedRateScaled) / scale;
  const referenceConvertedMinor = (input.sourceAmount.amountMinor * input.referenceRateScaled) / scale;
  const fxGainLossMinor = convertedMinor - referenceConvertedMinor;

  return Object.freeze({
    fromCurrency: input.sourceAmount.currency,
    toCurrency,
    sourceMinor: input.sourceAmount.amountMinor,
    convertedMinor,
    referenceConvertedMinor,
    fxGainLossMinor,
    conversionUuid: generateHiddenUuid(),
  });
}

export type IncomeStatement = Readonly<{
  currency: string;
  revenueMinor: bigint;
  cogsMinor: bigint;
  grossProfitMinor: bigint;
  operatingExpensesMinor: bigint;
  fxGainLossMinor: bigint;
  netProfitMinor: bigint;
}>;

/** IFRS-aligned Income Statement calculation using exact BigInt arithmetic. */
export function computeIncomeStatement(input: {
  currency: string;
  revenueMinor: bigint;
  cogsMinor: bigint;
  operatingExpensesMinor: bigint;
  fxGainLossMinor?: bigint;
}): IncomeStatement {
  const currency = createMoney(input.revenueMinor, input.currency).currency;
  const fx = input.fxGainLossMinor ?? 0n;
  const grossProfitMinor = input.revenueMinor - input.cogsMinor;
  const netProfitMinor = grossProfitMinor - input.operatingExpensesMinor + fx;

  return Object.freeze({
    currency,
    revenueMinor: input.revenueMinor,
    cogsMinor: input.cogsMinor,
    grossProfitMinor,
    operatingExpensesMinor: input.operatingExpensesMinor,
    fxGainLossMinor: fx,
    netProfitMinor,
  });
}

export type DebtItem = Readonly<{
  id: string;
  outstandingMinor: bigint;
  currency: string;
  issuedAtIso: string;
}>;

export type DebtAgingBuckets = Readonly<{
  currency: string;
  days0To30Minor: bigint;
  days31To60Minor: bigint;
  days61To90Minor: bigint;
  daysOver90Minor: bigint;
  totalMinor: bigint;
}>;

/** AR/AP Debt Aging breakdown into standard IFRS/GAAP aging buckets. */
export function computeDebtAging(
  debts: readonly DebtItem[],
  currency: string,
  asOfIso: string,
): DebtAgingBuckets {
  const normCur = currency.trim().toUpperCase();
  const asOfMs = Date.parse(asOfIso);
  if (!Number.isFinite(asOfMs)) throw new Error("asOfIso must be a valid ISO timestamp.");

  let days0To30Minor = 0n;
  let days31To60Minor = 0n;
  let days61To90Minor = 0n;
  let daysOver90Minor = 0n;

  for (const d of debts) {
    if (d.currency.toUpperCase() !== normCur || d.outstandingMinor <= 0n) continue;
    const issuedMs = Date.parse(d.issuedAtIso);
    if (!Number.isFinite(issuedMs)) continue;
    const ageDays = Math.max(0, Math.floor((asOfMs - issuedMs) / 86400000));
    if (ageDays <= 30) days0To30Minor += d.outstandingMinor;
    else if (ageDays <= 60) days31To60Minor += d.outstandingMinor;
    else if (ageDays <= 90) days61To90Minor += d.outstandingMinor;
    else daysOver90Minor += d.outstandingMinor;
  }

  const totalMinor = days0To30Minor + days31To60Minor + days61To90Minor + daysOver90Minor;
  return Object.freeze({
    currency: normCur,
    days0To30Minor,
    days31To60Minor,
    days61To90Minor,
    daysOver90Minor,
    totalMinor,
  });
}

export function normalizeArabicDigits(text: string): string {
  const map: Record<string, string> = {
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
    "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
    "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
    "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  };
  return text.replace(/[٠-٩۰-۹]/g, (ch) => map[ch] ?? ch);
}
