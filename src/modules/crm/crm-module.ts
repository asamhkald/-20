import { computeDebtAging, generateHiddenUuid, type DebtAgingBuckets, type DebtItem } from "../../core/enterprise";
import { hasPermission } from "../../core/permissions";
import type { TenantContext } from "../../core/tenant";
import type { AccountingWorkspaceService } from "../../services";

export type PartyType = "customer" | "supplier";

export type Party = Readonly<{ id: string; tenantId: string; name: string; phone?: string; type: PartyType; notes?: string; isActive: boolean }>;

export type DebtLedgerEntry = Readonly<{
  id: string; tenantId: string; partyId: string; currency: "USD" | "SYP";
  deltaMinor: bigint; journalEntryId: string; businessDate: string; memo: string;
}>;

export type PartyBalanceSummary = Readonly<{
  party: Party; balancesByCurrency: Readonly<Record<string, bigint>>; entries: readonly DebtLedgerEntry[];
}>;

export class CrmDebtModuleService {
  private readonly accounting: AccountingWorkspaceService;
  private readonly parties = new Map<string, Party[]>();
  private readonly ledger = new Map<string, DebtLedgerEntry[]>();

  constructor(accounting: AccountingWorkspaceService) {
    this.accounting = accounting;
  }

  registerParty(actor: TenantContext, input: Readonly<{ id?: string; name: string; phone?: string; type: PartyType; notes?: string }>): Party {
    const req = input.type === "customer" ? "sales.write" : "procurement.write";
    if (!hasPermission(actor.role, req) && !hasPermission(actor.role, "finance.post")) throw new Error(`Permission denied to register ${input.type}.`);
    const name = input.name.trim();
    if (!name) throw new Error("Party name is required.");
    const list = this.parties.get(actor.tenantId) ?? [];
    const party: Party = Object.freeze({
      id: input.id?.trim() || generateHiddenUuid(), tenantId: actor.tenantId, name,
      phone: input.phone?.trim() || undefined, type: input.type, notes: input.notes?.trim() || undefined, isActive: true,
    });
    list.push(party);
    this.parties.set(actor.tenantId, list);
    return party;
  }

  getPartyOrThrow(tenantId: string, partyId: string, expectedType?: PartyType): Party {
    const found = (this.parties.get(tenantId) ?? []).find((p) => p.id === partyId && p.isActive);
    if (!found) throw new Error(`Party ${partyId} was not found.`);
    if (expectedType && found.type !== expectedType) throw new Error(`Party "${found.name}" is a ${found.type}, expected ${expectedType}.`);
    return found;
  }

  listParties(actor: TenantContext, type?: PartyType): readonly Party[] {
    if (!hasPermission(actor.role, "sales.read") && !hasPermission(actor.role, "procurement.read") && !hasPermission(actor.role, "finance.read")) {
      throw new Error("Permission denied to list parties.");
    }
    const all = this.parties.get(actor.tenantId) ?? [];
    return Object.freeze(type ? all.filter((p) => p.type === type) : [...all]);
  }

  recordSubledgerEntry(entry: Omit<DebtLedgerEntry, "id">): DebtLedgerEntry {
    const rec: DebtLedgerEntry = Object.freeze({ ...entry, id: generateHiddenUuid() });
    const list = this.ledger.get(entry.tenantId) ?? [];
    list.push(rec);
    this.ledger.set(entry.tenantId, list);
    return rec;
  }

  reverseSubledgerEntriesForJournal(tenantId: string, originalJournalId: string, reversalJournalId: string, businessDate: string): void {
    const list = this.ledger.get(tenantId) ?? [];
    const linked = list.filter((e) => e.journalEntryId === originalJournalId);
    for (const item of linked) {
      list.push(Object.freeze({
        id: generateHiddenUuid(), tenantId, partyId: item.partyId, currency: item.currency,
        deltaMinor: -item.deltaMinor, journalEntryId: reversalJournalId, businessDate, memo: `عكس: ${item.memo}`,
      }));
    }
    this.ledger.set(tenantId, list);
  }

  getPartyBalance(actor: TenantContext, partyId: string): PartyBalanceSummary {
    const party = this.getPartyOrThrow(actor.tenantId, partyId);
    const entries = (this.ledger.get(actor.tenantId) ?? []).filter((e) => e.partyId === party.id);
    const totals: Record<string, bigint> = {};
    for (const e of entries) totals[e.currency] = (totals[e.currency] ?? 0n) + e.deltaMinor;
    return Object.freeze({ party, balancesByCurrency: Object.freeze(totals), entries: Object.freeze([...entries]) });
  }

  collectCustomerPayment(
    actor: TenantContext,
    input: Readonly<{ idempotencyKey: string; businessDate: string; customerId: string; cashboxId: string; amountText: string; memo?: string }>,
  ): Readonly<{ journalEntryId: string; remainingDebtMinor: bigint }> {
    const customer = this.getPartyOrThrow(actor.tenantId, input.customerId, "customer");
    const je = this.accounting.postCustomerDebtCollection(actor, {
      idempotencyKey: input.idempotencyKey, businessDate: input.businessDate, cashboxId: input.cashboxId,
      amountText: input.amountText, memo: input.memo?.trim() || `تحصيل دفعة دين من ${customer.name}`,
    });
    const cashLine = je.lines.find((l) => l.debitMinor > 0n);
    const amountMinor = cashLine?.debitMinor ?? 0n;
    const currency = (cashLine?.currency ?? "USD") as "USD" | "SYP";

    if (!(this.ledger.get(actor.tenantId) ?? []).some((e) => e.journalEntryId === je.id && e.partyId === customer.id) && amountMinor > 0n) {
      this.recordSubledgerEntry({ tenantId: actor.tenantId, partyId: customer.id, currency, deltaMinor: -amountMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: je.memo });
    }
    const bal = this.getPartyBalance(actor, customer.id).balancesByCurrency[currency] ?? 0n;
    return Object.freeze({ journalEntryId: je.id, remainingDebtMinor: bal });
  }

  paySupplierDebt(
    actor: TenantContext,
    input: Readonly<{ idempotencyKey: string; businessDate: string; supplierId: string; cashboxId: string; amountText: string; memo?: string; allowNegativeBalance?: boolean }>,
  ): Readonly<{ journalEntryId: string; remainingPayableMinor: bigint }> {
    const supplier = this.getPartyOrThrow(actor.tenantId, input.supplierId, "supplier");
    const je = this.accounting.postSupplierDebtPayment(actor, {
      idempotencyKey: input.idempotencyKey, businessDate: input.businessDate, cashboxId: input.cashboxId,
      amountText: input.amountText, memo: input.memo?.trim() || `سداد دفعة للمورد ${supplier.name}`, allowNegativeBalance: input.allowNegativeBalance,
    });
    const apLine = je.lines.find((l) => l.debitMinor > 0n);
    const amountMinor = apLine?.debitMinor ?? 0n;
    const currency = (apLine?.currency ?? "USD") as "USD" | "SYP";

    if (!(this.ledger.get(actor.tenantId) ?? []).some((e) => e.journalEntryId === je.id && e.partyId === supplier.id) && amountMinor > 0n) {
      this.recordSubledgerEntry({ tenantId: actor.tenantId, partyId: supplier.id, currency, deltaMinor: -amountMinor, journalEntryId: je.id, businessDate: input.businessDate, memo: je.memo });
    }
    const bal = this.getPartyBalance(actor, supplier.id).balancesByCurrency[currency] ?? 0n;
    return Object.freeze({ journalEntryId: je.id, remainingPayableMinor: bal });
  }

  getDebtAging(actor: TenantContext, partyType: PartyType, currency: "USD" | "SYP", asOfIso: string): DebtAgingBuckets {
    const matchingParties = new Set((this.parties.get(actor.tenantId) ?? []).filter((p) => p.type === partyType).map((p) => p.id));
    const entries = (this.ledger.get(actor.tenantId) ?? []).filter((e) => matchingParties.has(e.partyId) && e.currency === currency);
    const openItems: DebtItem[] = [];
    for (const partyId of matchingParties) {
      const partyEntries = entries.filter((e) => e.partyId === partyId);
      const charges = partyEntries.filter((e) => e.deltaMinor > 0n);
      let paymentsLeft = partyEntries.filter((e) => e.deltaMinor < 0n).reduce((s, e) => s + (-e.deltaMinor), 0n);
      for (const ch of charges) {
        let outstanding = ch.deltaMinor;
        if (paymentsLeft > 0n) {
          const applied = paymentsLeft >= outstanding ? outstanding : paymentsLeft;
          outstanding -= applied;
          paymentsLeft -= applied;
        }
        if (outstanding > 0n) openItems.push({ id: ch.id, outstandingMinor: outstanding, currency, issuedAtIso: `${ch.businessDate}T00:00:00.000Z` });
      }
    }
    return computeDebtAging(openItems, currency, asOfIso);
  }
}
