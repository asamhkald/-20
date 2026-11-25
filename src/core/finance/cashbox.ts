import { requirePostingAccount, type LedgerAccount } from "./accounts";
import { validateJournal, type JournalEntry } from "../journal";
import {
  assertCurrencyDefinition,
  createMoney,
  type CurrencyDefinition,
  type Money,
} from "../money";

export type CashboxKind = "cash" | "wallet" | "bank";

export type Cashbox = Readonly<{
  id: string;
  tenantId: string;
  branchId?: string;
  code: string;
  name: string;
  kind: CashboxKind;
  currency: string;
  ledgerAccountId: string;
  isActive: boolean;
}>;

export type CashboxMovement = Readonly<{
  journalEntryId: string;
  entryNumber: string;
  businessDate: string;
  memo: string;
  currency: string;
  direction: "in" | "out";
  amountMinor: bigint;
  runningBalanceMinor: bigint;
  isReversal: boolean;
}>;

export type CashboxStatement = Readonly<{
  cashbox: Cashbox;
  currency: string;
  totalInMinor: bigint;
  totalOutMinor: bigint;
  currentBalanceMinor: bigint;
  movements: readonly CashboxMovement[];
}>;

export type RoundingMode = "half_up" | "half_even";

export type FxRateQuote = Readonly<{
  fromCurrency: string;
  toCurrency: string;
  rateText: string;
  effectiveDate: string;
  source: string;
  roundingMode?: RoundingMode;
}>;

export function validateCashbox(
  cashbox: Cashbox,
  accounts: ReadonlyMap<string, LedgerAccount>,
): void {
  if (!cashbox.id.trim() || !cashbox.tenantId.trim()) {
    throw new Error("Cashbox requires an ID and tenant.");
  }
  if (!cashbox.code.trim() || !cashbox.name.trim()) {
    throw new Error("Cashbox requires a code and name.");
  }
  if (!/^[A-Z]{3}$/.test(cashbox.currency)) {
    throw new Error("Cashbox currency must be a three-letter uppercase code.");
  }
  if (cashbox.kind !== "cash" && cashbox.kind !== "wallet" && cashbox.kind !== "bank") {
    throw new Error("Unsupported cashbox kind.");
  }
  const account = requirePostingAccount(cashbox.ledgerAccountId, cashbox.tenantId, accounts);
  if (account.type !== "asset") {
    throw new Error("Cashbox ledger account must be an asset account.");
  }
}

export function computeCashboxStatement(
  cashbox: Cashbox,
  entries: readonly JournalEntry[],
): CashboxStatement {
  let totalInMinor = 0n;
  let totalOutMinor = 0n;
  let running = 0n;
  const movements: CashboxMovement[] = [];

  for (const entry of entries) {
    if (entry.tenantId !== cashbox.tenantId) {
      throw new Error("Cross-tenant journal entry is not allowed in cashbox statement.");
    }
    if (entry.status !== "posted") continue;
    validateJournal(entry);

    for (const line of entry.lines) {
      if (line.accountId !== cashbox.ledgerAccountId) continue;
      if (line.currency !== cashbox.currency) {
        throw new Error(
          `Currency mismatch on cashbox ${cashbox.code}: expected ${cashbox.currency} but found ${line.currency}.`,
        );
      }

      if (line.debitMinor > 0n) {
        totalInMinor += line.debitMinor;
        running += line.debitMinor;
        movements.push(
          Object.freeze({
            journalEntryId: entry.id,
            entryNumber: entry.entryNumber,
            businessDate: entry.businessDate,
            memo: line.description ? `${entry.memo} — ${line.description}` : entry.memo,
            currency: cashbox.currency,
            direction: "in" as const,
            amountMinor: line.debitMinor,
            runningBalanceMinor: running,
            isReversal: Boolean(entry.reversalOfId),
          }),
        );
      } else if (line.creditMinor > 0n) {
        totalOutMinor += line.creditMinor;
        running -= line.creditMinor;
        movements.push(
          Object.freeze({
            journalEntryId: entry.id,
            entryNumber: entry.entryNumber,
            businessDate: entry.businessDate,
            memo: line.description ? `${entry.memo} — ${line.description}` : entry.memo,
            currency: cashbox.currency,
            direction: "out" as const,
            amountMinor: line.creditMinor,
            runningBalanceMinor: running,
            isReversal: Boolean(entry.reversalOfId),
          }),
        );
      }
    }
  }

  return Object.freeze({
    cashbox,
    currency: cashbox.currency,
    totalInMinor,
    totalOutMinor,
    currentBalanceMinor: running,
    movements: Object.freeze(movements),
  });
}

function divideWithRounding(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new Error("Denominator must be positive.");
  const negative = numerator < 0n;
  const absNum = negative ? -numerator : numerator;
  const quotient = absNum / denominator;
  const remainder = absNum % denominator;
  const twiceRem = remainder * 2n;

  let rounded = quotient;
  if (twiceRem > denominator) {
    rounded = quotient + 1n;
  } else if (twiceRem === denominator) {
    if (mode === "half_up") {
      rounded = quotient + 1n;
    } else if (quotient % 2n !== 0n) {
      rounded = quotient + 1n;
    }
  }
  return negative ? -rounded : rounded;
}

export function convertMoneyExact(
  source: Money,
  sourceCurrencyDef: CurrencyDefinition,
  targetCurrencyDef: CurrencyDefinition,
  quote: FxRateQuote,
): Money {
  assertCurrencyDefinition(sourceCurrencyDef);
  assertCurrencyDefinition(targetCurrencyDef);

  const fromCur = quote.fromCurrency.trim().toUpperCase();
  const toCur = quote.toCurrency.trim().toUpperCase();
  if (fromCur !== sourceCurrencyDef.code || source.currency !== sourceCurrencyDef.code) {
    throw new Error("FX quote source currency does not match source money.");
  }
  if (toCur !== targetCurrencyDef.code) {
    throw new Error("FX quote target currency does not match target currency definition.");
  }
  if (fromCur === toCur) {
    throw new Error("FX conversion requires two distinct currencies.");
  }
  if (source.amountMinor <= 0n) {
    throw new Error("Amount to convert must be positive.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(quote.effectiveDate)) {
    throw new Error("FX quote effectiveDate must be YYYY-MM-DD.");
  }
  if (!quote.source.trim()) {
    throw new Error("FX quote must document its rate source.");
  }

  const rateMatch = /^(\d+)(?:\.(\d+))?$/.exec(quote.rateText.trim());
  if (!rateMatch) {
    throw new Error("FX rate must be a positive decimal string.");
  }
  const [, whole, frac = ""] = rateMatch;
  if (frac.length > 8) {
    throw new Error("FX rate supports at most 8 decimal places.");
  }
  const rateScaled = BigInt(whole + frac);
  if (rateScaled <= 0n) {
    throw new Error("FX rate must be greater than zero.");
  }

  const rateScale = 10n ** BigInt(frac.length);
  const srcScale = 10n ** BigInt(sourceCurrencyDef.decimalPlaces);
  const dstScale = 10n ** BigInt(targetCurrencyDef.decimalPlaces);

  const numerator = source.amountMinor * rateScaled * dstScale;
  const denominator = srcScale * rateScale;
  const targetMinor = divideWithRounding(numerator, denominator, quote.roundingMode ?? "half_up");
  if (targetMinor <= 0n) {
    throw new Error("Converted amount rounds to zero; check rate or amount.");
  }
  return createMoney(targetMinor, targetCurrencyDef.code);
}
