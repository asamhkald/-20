# Changelog

## 1.1.0 — Sama Business Enterprise (IFRS, Multi-Warehouse, FX & 5-Role RBAC)

- **IFRS Financial Statements:** Built-in Income Statement (P&L), Double-Entry Trial Balance (Debit = Credit), Balance Sheet Snapshot, and AR/AP Debt Aging Report (0–30, 31–60, 61–90, 90+ days) with one-click print and WhatsApp reminders.
- **IAS 21 Multi-Currency FX Engine:** Explicit USD ↔ SYP currency exchange wizard, historical rate log, and automatic realized FX Gain/Loss calculation.
- **Odoo/SAP-Grade Multi-Warehouse Inventory:** Multiple warehouses, stock transfers between warehouses, damaged/expired write-offs, sales returns restoring stock, hidden RFC-4122 v4 UUID per SKU, cost/profit calculation (wholesale cost hidden from non-owner roles).
- **Maintenance & Spare Parts Integration:** Repair tickets link directly to warehouse spare parts (auto-deducting stock and computing net profit) with IMEI and warranty tracking.
- **Partial Debt Payments:** Apply partial payments directly to customer/supplier debts with automatic cashbox posting.
- **5-Role Staff RBAC & PIN Shift Switcher (ISO 27001 / NIST CSF 2.0):** Owner, Accountant, Cashier, Sales, and Technician roles with per-role screen & wholesale cost restrictions, SHA-256 PIN lock, and additive Supabase SQL (`docs/PHASE2-RBAC-AUDIT-MIGRATION.sql`).
- **Automated Financial Integrity Audit Suite:** On-demand pre-close audit detecting unbalanced entries, duplicate reversals, negative cashboxes, low stock, and UUID conflicts.
- **Arabic Voice AI (`ar-SA`):** Natural Arabic voice commands for transactions, ledger search, and memos.
