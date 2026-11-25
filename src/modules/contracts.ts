export type ModuleBoundary = Readonly<{
  moduleId: string;
  ownsTables: readonly string[];
  allowedServiceDependencies: readonly string[];
  implementationPhase: number;
  readyForProduction: boolean;
}>;

export const MODULE_BOUNDARIES: readonly ModuleBoundary[] = Object.freeze([
  { moduleId: "finance", ownsTables: ["ledger_accounts", "fiscal_periods", "journal_entries", "journal_lines", "cashboxes"], allowedServiceDependencies: ["storage"], implementationPhase: 2, readyForProduction: false },
  { moduleId: "sales", ownsTables: ["sales", "sale_lines", "sale_returns"], allowedServiceDependencies: ["finance", "inventory", "crm"], implementationPhase: 4, readyForProduction: false },
  { moduleId: "inventory", ownsTables: ["warehouses", "products", "inventory_movements"], allowedServiceDependencies: ["finance"], implementationPhase: 4, readyForProduction: false },
  { moduleId: "procurement", ownsTables: ["suppliers", "purchases", "purchase_lines"], allowedServiceDependencies: ["finance", "inventory"], implementationPhase: 4, readyForProduction: false },
  { moduleId: "crm", ownsTables: ["customers", "debts"], allowedServiceDependencies: ["finance"], implementationPhase: 4, readyForProduction: false },
  { moduleId: "operations", ownsTables: ["repair_orders", "repair_parts"], allowedServiceDependencies: ["finance", "inventory", "crm"], implementationPhase: 4, readyForProduction: false },
  { moduleId: "telecom", ownsTables: ["telecom_wallets", "telecom_topups"], allowedServiceDependencies: ["finance"], implementationPhase: 4, readyForProduction: false },
]);
