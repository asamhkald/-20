# المعمارية المستهدفة

## اختيار معماري
ابدأ Modular Monolith منظماً، وليس Microservices مبكراً. الوحدات مستقلة بحدود واضحة وواجهات خدمات، ويمكن فصلها لاحقاً عند وجود سبب تشغيلي حقيقي.

## الطبقات
1. Presentation: React/TypeScript، تصميم متجاوب، دعم RTL/LTR.
2. Application: use-cases مثل PostInvoice وReceivePayment وTransferStock.
3. Domain: قواعد المحاسبة والمخزون والديون دون اعتماد على React أو Supabase.
4. Infrastructure: PostgreSQL/Supabase، التخزين، البريد، الإشعارات، المزامنة.
5. Security: tenant context، membership، RBAC، RLS، audit.

## حدود الوحدات
- Finance owns journal posting and account balances.
- Sales owns quotations/orders/invoices; Finance receives posting requests.
- Inventory owns stock ledger and valuation.
- Procurement owns purchase lifecycle.
- Specialized modules call shared application services; they must not write journal rows directly.
- All cross-module business operations use server-side transactional use cases.

## قواعد البيانات
التصميم المستهدف يتضمن organization/tenant, memberships, branches, fiscal_periods, accounts, journal_entries, journal_lines, currencies, exchange_rates, customers, suppliers, products, warehouses, stock_movements, sales_documents, purchase_documents, audit_events, idempotency_keys.

هذه أسماء مفاهيم مستهدفة وليست وصفاً للجداول الموجودة في قاعدة المستخدم. لا تنفذ أي DDL قبل فحص المخطط الحالي ورسم mapping وترحيل متوافق.

## المحاسبة والتقارير
- Trial balance is derived from posted journal lines and reported separately per currency. Never net or add different currencies together without a recorded FX conversion.
- Reversals are new entries linked to the original posted entry; source immutability is enforced in the domain and must be backed by database constraints.

## المعاملات
- ترحيل القيد، تحديث حالة الفاتورة، حركة المخزون، واستهلاك مفتاح idempotency يجب أن تتم ضمن معاملة قاعدة بيانات واحدة.
- لا تعتمد على سلسلة طلبات متصفح مستقلة لضمان الاتساق.
- استخدم RPC/خدمة خادمية ذات صلاحيات محدودة، مع التحقق من tenant membership.
- القيود المرحلة غير قابلة للتعديل؛ التصحيح بقيود عكسية.
- لا تخلط عملات مختلفة في جمع مباشر. استخدم أرجل صرف واضحة وأسعاراً مؤرخة.

## المبالغ
خزن المبالغ بوحدات صحيحة صغرى مع رمز العملة ودقة العملة. لا تستخدم float/double لتخزين أو جمع مبالغ مالية مرحّلة. حدد سياسة التقريب لكل عملة ووثّقها. الحد الحالي في النواة هو 38 رقماً لوحدة العملة الصغرى، بما يتوافق مع عقد التخزين المقترح `NUMERIC(38,0)`.

كل قيد يحمل `businessDate` محلياً للشركة بصورة مستقلة عن الطابع الزمني `occurredAt`؛ تستخدم الفترات المالية تاريخ العمل business date ولا تستنتجه من تحويل UTC.
