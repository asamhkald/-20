export type ModuleDefinition = {
  id: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  phase: number;
};

/** Product roadmap metadata only. Presence here does not mean the module is implemented. */
export const MODULES: readonly ModuleDefinition[] = [
  { id: "finance", name: "Finance & Accounting", nameAr: "المالية والمحاسبة", description: "General ledger, journals, cash, receivables and payables.", descriptionAr: "دفتر الأستاذ والقيود والصندوق والذمم المدينة والدائنة.", phase: 1 },
  { id: "sales", name: "Sales & POS", nameAr: "المبيعات ونقاط البيع", description: "Quotes, orders, invoices, returns and point of sale.", descriptionAr: "عروض الأسعار والطلبات والفواتير والمرتجعات ونقاط البيع.", phase: 2 },
  { id: "inventory", name: "Inventory & Warehouses", nameAr: "المخزون والمستودعات", description: "Products, stock movements, warehouses and costing.", descriptionAr: "الأصناف وحركات المخزون والمستودعات واحتساب التكلفة.", phase: 2 },
  { id: "procurement", name: "Procurement", nameAr: "المشتريات", description: "Suppliers, purchase orders, bills and supplier returns.", descriptionAr: "الموردون وطلبات الشراء وفواتير الموردين والمرتجعات.", phase: 2 },
  { id: "crm", name: "Customer Relations", nameAr: "إدارة العملاء", description: "Customer records, opportunities and follow-ups.", descriptionAr: "ملفات العملاء والفرص والمتابعات وسجل التواصل.", phase: 3 },
  { id: "people", name: "People & HR", nameAr: "الموارد البشرية", description: "Employees, roles, attendance and payroll foundations.", descriptionAr: "الموظفون والأدوار والحضور وأسس الرواتب.", phase: 4 },
  { id: "operations", name: "Services & Operations", nameAr: "الخدمات والتشغيل", description: "Work orders, maintenance and service delivery.", descriptionAr: "أوامر العمل والصيانة وتنفيذ الخدمات.", phase: 3 },
  { id: "telecom", name: "Telecom & Digital Products", nameAr: "الاتصالات والمنتجات الرقمية", description: "Operator balances, bundles, top-ups and commissions.", descriptionAr: "أرصدة شركات الاتصالات والباقات والتعبئة والعمولات.", phase: 3 },
  { id: "reports", name: "Analytics & Reporting", nameAr: "التقارير والتحليلات", description: "Financial statements, KPIs and management reports.", descriptionAr: "القوائم المالية ومؤشرات الأداء والتقارير الإدارية.", phase: 5 },
];
