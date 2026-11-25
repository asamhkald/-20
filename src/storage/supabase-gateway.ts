import { assertSessionAuthorized, type VerifiedSessionContext } from "../core/security";
import type { JournalEntry } from "../core/journal";

export type RpcTrialBalanceRow = Readonly<{
  account_code: string;
  account_name_ar: string;
  account_class: string;
  total_debit_minor: string;
  total_credit_minor: string;
  normal_balance_minor: string;
}>;

export type RpcInvoker = Readonly<{
  rpc(fn: string, params?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}>;

export class SupabaseAtomicGateway {
  private readonly client: RpcInvoker;

  constructor(client: RpcInvoker) {
    this.client = client;
  }

  async postBalancedJournal(
    session: VerifiedSessionContext,
    idempotencyKey: string,
    draft: JournalEntry,
    sourceModule = "core",
  ): Promise<string> {
    assertSessionAuthorized(session, draft.tenantId, "finance.post");
    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required for atomic RPC posting.");

    const linesPayload = draft.lines.map((line) => ({
      account_code: line.accountId,
      currency: line.currency,
      debit_minor: line.debitMinor.toString(),
      credit_minor: line.creditMinor.toString(),
      line_memo: line.description ?? "",
    }));

    const { data, error } = await this.client.rpc("erp_post_journal_atomic", {
      p_idempotency_key: cleanKey,
      p_business_date: draft.businessDate,
      p_memo: draft.memo,
      p_source_module: sourceModule,
      p_lines: linesPayload,
    });
    if (error) throw new Error(`Atomic journal RPC failed: ${error.message}`);
    if (typeof data !== "string" || !data) throw new Error("Atomic journal RPC returned an invalid journal ID.");
    return data;
  }

  async reverseJournalAtomic(
    session: VerifiedSessionContext,
    tenantId: string,
    originalJournalId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<string> {
    assertSessionAuthorized(session, tenantId, "finance.reverse");
    const cleanKey = idempotencyKey.trim();
    if (!cleanKey) throw new Error("Idempotency key is required for atomic reversal.");

    const { data, error } = await this.client.rpc("erp_reverse_journal_atomic", {
      p_original_journal_id: originalJournalId,
      p_idempotency_key: cleanKey,
      p_reason: reason.trim() || "تصحيح قيد محاسبي",
    });
    if (error) throw new Error(`Atomic reversal RPC failed: ${error.message}`);
    if (typeof data !== "string" || !data) throw new Error("Atomic reversal RPC returned an invalid reversal ID.");
    return data;
  }

  async fetchTrialBalance(
    session: VerifiedSessionContext,
    tenantId: string,
    currency: string,
  ): Promise<readonly RpcTrialBalanceRow[]> {
    assertSessionAuthorized(session, tenantId, "finance.read");
    const cur = currency.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new Error("Currency must be a 3-letter uppercase code.");

    const { data, error } = await this.client.rpc("erp_get_trial_balance", { p_currency: cur });
    if (error) throw new Error(`Trial balance RPC failed: ${error.message}`);
    return Object.freeze((Array.isArray(data) ? data : []) as RpcTrialBalanceRow[]);
  }
}
