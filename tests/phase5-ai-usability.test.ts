import { describe, expect, it } from "vitest";
import { createSandboxAccountingService } from "../src/services";
import { AiCopilotService, extractInvoiceFromOcrText, parseBilingualFinancialCommand } from "../src/modules/ai";
import { speakResultAloud } from "../src/lib/speech";

describe("Phase 5: Bilingual Voice AI, Invoice OCR, Explicit User Approval & Audit Trail", () => {
  it("parses Arabic (with Arabic-Indic digits) and English voice commands without floating-point drift", () => {
    const arSale = parseBilingualFinancialCommand("بعت شاشة بمبلغ ١٠٠.٥٠ دولار تكلفة ٧٠.٢٥");
    expect(arSale.language).toBe("ar");
    expect(arSale.intent).toBe("cash_sale");
    expect(arSale.currency).toBe("USD");
    expect(arSale.amountText).toBe("100.50");
    expect(arSale.costAmountText).toBe("70.25");
    expect(arSale.requiresApproval).toBe(true);

    const arSypExp = parseBilingualFinancialCommand("سجل مصروف فاتورة كهرباء 25000 ليرة سورية");
    expect(arSypExp.intent).toBe("cash_expense");
    expect(arSypExp.currency).toBe("SYP");
    expect(arSypExp.amountText).toBe("25000");

    const enDebt = parseBilingualFinancialCommand("Collect debt customer payment 45.00 USD");
    expect(enDebt.language).toBe("en");
    expect(enDebt.intent).toBe("customer_debt_collection");
    expect(enDebt.amountText).toBe("45.00");

    const inquiry = parseBilingualFinancialCommand("كم رصيد الصندوق بالدولار؟");
    expect(inquiry.intent).toBe("balance_inquiry");
    expect(inquiry.requiresApproval).toBe(false);
  });

  it("NEVER auto-posts sensitive operations without explicit user approval, logs full AI audit trail, and answers spoken balance inquiries", () => {
    const tenantId = "t-p5-ai";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const technician = { tenantId, userId: "u-tech", role: "technician" as const };
    const accounting = createSandboxAccountingService(tenantId);
    const ai = new AiCopilotService(accounting);

    accounting.postOpeningBalance(owner, { idempotencyKey: "ob-ai", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "500.00", memo: "Opening" });

    // 1. Voice command creates PENDING proposal only (journal count MUST NOT increase yet!)
    const journalsBefore = accounting.getSnapshot(owner).entries.length;
    const res = ai.processVoiceOrTextCommand(owner, {
      rawText: "بعت بطارية بمبلغ 100.00 دولار تكلفة 70.00",
      businessDate: "2026-11-25",
      source: "voice",
    });
    expect(res.proposal?.status).toBe("pending_approval");
    expect(res.spokenText).toContain("100.00");
    expect(accounting.getSnapshot(owner).entries.length).toBe(journalsBefore);

    // 2. Execution with explicitUserApproved = false MUST fail
    expect(() => ai.approveAndExecuteProposal(owner, res.proposal!.id, false)).toThrow(/Explicit user approval/);

    // 3. Unauthorized role (technician) CANNOT approve financial posting
    expect(() => ai.approveAndExecuteProposal(technician, res.proposal!.id, true)).toThrow(/Permission denied/);

    // 4. Explicit owner approval executes cleanly and double-approve is idempotent
    const exec1 = ai.approveAndExecuteProposal(owner, res.proposal!.id, true);
    const exec2 = ai.approveAndExecuteProposal(owner, res.proposal!.id, true);
    expect(exec1.proposal.status).toBe("executed");
    expect(exec2.journalEntryId).toBe(exec1.journalEntryId);
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(60000n); // 500 + 100

    // 5. Read-only spoken balance inquiry
    const balReply = ai.processVoiceOrTextCommand(owner, { rawText: "كم رصيد الصندوق دولار", businessDate: "2026-11-25" });
    expect(balReply.spokenText).toContain("600.00");
    expect(speakResultAloud(balReply.spokenText, "ar")).toBe(false); // Headless Node degrades safely

    // 6. Verify AI audit log recorded creation, execution, and inquiry
    const events = ai.listAiAuditEvents(owner);
    expect(events.some((e) => e.action === "ai.proposal.created")).toBe(true);
    expect(events.some((e) => e.action === "ai.proposal.approved_and_executed")).toBe(true);
    expect(events.some((e) => e.action === "ai.inquiry.answered")).toBe(true);
  });

  it("extracts Arabic/English OCR invoices for review and blocks execution if rejected", () => {
    const tenantId = "t-p5-ocr";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const accounting = createSandboxAccountingService(tenantId);
    const ai = new AiCopilotService(accounting);

    accounting.postOpeningBalance(owner, { idempotencyKey: "ob-ocr", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "300.00", memo: "Opening" });

    const ocrSample = `
      فاتورة رقم: INV-8841
      التاريخ: 2026-11-25
      المورد: شركة النور للإكسسوارات
      شاحن سريع × 4 @ 15.00
      كابل تايب سي × 5 @ 4.00
      الإجمالي: 80.00 USD
    `;
    const extracted = extractInvoiceFromOcrText(ocrSample);
    expect(extracted.invoiceNumber).toBe("INV-8841");
    expect(extracted.invoiceDate).toBe("2026-11-25");
    expect(extracted.vendorOrParty).toContain("شركة النور");
    expect(extracted.lines.length).toBe(2);
    expect(extracted.totalAmountText).toBe("80.00");

    const draft = ai.prepareProposalFromInvoiceOcr(owner, {
      rawOcrText: ocrSample,
      intent: "cash_expense",
      fallbackBusinessDate: "2026-11-25",
    });
    expect(draft.proposal?.status).toBe("pending_approval");

    // Reject proposal -> must stay out of ledger and block subsequent execution
    const rejected = ai.rejectProposal(owner, draft.proposal!.id, "فاتورة مكررة");
    expect(rejected.status).toBe("rejected");
    expect(() => ai.approveAndExecuteProposal(owner, rejected.id, true)).toThrow(/rejected/i);
    expect(accounting.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(30000n);
  });
});
