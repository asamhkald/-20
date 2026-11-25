/**
 * Exact money arithmetic.
 * Amounts are stored as integer minor units. The currency's decimal precision
 * is supplied explicitly; never infer it from a floating-point value.
 */
export type Money = Readonly<{ amountMinor: bigint; currency: string }>;

export type CurrencyDefinition = Readonly<{
  code: string;
  decimalPlaces: number;
}>;

const CURRENCY_CODE = /^[A-Z]{3}$/;
const MAX_MINOR_UNIT_DIGITS = 38;

export function assertCurrencyDefinition(currency: CurrencyDefinition): void {
  if (!CURRENCY_CODE.test(currency.code)) {
    throw new Error("Currency code must be a three-letter uppercase code.");
  }
  if (!Number.isInteger(currency.decimalPlaces) || currency.decimalPlaces < 0 || currency.decimalPlaces > 6) {
    throw new Error("Currency decimal places must be an integer between 0 and 6.");
  }
}

export function createMoney(amountMinor: bigint, currency: string): Money {
  const normalizedCurrency = currency.trim().toUpperCase();
  if (!CURRENCY_CODE.test(normalizedCurrency)) {
    throw new Error("Currency code must be a three-letter uppercase code.");
  }
  if ((amountMinor < 0n ? -amountMinor : amountMinor).toString().length > MAX_MINOR_UNIT_DIGITS) {
    throw new Error(`Money amount exceeds the ${MAX_MINOR_UNIT_DIGITS}-digit storage limit.`);
  }
  return Object.freeze({ amountMinor, currency: normalizedCurrency });
}

/** Parse a human decimal string without passing through Number/float. */
export function parseMoney(input: string, currency: CurrencyDefinition): Money {
  assertCurrencyDefinition(currency);
  const value = input.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("Enter a valid decimal amount using a dot as the decimal separator.");

  const [, sign, whole, fraction = ""] = match;
  if (fraction.length > currency.decimalPlaces) {
    throw new Error(`This currency supports at most ${currency.decimalPlaces} decimal places.`);
  }

  const scale = 10n ** BigInt(currency.decimalPlaces);
  const paddedFraction = fraction.padEnd(currency.decimalPlaces, "0");
  const fractionalMinor = paddedFraction ? BigInt(paddedFraction) : 0n;
  const absoluteMinor = BigInt(whole) * scale + fractionalMinor;
  return createMoney(sign === "-" ? -absoluteMinor : absoluteMinor, currency.code);
}

/** Convert minor units to an exact decimal string suitable for NUMERIC/text storage. */
export function moneyToDecimalString(money: Money, decimalPlaces: number): string {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) {
    throw new Error("Decimal places must be an integer between 0 and 6.");
  }
  const negative = money.amountMinor < 0n;
  const absolute = negative ? -money.amountMinor : money.amountMinor;
  const scale = 10n ** BigInt(decimalPlaces);
  const whole = absolute / scale;
  if (decimalPlaces === 0) return `${negative ? "-" : ""}${whole}`;
  const fraction = (absolute % scale).toString().padStart(decimalPlaces, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return createMoney(a.amountMinor + b.amountMinor, a.currency);
}

export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return createMoney(a.amountMinor - b.amountMinor, a.currency);
}

export function multiplyMoney(money: Money, quantity: bigint): Money {
  return createMoney(money.amountMinor * quantity, money.currency);
}

export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}
