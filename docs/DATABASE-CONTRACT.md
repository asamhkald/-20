# Database integration contract — draft, not a migration

This document describes the minimum contract required for the first real database integration. It is not SQL to run against the current production database.

## Required source inspection

Before mapping or writing any records, obtain a schema-only export containing tables, columns, constraints, foreign keys, indexes, views, triggers, functions, RLS policies, grants and migration history. Inspect the complete application source and its existing data access paths. Take a verified backup and perform a restore test in a separate environment.

## Target logical records

- `organizations`: legal/business tenant identity and base preferences.
- `organization_members`: user-to-tenant membership and role.
- `branches`: optional operating locations within a tenant.
- `currencies`: ISO-like currency code and explicit decimal precision.
- `fiscal_periods`: tenant-scoped date ranges and open/closed state.
- `ledger_accounts`: tenant-scoped chart of accounts.
- `journal_entries`: immutable posted header, tenant-local `business_date`, status and reversal reference.
- `journal_lines`: account, currency, integer minor-unit debit/credit values.
- `idempotency_records`: tenant-scoped unique request keys and completed result references.
- `audit_events`: actor, tenant, action, entity reference and timestamp.

These are logical target concepts only. They are not claims about tables that already exist in the user's database.

## Integrity requirements

1. Every tenant-owned row has a non-null tenant key.
2. Foreign keys that cross tenant-owned records must include tenant identity in the relationship or be guarded by an equivalent database constraint.
3. Posted journal entries cannot be updated or deleted by ordinary application roles.
4. A journal entry must have at least two non-zero lines and total debit equal total credit for the same currency.
5. A unique constraint on `(tenant_id, reversal_of_id)` must prevent more than one reversal for a posted entry, unless a documented correction workflow explicitly supports multiple reversals.
6. Journal posting, related source-document state changes, stock movements and idempotency completion must commit in one server-side transaction.
7. Every tenant-facing table must have RLS enabled and policies tested for cross-tenant read and write denial.

## BigInt persistence boundary

The TypeScript domain uses `bigint` for minor units, with a 38-digit limit aligned to the proposed storage contract. JSON cannot encode BigInt. Convert amounts to base-10 integer strings at the API boundary, then store them in PostgreSQL `NUMERIC(38,0)` (or another explicitly reviewed exact type). Never pass them through JavaScript `Number`.

## Safe rollout sequence

1. Inventory the current schema and application reads/writes.
2. Map old records to target concepts without changing data.
3. Build an isolated development database and test import there.
4. Validate row counts, totals by currency, open balances, stock quantities and journal trial balance.
5. Additive migration only; no destructive rename/drop/overwrite in the initial rollout.
6. Dual-read or controlled cutover with a rollback plan.
7. Verify backups and reconciliation after cutover.
