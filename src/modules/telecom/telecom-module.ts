import { generateHiddenUuid } from "../../core/enterprise";
import { STANDARD_ACCOUNT_CODES } from "../../core/finance";
import { hasPermission } from "../../core/permissions";
import type { TenantContext } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";
import type { CrmDebtModuleService } from "../crm";

export type TelecomWallet = Readonly<{
  id: string; tenantId: string; networkCode: string; label: string; currency: "USD" | "SYP";
  faceBalanceMinor: bigint; costPoolMinor: bigint; isActive: boolean;
}>;

export type TelecomTopupRecord = Readonly<{
  id: string; tenantId: string; walletId: string; networkCode: string; businessDate: string;
  recipientPhone?: string; packageName?: string; faceAmountMinor: bigint; chargedMinor: bigint;
  wacCostMinor: bigint; grossProfitMinor: bigint; currency: "USD" | "SYP";
  paymentMode: "cash" | "credit"; customerId?: string; journalEntryId: string;
  status: "posted" | "reversed"; reversalJournalId?: string;
}>;

export class TelecomModuleService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly crm: CrmDebtModuleService;
  private readonly wallets = new Map<string, TelecomWallet[]>();
  private readonly topups = new Map<string, TelecomTopupRecord[]>();
  private readonly topupByIdem = new Map<string, string>();
  private readonly rechargeIdems = new Set<string>();

  constructor(accounting: AccountingWorkspaceService, crm: CrmDebtModuleService) {
    this.accounting = accounting;
    this.crm = crm;
  }

  registerWallet(actor: TenantContext, input: Readonly<{ id?: string; networkCode: string; label: string; currency: "USD" | "SYP" }>): TelecomWallet {
    if (!hasPermission(actor.role, "settings.manage") && !hasPermission(actor.role, "finance.post")) {
      throw new Error(`Permission denied: "${actor.role}" cannot register telecom wallets.`);
    }
    const networkCode = input.networkCode.trim().toUpperCase();
    const label = input.label.trim();
    if (!networkCode || !label) throw new Error("Network code and label are required.");
    const list = this.wallets.get(actor.tenantId) ?? [];
    if (list.some((w) => w.networkCode === networkCode)) throw new Error(`Telecom wallet ${networkCode} already exists.`);
    const wallet: TelecomWallet = Object.freeze({
      id: input.id?.trim() || generateHiddenUuid(), tenantId: actor.tenantId, networkCode, label,
      currency: input.currency, faceBalanceMinor: 0n, costPoolMinor: 0n, isActive: true,
    });
    list.push(wallet);
    this.wallets.set(actor.tenantId, list);
    return wallet;
  }

  getWallet(tenantId: string, walletId: string): TelecomWallet {
    const found = (this.wallets.get(tenantId) ?? []).find((w) => w.id === walletId && w.isActive);
    if (!found) throw new Error(`Active telecom wallet ${walletId} not found.`);
    return found;
  }

  rechargeWallet(
    actor: TenantContext,
    input: Readonly<{
      idempotencyKey: string; businessDate: string; walletId: string;
      faceAmountMinor: bigint; purchaseCostMinor: bigint;
      paymentMode: "cash" | "credit"; cashboxId?: string; supplierId?: string; memo?: string;
    }>,
  ): Readonly<{ wallet: TelecomWallet; journalEntryId: string }> {
    if (!hasPermission(actor.role, "finance.post") && !hasPermission(actor.role, "procurement.write")) {
      throw new Error(`Permission denied: "${actor.role}" cannot recharge telecom wallets.`);
    }
    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const wallet = this.getWallet(actor.tenantId, input.walletId);
    if (input.faceAmountMinor <= 0n || input.purchaseCostMinor <= 0n) throw new Error("Face amount and purchase cost must be positive.");
    if (input.paymentMode === "cash" && !input.cashboxId) throw new Error("Cash recharge requires cashboxId.");
    if (input.paymentMode === "credit" && !input.supplierId) throw new Error("Credit recharge requires supplierId.");

    const supplier = input.supplierId ? this.crm.getPartyOrThrow(actor.tenantId, input.supplierId, "supplier") : undefined;
    const creditLine = input.paymentMode === "cash"
      ? { accountId: this.accounting.getCashbox(actor, input.cashboxId!).ledgerAccountId, debitMinor: 0n, creditMinor: input.purchaseCostMinor, description: `شراء رصيد ${wallet.label}` }
      : { accountCode: STANDARD_ACCOUNT_CODES.ACCOUNTS_PAYABLE, debitMinor: 0n, creditMinor: input.purchaseCostMinor, description: `مورد رصيد: ${supplier!.name}` };

    const je = this.accounting.postModuleJournal(actor, {
      idempotencyKey: cleanKey, businessDate: input.businessDate, entryPrefix: "TRCH", currency: wallet.currency,
      memo: input.memo?.trim() || `شحن محفظة ${wallet.label}`,
      requiredPermission: hasPermission(actor.role, "finance.post") ? "finance.post" : "procurement.write",
      lines: [
        { accountCode: STANDARD_ACCOUNT_CODES.TELECOM_WALLETS, debitMinor: input.purchaseCostMinor, creditMinor: 0n, description: `رصيد ${wallet.networkCode}` },
        creditLine,
      ],
    });

    const idemKey = `${actor.tenantId}::${cleanKey}`;
    if (!this.rechargeIdems.has(idemKey)) {
      this.rechargeIdems.add(idemKey);
      const list = this.wallets.get(actor.tenantId) ?? [];
      const idx = list.findIndex((w) => w.id === wallet.id);
      list[idx] = Object.freeze({
        ...wallet,
        faceBalanceMinor: wallet.faceBalanceMinor + input.faceAmountMinor,
        costPoolMinor: wallet.costPoolMinor + input.purchaseCostMinor,
      });
      if (input.paymentMode === "credit" && supplier) {
        this.crm.recordSubledgerEntry({
          tenantId: actor.tenantId, partyId: supplier.id, currency: wallet.currency,
          deltaMinor: input.purchaseCostMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: je.memo,
        });
      }
    }
    return Object.freeze({ wallet: this.getWallet(actor.tenantId, wallet.id), journalEntryId: je.id });
  }

  postTopupSale(
    actor: TenantContext,
    input: Readonly<{
      idempotencyKey: string; businessDate: string; walletId: string;
      faceAmountMinor: bigint; chargedMinor: bigint; paymentMode: "cash" | "credit";
      cashboxId?: string; customerId?: string; recipientPhone?: string; packageName?: string;
    }>,
  ): TelecomTopupRecord {
    const canSell = hasPermission(actor.role, "sales.write");
    const canPost = hasPermission(actor.role, "finance.post");
    if (!canSell && !canPost) throw new Error(`Permission denied: "${actor.role}" cannot post top-up sales.`);

    const cleanKey = input.idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required.");
    const existingId = this.topupByIdem.get(`${actor.tenantId}::${cleanKey}`);
    if (existingId) {
      const found = (this.topups.get(actor.tenantId) ?? []).find((t) => t.id === existingId);
      if (found) return found;
    }

    const wallet = this.getWallet(actor.tenantId, input.walletId);
    if (input.faceAmountMinor <= 0n || input.chargedMinor <= 0n) throw new Error("Face amount and charged amount must be positive.");
    if (wallet.faceBalanceMinor < input.faceAmountMinor) {
      throw new Error(`Insufficient wallet balance in ${wallet.label} (available: ${wallet.faceBalanceMinor.toString()}).`);
    }
    if (input.paymentMode === "cash" && !input.cashboxId) throw new Error("Cash top-up requires cashboxId.");
    if (input.paymentMode === "credit" && !input.customerId) throw new Error("Credit top-up requires customerId.");

    const customer = input.customerId ? this.crm.getPartyOrThrow(actor.tenantId, input.customerId, "customer") : undefined;
    const wacCostMinor = input.faceAmountMinor === wallet.faceBalanceMinor
      ? wallet.costPoolMinor
      : (wallet.costPoolMinor * input.faceAmountMinor) / wallet.faceBalanceMinor;

    const debitLine = input.paymentMode === "cash"
      ? { accountId: this.accounting.getCashbox(actor, input.cashboxId!).ledgerAccountId, debitMinor: input.chargedMinor, creditMinor: 0n, description: `قبض تحويل ${wallet.label}` }
      : { accountCode: STANDARD_ACCOUNT_CODES.ACCOUNTS_RECEIVABLE, debitMinor: input.chargedMinor, creditMinor: 0n, description: `ذمة رصيد: ${customer!.name}` };

    const lines: Array<{ accountCode?: string; accountId?: string; debitMinor: bigint; creditMinor: bigint; description?: string }> = [
      debitLine,
      { accountCode: STANDARD_ACCOUNT_CODES.SERVICE_REVENUE, debitMinor: 0n, creditMinor: input.chargedMinor, description: `تحويل ${wallet.label}${input.packageName ? ` (${input.packageName})` : ""}` },
    ];
    if (wacCostMinor > 0n) {
      lines.push(
        { accountCode: STANDARD_ACCOUNT_CODES.COGS, debitMinor: wacCostMinor, creditMinor: 0n, description: `تكلفة رصيد ${wallet.networkCode}` },
        { accountCode: STANDARD_ACCOUNT_CODES.TELECOM_WALLETS, debitMinor: 0n, creditMinor: wacCostMinor, description: `خصم محفظة ${wallet.label}` },
      );
    }

    const je = this.accounting.postModuleJournal(actor, {
      idempotencyKey: cleanKey, businessDate: input.businessDate, entryPrefix: "TOP", currency: wallet.currency,
      memo: `تحويل ${wallet.label}${input.packageName ? ` — ${input.packageName}` : ""}${input.recipientPhone ? ` (${input.recipientPhone})` : ""}`,
      requiredPermission: canPost ? "finance.post" : "sales.write", lines,
    });

    const wList = this.wallets.get(actor.tenantId) ?? [];
    const wIdx = wList.findIndex((w) => w.id === wallet.id);
    wList[wIdx] = Object.freeze({
      ...wallet,
      faceBalanceMinor: wallet.faceBalanceMinor - input.faceAmountMinor,
      costPoolMinor: wallet.costPoolMinor - wacCostMinor,
    });

    if (input.paymentMode === "credit" && customer) {
      this.crm.recordSubledgerEntry({
        tenantId: actor.tenantId, partyId: customer.id, currency: wallet.currency,
        deltaMinor: input.chargedMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: je.memo,
      });
    }

    const record: TelecomTopupRecord = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, walletId: wallet.id, networkCode: wallet.networkCode,
      businessDate: input.businessDate, recipientPhone: input.recipientPhone?.trim() || undefined,
      packageName: input.packageName?.trim() || undefined, faceAmountMinor: input.faceAmountMinor,
      chargedMinor: input.chargedMinor, wacCostMinor, grossProfitMinor: input.chargedMinor - wacCostMinor,
      currency: wallet.currency, paymentMode: input.paymentMode, customerId: input.customerId,
      journalEntryId: je.id, status: "posted",
    });
    const tList = this.topups.get(actor.tenantId) ?? [];
    tList.unshift(record);
    this.topups.set(actor.tenantId, tList);
    this.topupByIdem.set(`${actor.tenantId}::${cleanKey}`, record.id);
    return record;
  }

  reverseTopupSale(actor: TenantContext, topupId: string, idempotencyKey: string, businessDate: string): TelecomTopupRecord {
    const tList = this.topups.get(actor.tenantId) ?? [];
    const idx = tList.findIndex((t) => t.id === topupId);
    if (idx < 0) throw new Error(`Top-up record ${topupId} not found.`);
    const orig = tList[idx];
    if (orig.status === "reversed") throw new Error("Top-up record is already reversed.");

    const revJournal = this.accounting.reverseEntry(actor, orig.journalEntryId, idempotencyKey, businessDate);
    const wList = this.wallets.get(actor.tenantId) ?? [];
    const wIdx = wList.findIndex((w) => w.id === orig.walletId);
    if (wIdx >= 0) {
      wList[wIdx] = Object.freeze({
        ...wList[wIdx],
        faceBalanceMinor: wList[wIdx].faceBalanceMinor + orig.faceAmountMinor,
        costPoolMinor: wList[wIdx].costPoolMinor + orig.wacCostMinor,
      });
    }
    if (orig.paymentMode === "credit" && orig.customerId) {
      this.crm.reverseSubledgerEntriesForJournal(actor.tenantId, orig.journalEntryId, revJournal.id, businessDate);
    }

    const updated: TelecomTopupRecord = Object.freeze({ ...orig, status: "reversed", reversalJournalId: revJournal.id });
    tList[idx] = updated;
    return updated;
  }
}
