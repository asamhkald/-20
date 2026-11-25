import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { MODULE_BOUNDARIES } from "../src/modules/contracts";
import { createSandboxAccountingService } from "../src/services";
import { SupabaseAccountingStorePlaceholder } from "../src/storage";

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("Phase 1: Foundation separation, service boundary & guide example", () => {
  it("enforces strict UI separation in src/app (no core/finance, storage, localStorage, or eval)", () => {
    const uiFiles = collectTsFiles(resolve(process.cwd(), "src/app"));
    expect(uiFiles.length).toBeGreaterThanOrEqual(1);
    for (const file of uiFiles) {
      const text = readFileSync(file, "utf-8");
      expect(text).not.toMatch(/core\/finance/);
      expect(text).not.toMatch(/from\s+["'][^"']*storage/);
      expect(text).not.toContain("localStorage");
      expect(text).not.toContain("eval(");
    }
  });

  it("posts the guide example ($100 cash sale + $70 COGS = $30 gross profit) and balances trial balance", () => {
    const tenantId = "tenant-guide";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const svc = createSandboxAccountingService(tenantId);

    const posted = svc.postCashSale(owner, {
      idempotencyKey: "guide-sale-100",
      businessDate: "2026-11-25",
      currency: "USD",
      saleAmountText: "100.00",
      costAmountText: "70.00",
      memo: "Guide example",
    });

    expect(posted.status).toBe("posted");
    expect(posted.lines.length).toBe(4);

    const snap = svc.getSnapshot(owner);
    const usd = snap.trialBalance.totals.find((t) => t.currency === "USD");
    expect(usd?.isBalanced).toBe(true);
    expect(usd?.debitMinor).toBe(17000n);
    expect(usd?.creditMinor).toBe(17000n);

    const byCode = new Map(snap.trialBalance.rows.map((r) => [r.accountCode, r.normalBalanceMinor]));
    expect(byCode.get("1010")).toBe(10000n);
    expect(byCode.get("4000")).toBe(10000n);
    expect(byCode.get("5000")).toBe(7000n);
    expect(byCode.get("1300")).toBe(-7000n);
    expect((byCode.get("4000") ?? 0n) - (byCode.get("5000") ?? 0n)).toBe(3000n);
  });

  it("prevents duplicate posting via idempotency and reverses without deleting originals", () => {
    const tenantId = "tenant-rev";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const svc = createSandboxAccountingService(tenantId);

    const a = svc.postCashSale(owner, { idempotencyKey: "k-1", businessDate: "2026-11-25", currency: "USD", saleAmountText: "50.00", memo: "Sale" });
    const b = svc.postCashSale(owner, { idempotencyKey: "k-1", businessDate: "2026-11-25", currency: "USD", saleAmountText: "50.00", memo: "Sale" });
    expect(b.id).toBe(a.id);

    const rev = svc.reverseEntry(owner, a.id, "rev-1", "2026-11-25");
    expect(rev.reversalOfId).toBe(a.id);
    const snap = svc.getSnapshot(owner);
    expect(snap.entries.length).toBe(2);
    expect(snap.trialBalance.rows.find((r) => r.accountCode === "1010")?.normalBalanceMinor).toBe(0n);
    expect(() => svc.reverseEntry(owner, a.id, "rev-2", "2026-11-25")).toThrow(/already has a recorded reversal/);
  });

  it("blocks unauthorized roles and guards Phase 3 Supabase placeholder", () => {
    const tenantId = "tenant-rbac";
    const owner = { tenantId, userId: "u-owner", role: "owner" as const };
    const tech = { tenantId, userId: "u-tech", role: "technician" as const };
    const cashier = { tenantId, userId: "u-cashier", role: "cashier" as const };
    const svc = createSandboxAccountingService(tenantId);

    expect(() => svc.postCashSale(tech, { idempotencyKey: "t1", businessDate: "2026-11-25", currency: "USD", saleAmountText: "10.00", memo: "Denied" })).toThrow(/Permission/);
    const sale = svc.postCashSale(owner, { idempotencyKey: "o1", businessDate: "2026-11-25", currency: "USD", saleAmountText: "25.00", memo: "Allowed" });
    expect(() => svc.reverseEntry(cashier, sale.id, "c1", "2026-11-25")).toThrow(/Permission/);

    expect(MODULE_BOUNDARIES.every((m) => m.readyForProduction === false)).toBe(true);
    expect(() => new SupabaseAccountingStorePlaceholder().listAccounts(tenantId)).toThrow(/Phase 3/);
  });
});
