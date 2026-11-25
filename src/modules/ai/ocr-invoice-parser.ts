import { normalizeArabicDigits } from "../../core/enterprise";

export type OcrExtractedLine = Readonly<{ description: string; quantity: number; unitPriceText: string }>;

export type OcrInvoiceExtraction = Readonly<{
  rawText: string;
  vendorOrParty?: string;
  invoiceDate?: string;
  invoiceNumber?: string;
  currency: "USD" | "SYP";
  totalAmountText: string;
  lines: readonly OcrExtractedLine[];
  confidence: number;
  warnings: readonly string[];
}>;

export function extractInvoiceFromOcrText(rawOcrText: string): OcrInvoiceExtraction {
  const rawText = rawOcrText.trim();
  if (!rawText) throw new Error("OCR text is empty.");

  const normalized = normalizeArabicDigits(rawText);
  const warnings: string[] = [];
  const lower = normalized.toLowerCase();
  const currency: "USD" | "SYP" =
    lower.includes("ل.س") || lower.includes("ليرة") || lower.includes("ليره") || /\bsyp\b/.test(lower) ? "SYP" : "USD";

  let invoiceDate: string | undefined;
  const isoMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(normalized);
  if (isoMatch) {
    invoiceDate = isoMatch[1];
  } else {
    const dmyMatch = /\b(\d{2})\/(\d{2})\/(\d{4})\b/.exec(normalized);
    if (dmyMatch) invoiceDate = `${dmyMatch[3]}-${dmyMatch[2]}-${dmyMatch[1]}`;
  }
  if (!invoiceDate) warnings.push("لم يتم العثور على تاريخ واضح في الفاتورة؛ يرجى المراجعة.");

  const invNoMatch = /(?:فاتورة رقم|رقم الفاتورة|invoice\s*#?|inv\s*#?)\s*[:#]?\s*([A-Za-z0-9-]+)/i.exec(normalized);
  const invoiceNumber = invNoMatch ? invNoMatch[1].trim() : undefined;

  const partyMatch = /(?:المورد|العميل|السيد|الشركة|vendor|supplier|customer)\s*[:：]\s*([^\n\r]+)/i.exec(normalized);
  const vendorOrParty = partyMatch ? partyMatch[1].trim() : undefined;

  const lines: OcrExtractedLine[] = [];
  for (const rawLine of normalized.split(/\r?\n/)) {
    const cleanLine = rawLine.trim();
    const itemMatch = /^(.+?)\s*[x×*]\s*(\d+)\s*(?:@|بسعر|سعر)?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i.exec(cleanLine);
    if (itemMatch) {
      const description = itemMatch[1].trim();
      const quantity = Number.parseInt(itemMatch[2], 10);
      const unitPriceText = itemMatch[3].replace(/,/g, "");
      if (description && quantity > 0) lines.push(Object.freeze({ description, quantity, unitPriceText }));
    }
  }

  const totalMatch = /(?:الإجمالي|الاجمالي|المجموع|الصافي|total|grand total|amount due)\s*[:：]?\s*\$?\s*(\d+(?:,\d{3})*(?:\.\d{1,2})?)/i.exec(normalized);
  let totalAmountText = totalMatch ? totalMatch[1].replace(/,/g, "") : "";
  if (!totalAmountText) {
    const allNums = normalized.replace(/,/g, "").match(/\d+(?:\.\d{1,2})?/g) ?? [];
    if (allNums.length === 0) throw new Error("Could not extract any monetary amount from OCR invoice text.");
    totalAmountText = allNums[allNums.length - 1];
    warnings.push("تم تقدير الإجمالي من آخر رقم بالفاتورة؛ يرجى التحقق قبل الموافقة.");
  }

  const confidence = warnings.length === 0 ? 0.94 : Math.max(0.65, 0.9 - warnings.length * 0.12);
  return Object.freeze({
    rawText, vendorOrParty, invoiceDate, invoiceNumber, currency, totalAmountText,
    lines: Object.freeze(lines), confidence, warnings: Object.freeze(warnings),
  });
}
