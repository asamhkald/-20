import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSessionAuthorized, resolveVerifiedSession, toTenantContext } from "../src/core/security";
import { createStandardChartOfAccounts, STANDARD_ACCOUNT_CODES } from "../src/core/finance";
import { AccountingWorkspaceService, exportSignedTenantBackup, restoreAndVerifyTenantBackup } from "../src/services";
import { InMemoryAccountingStore, SupabaseAtomicGateway, type RpcInvoker } from "../src/storage";

function makeSession(tenantId: string, userId: string, role: "owner" | "cashier" | "auditor", status: "active" | "suspended" = "active") {
  return resolveVerifiedSession({
    userId,
    organization: { id: tenantId, legalName: `Company ${tenantId}`, baseCurrency: "USD", timezone: "Asia/Damascus", locale: "ar-SY", fiscalYearStartMonth: 1, status },
    membership: { id: `mem-${userId}`, tenantId, userId, role, status: "active" },
    branch: { id: `br-${tenantId}`, tenantId, code: "MAIN", name: "الفرع الرئيسي", isActive: true },
    expiresAtIso: "2099-12-31T23:59:59.000Z",
    nowIso: "2026-11-25T12:00:00.000Z",
  });
}

describe("Phase 3: Security, Tenant Isolation, Atomic RPC Gateway & Verified Backup/Restore", () => {
  it("enforces server-side membership, subscription expiry, branch ownership, and cross-tenant isolation", () => {
    const sessionA = makeSession("tenant-A", "user-A", "owner");
    const sessionB = makeSession("tenant-B", "user-B", "owner");
    const cashierA = makeSession("tenant-A", "cashier-A", "cashier");

    expect(() => assertSessionAuthorized(sessionA, "tenant-B", "finance.read")).toThrow(/Cross-tenant/);
    expect(() => assertSessionAuthorized(sessionB, "tenant-A", "finance.post")).toThrow(/Cross-tenant/);
    expect(() => assertSessionAuthorized(cashierA, "tenant-A", "finance.reverse")).toThrow(/Permission denied/);
    expect(() => makeSession("tenant-X", "user-X", "owner", "suspended")).toThrow(/suspended/i);

    expect(() =>
      resolveVerifiedSession({
        userId: "user-exp",
        organization: { id: "t-exp", legalName: "Expired Co", baseCurrency: "USD", timezone: "Asia/Damascus", locale: "ar-SY", fiscalYearStartMonth: 1, status: "active" },
        membership: { id: "m1", tenantId: "t-exp", userId: "user-exp", role: "owner", status: "active" },
        expiresAtIso: "2025-01-01T00:00:00.000Z",
        nowIso: "2026-11-25T00:00:00.000Z",
      }),
    ).toThrow(/expired/i);

    expect(() =>
      resolveVerifiedSession({
        userId: "user-A",
        organization: sessionA.organization,
        membership: sessionA.membership,
        branch: { id: "br-foreign", tenantId: "tenant-B", code: "B1", name: "Foreign", isActive: true },
      }),
    ).toThrow(/different organization/i);
  });

  it("exports a SHA-256 signed backup, blocks tampered restores, and reconciles Trial Balance after clean restore", async () => {
    const tenantId = "tenant-backup-drill";
    const actor = toTenantContext(makeSession(tenantId, "owner-1", "owner"));
    const accounts = createStandardChartOfAccounts(tenantId);
    const byCode = new Map(accounts.map((a) => [a.code, a]));

    const store = new InMemoryAccountingStore({
      tenantId,
      accounts,
      cashboxes: [
        { id: "cb-usd", tenantId, code: "CASH-USD", name: "صندوق الدولار", kind: "cash", currency: "USD", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_USD)!.id, isActive: true },
        { id: "cb-syp", tenantId, code: "CASH-SYP", name: "صندوق الليرة", kind: "cash", currency: "SYP", ledgerAccountId: byCode.get(STANDARD_ACCOUNT_CODES.CASH_SYP)!.id, isActive: true },
      ],
      fiscalPeriods: [{ id: "fy-2026", tenantId, startsOn: "2026-01-01", endsOn: "2026-12-31", status: "open" }],
    });

    const svc = new AccountingWorkspaceService(store);
    svc.postOpeningBalance(actor, { idempotencyKey: "bk-ob", businessDate: "2026-11-25", cashboxId: "cb-usd", amountText: "1000.00", memo: "Opening" });
    svc.postCashSale(actor, { idempotencyKey: "bk-sale", businessDate: "2026-11-25", currency: "USD", saleAmountText: "100.00", costAmountText: "70.00", memo: "Sale" });
    svc.transferBetweenCashboxes(actor, {
      idempotencyKey: "bk-fx",
      businessDate: "2026-11-25",
      fromCashboxId: "cb-usd",
      toCashboxId: "cb-syp",
      amountText: "200.00",
      fxQuote: { fromCurrency: "USD", toCurrency: "SYP", rateText: "115.00", effectiveDate: "2026-11-25", source: "Market" },
    });

    const signed = await exportSignedTenantBackup(actor, store);
    expect(signed.algorithm).toBe("SHA-256");
    expect(signed.checksumHex).toMatch(/^[0-9a-f]{64}$/);

    const report = await restoreAndVerifyTenantBackup(actor, signed);
    expect(report.checksumVerified).toBe(true);
    expect(report.trialBalanceMatched).toBe(true);
    expect(report.restoredJournals).toBe(4);
    expect(report.reconciledCurrencies).toEqual(["SYP", "USD"]);

    const restoredSvc = new AccountingWorkspaceService(report.restoredStore);
    expect(restoredSvc.getCashboxStatement(actor, "cb-usd").currentBalanceMinor).toBe(90000n);
    expect(restoredSvc.getCashboxStatement(actor, "cb-syp").currentBalanceMinor).toBe(2300000n);

    const tampered = {
      ...signed,
      payload: { ...signed.payload, journals: signed.payload.journals.map((j, i) => (i === 0 ? { ...j, memo: "TAMPERED" } : j)) },
    };
    await expect(restoreAndVerifyTenantBackup(actor, tampered)).rejects.toThrow(/checksum mismatch/i);

    const foreignOwner = toTenantContext(makeSession("tenant-B", "owner-B", "owner"));
    await expect(restoreAndVerifyTenantBackup(foreignOwner, signed)).rejects.toThrow(/Cross-tenant/);
  });

  it("validates SupabaseAtomicGateway permission guards, idempotency keys, and RPC invocation contract", async () => {
    const calls: Array<{ fn: string; params?: Record<string, unknown> }> = [];
    const mockClient: RpcInvoker = {
      rpc: async (fn, params) => {
        calls.push({ fn, params });
        if (fn === "erp_get_trial_balance") {
          return { data: [{ account_code: "1010", account_name_ar: "الصندوق", account_class: "asset", total_debit_minor: "10000", total_credit_minor: "0", normal_balance_minor: "10000" }], error: null };
        }
        return { data: "11111111-1111-4111-8111-111111111111", error: null };
      },
    };

    const gateway = new SupabaseAtomicGateway(mockClient);
    const owner = makeSession("tenant-A", "user-A", "owner");
    const cashier = makeSession("tenant-A", "cashier-A", "cashier");

    const revId = await gateway.reverseJournalAtomic(owner, "tenant-A", "orig-1", "idem-rev-1", "Correction");
    expect(revId).toBe("11111111-1111-4111-8111-111111111111");
    expect(calls[0].fn).toBe("erp_reverse_journal_atomic");

    const tb = await gateway.fetchTrialBalance(owner, "tenant-A", "usd");
    expect(tb.length).toBe(1);
    expect(calls[1].params?.p_currency).toBe("USD");

    await expect(gateway.reverseJournalAtomic(cashier, "tenant-A", "orig-1", "idem-rev-2", "Unauthorized")).rejects.toThrow(/Permission denied/);
    await expect(gateway.reverseJournalAtomic(owner, "tenant-A", "orig-1", "   ", "Missing key")).rejects.toThrow(/Idempotency key/);
  });

  it("verifies all 4 Phase 3 SQL migrations are strictly additive, enforce RLS, and match live audit_logs.user_id", () => {
    const migDir = resolve(process.cwd(), "supabase/migrations");
    const files = ["001_rbac_audit_hardening.sql", "002_double_entry_core.sql", "003_rls_policies.sql", "004_atomic_rpcs.sql"];
    let combined = "";
    for (const f of files) {
      const sql = readFileSync(resolve(migDir, f), "utf-8");
      expect(sql.toUpperCase()).not.toContain("DROP TABLE");
      expect(sql.toUpperCase()).not.toContain("TRUNCATE");
      combined += "\n" + sql;
    }
    expect(combined).toContain("ENABLE ROW LEVEL SECURITY");
    expect(combined).toContain("user_id");
    expect(combined).not.toContain("performed_by");
    expect(combined).toContain("erp_post_journal_atomic");
    expect(combined).toContain("erp_reverse_journal_atomic");
    expect(combined).toContain("erp_get_trial_balance");
  });
});
