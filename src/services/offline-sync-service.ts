import { generateHiddenUuid } from "../core/enterprise";
import type { TenantContext } from "../core/tenant";
import type { AccountingWorkspaceService } from "./accounting-service";

export type OfflineOperationPayload =
  | Readonly<{ kind: "cash_sale"; businessDate: string; currency: "USD" | "SYP"; cashboxId: string; saleAmountText: string; costAmountText?: string; memo: string }>
  | Readonly<{ kind: "cash_expense"; businessDate: string; cashboxId: string; amountText: string; memo: string }>
  | Readonly<{ kind: "customer_debt_collection"; businessDate: string; cashboxId: string; amountText: string; memo: string }>
  | Readonly<{ kind: "supplier_debt_payment"; businessDate: string; cashboxId: string; amountText: string; memo: string }>;

export type OfflineQueueItem = Readonly<{
  localId: string; tenantId: string; idempotencyKey: string; payload: OfflineOperationPayload;
  status: "pending" | "synced" | "cancelled" | "failed"; attempts: number;
  createdAt: string; syncedAt?: string; syncedJournalId?: string; lastError?: string;
}>;

export type SyncFlushReport = Readonly<{ attempted: number; syncedCount: number; failedCount: number; remainingPending: number }>;

export class OfflineSyncQueueService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly queues = new Map<string, OfflineQueueItem[]>();
  constructor(accounting: AccountingWorkspaceService) { this.accounting = accounting; }

  enqueue(actor: TenantContext, payload: OfflineOperationPayload, explicitKey?: string): OfflineQueueItem {
    const key = explicitKey?.trim() || generateHiddenUuid();
    const list = this.queues.get(actor.tenantId) ?? [];
    const found = list.find((i) => i.idempotencyKey === key);
    if (found) return found;
    const item: OfflineQueueItem = Object.freeze({
      localId: `local-${generateHiddenUuid()}`, tenantId: actor.tenantId, idempotencyKey: key,
      payload: Object.freeze({ ...payload }), status: "pending", attempts: 0, createdAt: new Date().toISOString(),
    });
    list.push(item); this.queues.set(actor.tenantId, list);
    return item;
  }
  cancelPendingItem(actor: TenantContext, localId: string): OfflineQueueItem {
    const list = this.queues.get(actor.tenantId) ?? [];
    const idx = list.findIndex((i) => i.localId === localId);
    if (idx < 0) throw new Error(`Offline queue item ${localId} not found.`);
    if (list[idx].status === "synced") throw new Error("Cannot cancel synced item; post a reversal instead.");
    return (list[idx] = Object.freeze({ ...list[idx], status: "cancelled" }));
  }

  listQueue(actor: TenantContext): readonly OfflineQueueItem[] {
    return Object.freeze([...(this.queues.get(actor.tenantId) ?? [])]);
  }

  flush(actor: TenantContext, opts?: Readonly<{ shouldDropConnection?: (item: OfflineQueueItem, idx: number) => boolean }>): SyncFlushReport {
    const list = this.queues.get(actor.tenantId) ?? [];
    let attempted = 0, syncedCount = 0, failedCount = 0;
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (it.status !== "pending" && it.status !== "failed") continue;
      attempted++;
      try {
        if (opts?.shouldDropConnection?.(it, i)) throw new Error("Transient network drop.");
        const p = it.payload;
        const jId = p.kind === "cash_sale"
          ? this.accounting.postCashSale(actor, { idempotencyKey: it.idempotencyKey, ...p }).id
          : p.kind === "cash_expense"
            ? this.accounting.postCashExpense(actor, { idempotencyKey: it.idempotencyKey, ...p }).id
            : p.kind === "customer_debt_collection"
              ? this.accounting.postCustomerDebtCollection(actor, { idempotencyKey: it.idempotencyKey, ...p }).id
              : this.accounting.postSupplierDebtPayment(actor, { idempotencyKey: it.idempotencyKey, ...p }).id;
        list[i] = Object.freeze({ ...it, status: "synced", attempts: it.attempts + 1, syncedAt: new Date().toISOString(), syncedJournalId: jId, lastError: undefined });
        syncedCount++;
      } catch (err) {
        list[i] = Object.freeze({ ...it, status: "failed", attempts: it.attempts + 1, lastError: err instanceof Error ? err.message : "Sync failed" });
        failedCount++;
      }
    }
    return Object.freeze({ attempted, syncedCount, failedCount, remainingPending: list.filter((i) => i.status === "pending" || i.status === "failed").length });
  }
}
