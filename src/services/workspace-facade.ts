import { generateHiddenUuid } from "../core/enterprise";
import { moneyToDecimalString, parseMoney } from "../core/money";
import type { TenantContext, TenantRole } from "../core/tenant";
import { speakResultAloud } from "../lib/speech";
import { AiCopilotService, type SupportedAiLanguage } from "../modules/ai";
import { CrmDebtModuleService } from "../modules/crm";
import { InventoryModuleService } from "../modules/inventory";
import { OperationsRepairModuleService } from "../modules/operations";
import { ProcurementModuleService } from "../modules/procurement";
import { FinancialReportsModuleService } from "../modules/reports";
import { SalesModuleService } from "../modules/sales";
import { TelecomModuleService } from "../modules/telecom";
import { createSandboxAccountingService, SUPPORTED_CURRENCIES, type AccountingWorkspaceService } from "./accounting-service";
import { OfflineSyncQueueService } from "./offline-sync-service";

export type SamaWorkspace = Readonly<{
  tenantId: string; accounting: AccountingWorkspaceService; inventory: InventoryModuleService;
  crm: CrmDebtModuleService; sales: SalesModuleService; procurement: ProcurementModuleService;
  repairs: OperationsRepairModuleService; telecom: TelecomModuleService; reports: FinancialReportsModuleService;
  ai: AiCopilotService; offline: OfflineSyncQueueService;
  defaultWarehouseId: string; partsWarehouseId: string;
  syriatelWalletId: string; mtnWalletId: string; shamCashWalletId: string;
}>;

export const makeActor = (tenantId: string, role: TenantRole): TenantContext => Object.freeze({ tenantId, userId: `u-${role}`, role });
export const todayIso = (): string => new Date().toISOString().slice(0, 10);
export const newOperationKey = (): string => generateHiddenUuid();
export const speakAloud = (text: string, lang: SupportedAiLanguage): boolean => speakResultAloud(text, lang);

export function formatMinorAmount(amountMinor: bigint, currency: string): string {
  const def = SUPPORTED_CURRENCIES[currency] ?? { code: currency, decimalPlaces: 2 };
  const val = moneyToDecimalString({ amountMinor, currency: def.code }, def.decimalPlaces);
  return def.code === "USD" ? `$${val}` : `${val} ل.س`;
}

export function parseTextToMinor(input: string, currency: "USD" | "SYP"): bigint {
  return parseMoney(input, SUPPORTED_CURRENCIES[currency]).amountMinor;
}

export function createSamaWorkspace(tenantId = "sama-main-shop"): SamaWorkspace {
  const owner = makeActor(tenantId, "owner");
  const accounting = createSandboxAccountingService(tenantId);
  const inventory = new InventoryModuleService(accounting);
  const crm = new CrmDebtModuleService(accounting);
  const sales = new SalesModuleService(accounting, inventory, crm);
  const procurement = new ProcurementModuleService(accounting, inventory, crm);
  const repairs = new OperationsRepairModuleService(accounting, inventory, crm);
  const telecom = new TelecomModuleService(accounting, crm);
  const reports = new FinancialReportsModuleService(accounting);
  const ai = new AiCopilotService(accounting);
  const offline = new OfflineSyncQueueService(accounting);
  const whMain = inventory.createWarehouse(owner, { code: "MAIN", name: "المستودع الرئيسي" });
  const whParts = inventory.createWarehouse(owner, { code: "PARTS", name: "مخزن قطع الصيانة" });
  const syriatel = telecom.registerWallet(owner, { networkCode: "SYRIATEL", label: "محفظة سيريتل", currency: "SYP" });
  const mtn = telecom.registerWallet(owner, { networkCode: "MTN", label: "محفظة MTN", currency: "SYP" });
  const sham = telecom.registerWallet(owner, { networkCode: "SHAMCASH", label: "محفظة شام كاش", currency: "USD" });
  return Object.freeze({
    tenantId, accounting, inventory, crm, sales, procurement, repairs, telecom, reports, ai, offline,
    defaultWarehouseId: whMain.id, partsWarehouseId: whParts.id,
    syriatelWalletId: syriatel.id, mtnWalletId: mtn.id, shamCashWalletId: sham.id,
  });
}
