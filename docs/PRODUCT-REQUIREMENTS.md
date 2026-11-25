# وثيقة متطلبات المنتج — Sama Business

## الرؤية
منصة أعمال عالمية متعددة الشركات والأنشطة، تعتمد وحدات مستقلة تتشارك نواة مالية وهوية وصلاحيات موحدة.

## شرائح العملاء
1. المتاجر الصغيرة ونقاط البيع.
2. محلات الهواتف والإلكترونيات والصيانة.
3. تجارة الجملة والتوزيع.
4. الشركات التجارية متعددة الفروع.
5. المؤسسات الخدمية وشركات الصيانة.
6. شركات الاشتراكات والاتصالات والإنترنت.

## مبادئ المنتج
- Multi-tenant: عزل صارم لكل شركة/مستأجر.
- Modular: تفعيل الوحدات بحسب الخطة والنشاط.
- Multi-branch: فروع ومستودعات ومراكز تكلفة.
- Multi-currency: عملة وظيفية وعملات معاملات مع فروقات صرف موثقة.
- Bilingual: العربية والإنجليزية من الأساس مع RTL/LTR.
- Auditability: أثر تدقيقي للعمليات الحساسة.
- Offline-resilient: طوابير مزامنة آمنة مع منع التكرار.
- API-first: خدمات قابلة للتكامل لاحقاً.

## الأدوار الأولية
Owner, Organization Admin, Finance Manager, Accountant, Branch Manager, Cashier, Sales, Procurement, Inventory, Technician, Auditor, Read-only.

يجب أن تكون الصلاحيات على مستوى الخادم وقاعدة البيانات، لا على مستوى إخفاء عناصر الواجهة فقط.

## نطاق الوحدات
### Foundation
- Organizations, memberships, roles, branches.
- Chart of accounts, fiscal periods, journals, journal lines.
- Customers, suppliers, currencies, exchange rates.
- Audit events, attachments metadata, settings.

### Commerce
- Products/services, price lists, quotations, orders, invoices, returns, POS.

### Supply chain
- Purchase orders, receipts, supplier bills, warehouses, stock movements, costing, counts.

### Specialized
- Telecom balances and bundles, repair tickets, installments, internet subscriptions, sales representatives.

### Enterprise
- CRM, projects, contracts, HR, payroll, approvals, analytics, integrations.

## معايير قبول أساسية
- كل قيد مرحّل متوازن.
- لا يمكن تعديل قيد مرحّل مباشرة؛ التصحيح بقيد عكسي موثق.
- كل سجل أعمال مرتبط بمستأجر وفرع عند الحاجة.
- لا توجد عملية بيع أو شراء جزئية بين المخزون والقيد المالي.
- تكرار الطلب الشبكي لا يكرر الأثر المالي.
- لا يمكن لمستخدم الوصول إلى مستأجر آخر.
- يمكن إعادة بناء رصيد الحساب من دفتر القيود.
- يمكن تصدير بيانات العميل واستعادتها وفق صلاحيات موثقة.
