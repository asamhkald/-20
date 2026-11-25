import type { TenantRole } from "./tenant";

export type Permission =
  | "finance.read" | "finance.post" | "finance.reverse"
  | "sales.read" | "sales.write"
  | "inventory.read" | "inventory.write"
  | "procurement.read" | "procurement.write"
  | "operations.read" | "operations.write"
  | "people.read" | "people.write"
  | "settings.manage" | "audit.read";

const fullAccess: readonly Permission[] = [
  "finance.read", "finance.post", "finance.reverse", "sales.read", "sales.write",
  "inventory.read", "inventory.write", "procurement.read", "procurement.write",
  "operations.read", "operations.write", "people.read", "people.write",
  "settings.manage", "audit.read",
];

const ROLE_PERMISSIONS: Record<TenantRole, readonly Permission[]> = {
  owner: fullAccess,
  admin: fullAccess,
  org_admin: fullAccess,
  finance_manager: ["finance.read", "finance.post", "finance.reverse", "sales.read", "inventory.read", "procurement.read", "audit.read"],
  accountant: ["finance.read", "finance.post", "sales.read", "inventory.read", "procurement.read", "audit.read"],
  branch_manager: ["finance.read", "sales.read", "sales.write", "inventory.read", "inventory.write", "procurement.read", "procurement.write", "operations.read", "operations.write"],
  cashier: ["finance.read", "sales.read", "sales.write"],
  sales: ["sales.read", "sales.write", "inventory.read"],
  procurement: ["procurement.read", "procurement.write", "inventory.read"],
  inventory: ["inventory.read", "inventory.write", "procurement.read"],
  technician: ["operations.read", "operations.write", "inventory.read"],
  auditor: ["finance.read", "sales.read", "inventory.read", "procurement.read", "operations.read", "people.read", "audit.read"],
  readonly: ["finance.read", "sales.read", "inventory.read", "procurement.read", "operations.read", "people.read"],
};

/** UI/domain helper only. Enforce the same permission on the server and in database policies. */
export function hasPermission(role: TenantRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
