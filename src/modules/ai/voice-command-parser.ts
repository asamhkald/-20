import { normalizeArabicDigits } from "../../core/enterprise";

export type SupportedAiLanguage = "ar" | "en";

export type AiFinancialIntent =
  | "cash_sale"
  | "cash_expense"
  | "customer_debt_collection"
  | "supplier_debt_payment"
  | "balance_inquiry";

export type ParsedFinancialCommand = Readonly<{
  language: SupportedAiLanguage;
  intent: AiFinancialIntent;
  currency: "USD" | "SYP";
  amountText?: string;
  costAmountText?: string;
  memo: string;
  rawText: string;
  confidence: number;
  requiresApproval: boolean;
}>;

function detectLanguage(text: string): SupportedAiLanguage {
  return /[\u0600-\u06FF]/.test(text) ? "ar" : "en";
}

function detectCurrency(normalized: string): "USD" | "SYP" {
  const lower = normalized.toLowerCase();
  if (lower.includes("ليرة") || lower.includes("ليره") || lower.includes("ل.س") || lower.includes("سوري") || /\bsyp\b/.test(lower)) {
    return "SYP";
  }
  return "USD";
}

export function parseBilingualFinancialCommand(rawInput: string): ParsedFinancialCommand {
  const rawText = rawInput.trim();
  if (!rawText) throw new Error("Voice or text command cannot be empty.");

  const language = detectLanguage(rawText);
  const normalized = normalizeArabicDigits(rawText);
  const lower = normalized.toLowerCase();
  const currency = detectCurrency(normalized);

  const isInquiry =
    lower.includes("كم رصيد") || lower.includes("رصيد الصندوق") ||
    lower.includes("الارباح") || lower.includes("الأرباح") ||
    lower.includes("balance") || lower.includes("how much cash") || lower.includes("profit report");

  if (isInquiry) {
    return Object.freeze({
      language, intent: "balance_inquiry", currency, memo: rawText, rawText, confidence: 0.92, requiresApproval: false,
    });
  }

  const numbers = normalized.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/g) ?? [];
  if (numbers.length === 0) {
    throw new Error(language === "ar" ? "لم يتم العثور على مبلغ رقمي واضح في الأمر الصوتي." : "No valid numeric amount detected.");
  }

  const amountText = numbers[0];
  const costMatch = /(?:تكلفة|تكلفتها|تكلفته|cost|cogs)\s*[:=]?\s*(\d+(?:\.\d{1,2})?)/i.exec(normalized.replace(/,/g, ""));
  const costAmountText = costMatch ? costMatch[1] : undefined;

  let intent: AiFinancialIntent = "cash_sale";
  let confidence = 0.88;

  if (lower.includes("تحصيل") || lower.includes("قبض دين") || lower.includes("دفعة من") || lower.includes("دفعه من") || lower.includes("collect debt") || lower.includes("customer payment")) {
    intent = "customer_debt_collection";
    confidence = 0.93;
  } else if (lower.includes("سداد مورد") || lower.includes("دفعة لمورد") || lower.includes("للمورد") || lower.includes("pay supplier") || lower.includes("supplier payment")) {
    intent = "supplier_debt_payment";
    confidence = 0.93;
  } else if (lower.includes("مصروف") || lower.includes("صرف") || lower.includes("دفع") || lower.includes("فاتورة كهرباء") || lower.includes("ايجار") || lower.includes("إيجار") || lower.includes("expense") || lower.includes("paid ") || lower.includes("spend")) {
    intent = "cash_expense";
    confidence = 0.91;
  } else if (lower.includes("بيع") || lower.includes("بعت") || lower.includes("مبيعات") || lower.includes("sale") || lower.includes("sold")) {
    intent = "cash_sale";
    confidence = 0.94;
  } else {
    confidence = 0.72;
  }

  return Object.freeze({
    language, intent, currency, amountText, costAmountText, memo: rawText, rawText, confidence, requiresApproval: true,
  });
}
