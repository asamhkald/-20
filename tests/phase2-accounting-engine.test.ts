import { describe, expect, it } from "vitest";
import { createSandboxAccountingService } from "../src/services";
import { convertMoneyExact, createStandardChartOfAccounts, STANDARD_ACCOUNT_CODES } from "../src/core/finance";
import { createMoney } from "../src/core/money";

describe("Phase 2: Accounting Engine, Cashboxes, FX Transfers & Period Closing", () => {
  it("provides a standard chart of accounts and separate multi-currency cashboxes with opening balances", () => {
    const tenantId = "tenant-p2-chart";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const accounts = createStandardChartOfAccounts(tenantId);
    expect(accounts.some((a) => a.code === STANDARD_ACCOUNT_CODES.CASH_USD)).toBe(true);
    expect(accounts.some((a) => a.code === STANDARD_ACCOUNT_CODES.CASH_SYP)).toBe(true);
    expect(accounts.some((a) => a.code === STANDARD_ACCOUNT_CODES.OWNER_EQUITY)).toBe(true);

    const svc = createSandboxAccountingService(tenantId);
    svc.postOpeningBalance(owner, { idempotencyKey: "ob-usd-1", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "1000.00", memo: "رصيد افتتاحي دولار" });
    svc.postOpeningBalance(owner, { idempotencyKey: "ob-syp-1", businessDate: "2026-11-25", cashboxId: "cb-syp", amountText: "50000.00", memo: "رصيد افتتاحي ليرة سورية" });

    expect(svc.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(100000n);
    expect(svc.getCashboxStatement(owner, "cb-syp").currentBalanceMinor).toBe(5000000n);
  });

  it("enforces core accounting rules: debt collection NEVER duplicates revenue; cash expense & supplier payment reduce cash", () => {
    const tenantId = "tenant-p2-rules";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const svc = createSandboxAccountingService(tenantId);

    svc.postOpeningBalance(owner, { idempotencyKey: "ob-1", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "500.00", memo: "Opening" });
    svc.postCreditSale(owner, { idempotencyKey: "cs-1", businessDate: "2026-11-25", currency: "USD", customerName: "أحمد العلي", saleAmountText: "100.00", costAmountText: "70.00" });
    svc.postCustomerDebtCollection(owner, { idempotencyKey: "col-1", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "40.00", memo: "دفعة جزئية" });
    svc.postCashExpense(owner, { idempotencyKey: "exp-1", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "25.00", memo: "كهرباء" });
    svc.postSupplierDebtPayment(owner, { idempotencyKey: "sup-1", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "60.00", memo: "دفعة مورد" });

    const snap = svc.getSnapshot(owner);
    const byCode = new Map(snap.trialBalance.rows.filter((r) => r.currency === "USD").map((r) => [r.accountCode, r.normalBalanceMinor]));

    expect(byCode.get("1010")).toBe(45500n); // 500 + 40 - 25 - 60 = $455.00
    expect(byCode.get("1200")).toBe(6000n);  // 100 - 40 = $60.00 remaining AR
    expect(byCode.get("4000")).toBe(10000n); // Revenue stays $100.00 (no duplication)
    expect(byCode.get("5000")).toBe(7000n);  // COGS $70.00
    expect(byCode.get("5100")).toBe(2500n);  // OpEx $25.00
    expect(snap.trialBalance.totals.every((t) => t.isBalanced)).toBe(true);
  });

  it("transfers between same-currency cashboxes without touching revenue/expense and reverses cleanly", () => {
    const tenantId = "tenant-p2-transfer";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const svc = createSandboxAccountingService(tenantId);

    svc.postOpeningBalance(owner, { idempotencyKey: "ob", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "300.00", memo: "Opening" });
    const transfer = svc.transferBetweenCashboxes(owner, { idempotencyKey: "tr-1", businessDate: "2026-11-25", fromCashboxId: "cb-usd", toCashboxId: "cb-wallet-usd", amountText: "120.00", memo: "شحن المحفظة" });

    expect(transfer.length).toBe(1);
    expect(svc.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(18000n);
    expect(svc.getCashboxStatement(owner, "cb-wallet-usd").currentBalanceMinor).toBe(12000n);
    expect(svc.getSnapshot(owner).trialBalance.rows.some((r) => r.accountCode === "4000" || r.accountCode === "5100")).toBe(false);

    svc.reverseEntryOrGroup(owner, transfer[0].id, "rev-tr-1", "2026-11-25");
    expect(svc.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(30000n);
    expect(svc.getCashboxStatement(owner, "cb-wallet-usd").currentBalanceMinor).toBe(0n);
  });

  it("executes cross-currency FX transfer in pure BigInt and atomically reverses both legs together", () => {
    const tenantId = "tenant-p2-fx";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const svc = createSandboxAccountingService(tenantId);

    svc.postOpeningBalance(owner, { idempotencyKey: "ob-usd", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "500.00", memo: "Opening USD" });
    expect(() => svc.transferBetweenCashboxes(owner, { idempotencyKey: "fx-no-quote", businessDate: "2026-11-25", fromCashboxId: "cb-usd", toCashboxId: "cb-syp", amountText: "100.00" })).toThrow(/documented FX quote/);

    const exact = convertMoneyExact(
      createMoney(10000n, "USD"),
      { code: "USD", decimalPlaces: 2 },
      { code: "SYP", decimalPlaces: 2 },
      { fromCurrency: "USD", toCurrency: "SYP", rateText: "115.50", effectiveDate: "2026-11-25", source: "السوق المحلية" },
    );
    expect(exact.amountMinor).toBe(1155000n);

    const fxBatch = svc.transferBetweenCashboxes(owner, {
      idempotencyKey: "fx-ok-1",
      businessDate: "2026-11-25",
      fromCashboxId: "cb-usd",
      toCashboxId: "cb-syp",
      amountText: "100.00",
      fxQuote: { fromCurrency: "USD", toCurrency: "SYP", rateText: "115.50", effectiveDate: "2026-11-25", source: "السوق المحلية" },
    });

    expect(fxBatch.length).toBe(2);
    expect(svc.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(40000n);
    expect(svc.getCashboxStatement(owner, "cb-syp").currentBalanceMinor).toBe(1155000n);
    expect(svc.getSnapshot(owner).trialBalance.totals.every((t) => t.isBalanced)).toBe(true);

    const revBatch = svc.reverseEntryOrGroup(owner, fxBatch[0].id, "rev-fx-1", "2026-11-25");
    expect(revBatch.length).toBe(2);
    expect(svc.getCashboxStatement(owner, "cb-usd").currentBalanceMinor).toBe(50000n);
    expect(svc.getCashboxStatement(owner, "cb-syp").currentBalanceMinor).toBe(0n);
  });

  it("closes a fiscal period with exact BigInt net income, blocks closed-period posting, and opens next period", () => {
    const tenantId = "tenant-p2-close";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const svc = createSandboxAccountingService(tenantId);
    const year = new Date().getUTCFullYear();

    svc.postOpeningBalance(owner, { idempotencyKey: "ob-c", businessDate: `${year}-06-01`, cashboxId: "cb-usd", amountText: "200.00", memo: "Opening" });
    svc.postCashSale(owner, { idempotencyKey: "sale-c", businessDate: `${year}-06-02`, currency: "USD", saleAmountText: "100.00", costAmountText: "70.00", memo: "Sale" });
    svc.postCashExpense(owner, { idempotencyKey: "exp-c", businessDate: `${year}-06-03`, cashboxId: "cb-usd", amountText: "10.00", memo: "Rent" });

    const outcome = svc.closePeriod(owner, `fy-${year}`, { id: `fy-${year + 1}`, startsOn: `${year + 1}-01-01`, endsOn: `${year + 1}-12-31` });
    expect(outcome.closedPeriod.status).toBe("closed");

    const usd = outcome.summary.currencies.find((c) => c.currency === "USD");
    expect(usd?.revenueMinor).toBe(10000n);
    expect(usd?.expenseMinor).toBe(8000n);
    expect(usd?.netIncomeMinor).toBe(2000n);
    expect(usd?.isTrialBalanceBalanced).toBe(true);

    expect(() => svc.postCashSale(owner, { idempotencyKey: "blocked", businessDate: `${year}-06-15`, currency: "USD", saleAmountText: "50.00", memo: "Blocked" })).toThrow(/closed/i);

    const nextSale = svc.postCashSale(owner, { idempotencyKey: "next-sale", businessDate: `${year + 1}-01-05`, currency: "USD", saleAmountText: "50.00", memo: "Next FY" });
    expect(nextSale.status).toBe("posted");
  });
});
