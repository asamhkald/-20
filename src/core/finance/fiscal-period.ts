export type FiscalPeriod = Readonly<{
  id: string;
  tenantId: string;
  startsOn: string;
  endsOn: string;
  status: "open" | "closed";
}>;

function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validateFiscalPeriod(period: FiscalPeriod): void {
  if (!period.id || !period.tenantId) throw new Error("A fiscal period requires an ID and tenant.");
  if (!isDateOnly(period.startsOn) || !isDateOnly(period.endsOn)) throw new Error("Fiscal period dates must be valid YYYY-MM-DD dates.");
  if (period.startsOn > period.endsOn) throw new Error("Fiscal period start must be on or before its end.");
  if (period.status !== "open" && period.status !== "closed") throw new Error("Fiscal period status is invalid.");
}

export function assertDateInOpenPeriod(businessDate: string, tenantId: string, periods: readonly FiscalPeriod[]): FiscalPeriod {
  if (!isDateOnly(businessDate)) throw new Error("Business date must be a valid YYYY-MM-DD date.");
  const date = businessDate;
  const matching = periods.filter((period) => {
    validateFiscalPeriod(period);
    return period.tenantId === tenantId && period.startsOn <= date && date <= period.endsOn;
  });
  if (matching.length === 0) throw new Error("No fiscal period covers the journal date.");
  if (matching.length > 1) throw new Error("Overlapping fiscal periods are not allowed.");
  if (matching[0].status !== "open") throw new Error("The fiscal period is closed.");
  return matching[0];
}
