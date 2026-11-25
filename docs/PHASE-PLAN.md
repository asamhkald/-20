# خارطة التنفيذ المرحلية

## Phase 0 — Discovery & Safety
المخرجات: schema inventory، data dictionary، threat model، baseline tests، backup/restore proof.
بوابة الخروج: فهم كامل لمخطط الإنتاج وعدم وجود أسرار ضمن المستودع.

## Phase 1 — Foundation (in progress)
Domain baseline now includes organization/branch/membership validation, role permissions, exact money, account validation, fiscal periods, balanced journal validation, immutable posting, reversal creation and per-currency trial balance. Database authentication, RLS, audit persistence, currency master data and transactional posting RPC remain pending until the real schema is inspected.
بوابة الخروج: اختبارات عزل المستأجرين على قاعدة staging، القيود المتوازنة، إعادة بناء الأرصدة، وفحص التزامن والنسخ الاحتياطي.

## Phase 2 — Commerce & Inventory
Products, price lists, customers, suppliers, POS, sales invoices, purchases, warehouses, stock ledger, valuation.
بوابة الخروج: فاتورة بيع/شراء ذرية ومتوازنة ومطابقة للمخزون.

## Phase 3 — Specialized Operations
Maintenance, telecom, installments, internet subscriptions, reps and commissions.
بوابة الخروج: كل حدث تشغيلي ينتج آثاراً مالية ومخزنية صحيحة مرة واحدة.

## Phase 4 — Enterprise
CRM, projects, contracts, HR, payroll, approvals, multi-branch workflows.
بوابة الخروج: صلاحيات وموافقات وتقارير عبر الفروع.

## Phase 5 — Intelligence & Globalization
Arabic/English, localization, time zones, tax configuration by jurisdiction, analytics, APIs, integrations.
بوابة الخروج: اختبار لغوي/إقليمي وخصوصية وأداء.

## Phase 6 — Release Readiness
Load tests, penetration testing, disaster recovery, accessibility, observability, support runbooks.
بوابة الخروج: موافقة تشغيلية موثقة.
