# Implementation status

Updated: 2026-11-24

## Implemented in this foundation build

- Bilingual Arabic/English responsive workspace shell.
- Searchable module roadmap with explicit phase labels.
- Integer minor-unit money model and decimal-string parsing/serialization.
- Currency mismatch guards and exact arithmetic.
- Journal validation: tenant, line IDs, account references, currency, debit/credit shape, positive lines and balance.
- Fiscal-period validation and closed-period posting guard.
- Posting as a pure domain operation; reversal creates a new entry rather than editing the original.
- Basic role-to-permission map, organization/branch validation and active-membership tenant-context resolution.
- Trial balance aggregation by account and currency; posted journal snapshots are frozen at runtime.
- 16 repository unit tests authored; they passed under a lightweight local compatibility runner. The actual Vitest executable was not installed in this environment.

## Not implemented / not verified

- No real authentication session or server-side membership lookup is connected.
- No database schema, SQL migration, RLS policy or production RPC has been installed.
- No live Supabase project is configured.
- No import or migration of legacy user records has been performed.
- Sales, purchases, inventory, payroll, CRM, telecom, debt and maintenance are roadmap modules, not working business features yet.
- Dependency installation, actual Vitest run and production build remain pending because `npm install` timed out in this environment; UI type validation used temporary ambient declarations, not the real React/Vite package types.

## Release gate

Do not connect production data until the full legacy source and schema-only export are reviewed, a backup restore has been proven, RLS isolation tests pass, and financial reconciliation has been signed off.
