import { generateHiddenUuid } from "../../core/enterprise";
import { moneyToDecimalString } from "../../core/money";
import { hasPermission } from "../../core/permissions";
import type { TenantContext } from "../../core/tenant";
import { SUPPORTED_CURRENCIES, type AccountingWorkspaceService } from "../../services";
import { extractInvoiceFromOcrText, type OcrInvoiceExtraction } from "./ocr-invoice-parser";
import { parseBilingualFinancialCommand, type AiFinancialIntent, type SupportedAiLanguage } from "./voice-command-parser";

export type AiProposalStatus = "pending_approval" | "executed" | "rejected";

export type AiAuditEvent = Readonly<{
  id: string; tenantId: string; userId: string; role: string;
  action: "ai.proposal.created" | "ai.proposal.approved_and_executed" | "ai.proposal.rejected" | "ai.inquiry.answered";
  proposalId?: string; journalEntryId?: string; source: "voice" | "text" | "ocr"; summary: string; occurredAt: string;
}>;

export type AiFinancialProposal = Readonly<{
  id: string; tenantId: string; requestedBy: string; source: "voice" | "text" | "ocr";
  language: SupportedAiLanguage; intent: Exclude<AiFinancialIntent, "balance_inquiry">;
  currency: "USD" | "SYP"; cashboxId: string; amountText: string; costAmountText?: string;
  businessDate: string; memo: string; confidence: number; status: AiProposalStatus;
  requiresExplicitApproval: true; createdAt: string; decidedBy?: string; decidedAt?: string;
  rejectionReason?: string; executedJournalId?: string; spokenPreview: string;
}>;

export type AiReadoutResponse = Readonly<{
  language: SupportedAiLanguage; spokenText: string;
  proposal?: AiFinancialProposal; ocrExtraction?: OcrInvoiceExtraction;
}>;

function defaultCashboxForCurrency(currency: "USD" | "SYP"): string {
  return currency === "SYP" ? "cb-syp" : "cb-usd";
}

function buildSpokenPreview(
  language: SupportedAiLanguage, intent: Exclude<AiFinancialIntent, "balance_inquiry">,
  amountText: string, currency: "USD" | "SYP",
): string {
  if (language === "ar") {
    const curLabel = currency === "USD" ? "دولار" : "ليرة سورية";
    const labels: Record<Exclude<AiFinancialIntent, "balance_inquiry">, string> = {
      cash_sale: "قيد بيع نقدي", cash_expense: "قيد مصروف نقدي",
      customer_debt_collection: "تحصيل دفعة دين من عميل", supplier_debt_payment: "سداد دفعة لمورد",
    };
    return `تم تجهيز مسودة ${labels[intent]} بمبلغ ${amountText} ${curLabel}. يرجى المراجعة وتأكيد الموافقة قبل الترحيل.`;
  }
  const labelsEn: Record<Exclude<AiFinancialIntent, "balance_inquiry">, string> = {
    cash_sale: "cash sale", cash_expense: "cash expense",
    customer_debt_collection: "customer debt collection", supplier_debt_payment: "supplier payment",
  };
  return `Prepared a draft ${labelsEn[intent]} for ${amountText} ${currency}. Please review and explicitly approve before posting.`;
}

export class AiCopilotService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly proposals = new Map<string, AiFinancialProposal[]>();
  private readonly auditTrail = new Map<string, AiAuditEvent[]>();

  constructor(accounting: AccountingWorkspaceService) {
    this.accounting = accounting;
  }

  private recordAudit(event: Omit<AiAuditEvent, "id" | "occurredAt">): AiAuditEvent {
    const rec: AiAuditEvent = Object.freeze({ ...event, id: generateHiddenUuid(), occurredAt: new Date().toISOString() });
    const list = this.auditTrail.get(event.tenantId) ?? [];
    list.unshift(rec);
    this.auditTrail.set(event.tenantId, list);
    return rec;
  }

  listProposals(actor: TenantContext): readonly AiFinancialProposal[] {
    if (!hasPermission(actor.role, "finance.read")) throw new Error(`Permission denied: "${actor.role}" lacks "finance.read".`);
    return Object.freeze([...(this.proposals.get(actor.tenantId) ?? [])]);
  }

  listAiAuditEvents(actor: TenantContext): readonly AiAuditEvent[] {
    if (!hasPermission(actor.role, "audit.read") && !hasPermission(actor.role, "finance.read")) {
      throw new Error(`Permission denied: "${actor.role}" cannot view AI audit events.`);
    }
    return Object.freeze([...(this.auditTrail.get(actor.tenantId) ?? [])]);
  }

  processVoiceOrTextCommand(
    actor: TenantContext,
    input: Readonly<{ rawText: string; businessDate: string; source?: "voice" | "text"; cashboxId?: string }>,
  ): AiReadoutResponse {
    const parsed = parseBilingualFinancialCommand(input.rawText);
    const source = input.source ?? "voice";

    if (parsed.intent === "balance_inquiry") {
      const cashboxId = input.cashboxId ?? defaultCashboxForCurrency(parsed.currency);
      const stmt = this.accounting.getCashboxStatement(actor, cashboxId);
      const def = SUPPORTED_CURRENCIES[stmt.currency] ?? { code: stmt.currency, decimalPlaces: 2 };
      const formatted = moneyToDecimalString({ amountMinor: stmt.currentBalanceMinor, currency: stmt.currency }, def.decimalPlaces);
      const spokenText = parsed.language === "ar"
        ? `الرصيد الحالي في ${stmt.cashbox.name} هو ${formatted} ${stmt.currency === "USD" ? "دولار" : "ليرة سورية"}.`
        : `The current balance in ${stmt.cashbox.code} is ${formatted} ${stmt.currency}.`;

      this.recordAudit({
        tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
        action: "ai.inquiry.answered", source, summary: `Balance inquiry (${stmt.cashbox.code}): ${formatted} ${stmt.currency}`,
      });
      return Object.freeze({ language: parsed.language, spokenText });
    }

    const cashboxId = input.cashboxId ?? defaultCashboxForCurrency(parsed.currency);
    const amountText = parsed.amountText!;
    const spokenPreview = buildSpokenPreview(parsed.language, parsed.intent, amountText, parsed.currency);

    const proposal: AiFinancialProposal = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, requestedBy: actor.userId, source,
      language: parsed.language, intent: parsed.intent, currency: parsed.currency, cashboxId,
      amountText, costAmountText: parsed.costAmountText, businessDate: input.businessDate,
      memo: parsed.memo, confidence: parsed.confidence, status: "pending_approval",
      requiresExplicitApproval: true, createdAt: new Date().toISOString(), spokenPreview,
    });
    const list = this.proposals.get(actor.tenantId) ?? [];
    list.unshift(proposal);
    this.proposals.set(actor.tenantId, list);

    this.recordAudit({
      tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
      action: "ai.proposal.created", proposalId: proposal.id, source,
      summary: `Prepared ${proposal.intent} (${proposal.amountText} ${proposal.currency}) awaiting approval`,
    });
    return Object.freeze({ language: parsed.language, spokenText: spokenPreview, proposal });
  }

  prepareProposalFromInvoiceOcr(
    actor: TenantContext,
    input: Readonly<{
      rawOcrText: string; intent: "cash_sale" | "cash_expense" | "supplier_debt_payment";
      fallbackBusinessDate: string; language?: SupportedAiLanguage; cashboxId?: string;
    }>,
  ): AiReadoutResponse {
    const extraction = extractInvoiceFromOcrText(input.rawOcrText);
    const language: SupportedAiLanguage = input.language ?? (/[\u0600-\u06FF]/.test(input.rawOcrText) ? "ar" : "en");
    const cashboxId = input.cashboxId ?? defaultCashboxForCurrency(extraction.currency);
    const businessDate = extraction.invoiceDate ?? input.fallbackBusinessDate;
    const memo = [extraction.invoiceNumber ? `فاتورة #${extraction.invoiceNumber}` : "فاتورة OCR", extraction.vendorOrParty ? `(${extraction.vendorOrParty})` : ""].filter(Boolean).join(" ");
    const spokenPreview = buildSpokenPreview(language, input.intent, extraction.totalAmountText, extraction.currency);

    const proposal: AiFinancialProposal = Object.freeze({
      id: generateHiddenUuid(), tenantId: actor.tenantId, requestedBy: actor.userId, source: "ocr",
      language, intent: input.intent, currency: extraction.currency, cashboxId,
      amountText: extraction.totalAmountText, businessDate, memo, confidence: extraction.confidence,
      status: "pending_approval", requiresExplicitApproval: true, createdAt: new Date().toISOString(), spokenPreview,
    });
    const list = this.proposals.get(actor.tenantId) ?? [];
    list.unshift(proposal);
    this.proposals.set(actor.tenantId, list);

    this.recordAudit({
      tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
      action: "ai.proposal.created", proposalId: proposal.id, source: "ocr",
      summary: `OCR extracted ${proposal.amountText} ${proposal.currency} (${proposal.memo}) awaiting approval`,
    });
    return Object.freeze({ language, spokenText: spokenPreview, proposal, ocrExtraction: extraction });
  }

  approveAndExecuteProposal(
    actor: TenantContext, proposalId: string, explicitUserApproved: boolean,
  ): Readonly<{ proposal: AiFinancialProposal; journalEntryId: string; spokenConfirmation: string }> {
    if (!explicitUserApproved) throw new Error("Explicit user approval is required before executing any AI financial proposal.");
    if (!hasPermission(actor.role, "finance.post")) throw new Error(`Permission denied: role "${actor.role}" cannot approve financial proposals.`);

    const list = this.proposals.get(actor.tenantId) ?? [];
    const idx = list.findIndex((p) => p.id === proposalId);
    if (idx < 0) throw new Error(`AI proposal ${proposalId} was not found.`);

    const prop = list[idx];
    if (prop.status === "rejected") throw new Error("Cannot execute a rejected AI proposal.");
    if (prop.status === "executed" && prop.executedJournalId) {
      return Object.freeze({
        proposal: prop, journalEntryId: prop.executedJournalId,
        spokenConfirmation: prop.language === "ar" ? "تم تنفيذ هذه العملية مسبقاً وحمايتها من التكرار." : "Already executed and protected against duplication.",
      });
    }

    const idemKey = `ai-prop-${prop.id}`;
    let journalEntryId: string;
    if (prop.intent === "cash_sale") {
      journalEntryId = this.accounting.postCashSale(actor, { idempotencyKey: idemKey, businessDate: prop.businessDate, currency: prop.currency, cashboxId: prop.cashboxId, saleAmountText: prop.amountText, costAmountText: prop.costAmountText, memo: `[AI] ${prop.memo}` }).id;
    } else if (prop.intent === "cash_expense") {
      journalEntryId = this.accounting.postCashExpense(actor, { idempotencyKey: idemKey, businessDate: prop.businessDate, cashboxId: prop.cashboxId, amountText: prop.amountText, memo: `[AI] ${prop.memo}` }).id;
    } else if (prop.intent === "customer_debt_collection") {
      journalEntryId = this.accounting.postCustomerDebtCollection(actor, { idempotencyKey: idemKey, businessDate: prop.businessDate, cashboxId: prop.cashboxId, amountText: prop.amountText, memo: `[AI] ${prop.memo}` }).id;
    } else {
      journalEntryId = this.accounting.postSupplierDebtPayment(actor, { idempotencyKey: idemKey, businessDate: prop.businessDate, cashboxId: prop.cashboxId, amountText: prop.amountText, memo: `[AI] ${prop.memo}` }).id;
    }

    const updated: AiFinancialProposal = Object.freeze({
      ...prop, status: "executed", decidedBy: actor.userId, decidedAt: new Date().toISOString(), executedJournalId: journalEntryId,
    });
    list[idx] = updated;

    this.recordAudit({
      tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
      action: "ai.proposal.approved_and_executed", proposalId: updated.id, journalEntryId, source: updated.source,
      summary: `Approved & posted ${updated.intent} (${updated.amountText} ${updated.currency})`,
    });

    const spokenConfirmation = updated.language === "ar"
      ? `تم اعتماد وترحيل العملية بنجاح بمبلغ ${updated.amountText} ${updated.currency === "USD" ? "دولار" : "ليرة سورية"}.`
      : `Approved and posted ${updated.amountText} ${updated.currency} successfully.`;
    return Object.freeze({ proposal: updated, journalEntryId, spokenConfirmation });
  }

  rejectProposal(actor: TenantContext, proposalId: string, reason = "مرفوض من المستخدم"): AiFinancialProposal {
    const list = this.proposals.get(actor.tenantId) ?? [];
    const idx = list.findIndex((p) => p.id === proposalId);
    if (idx < 0) throw new Error(`AI proposal ${proposalId} was not found.`);
    const prop = list[idx];
    if (prop.status === "executed") throw new Error("Cannot reject an executed proposal. Post a reversing entry instead.");

    const updated: AiFinancialProposal = Object.freeze({
      ...prop, status: "rejected", decidedBy: actor.userId, decidedAt: new Date().toISOString(), rejectionReason: reason.trim() || "Rejected",
    });
    list[idx] = updated;
    this.recordAudit({
      tenantId: actor.tenantId, userId: actor.userId, role: actor.role,
      action: "ai.proposal.rejected", proposalId: updated.id, source: updated.source,
      summary: `Rejected proposal ${updated.id}: ${updated.rejectionReason}`,
    });
    return updated;
  }
}
