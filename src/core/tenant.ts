export const TENANT_ROLES = [
  "owner", "admin", "org_admin", "finance_manager", "accountant", "branch_manager",
  "cashier", "sales", "procurement", "inventory", "technician", "auditor", "readonly",
] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export type TenantContext = Readonly<{
  tenantId: string;
  userId: string;
  role: TenantRole;
}>;

export type OrganizationMembership = Readonly<{
  id: string;
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: "invited" | "active" | "suspended" | "revoked";
}>;

export type Organization = Readonly<{
  id: string;
  legalName: string;
  tradingName?: string;
  baseCurrency: string;
  timezone: string;
  locale: string;
  fiscalYearStartMonth: number;
  status: "active" | "suspended";
}>;

export type Branch = Readonly<{
  id: string;
  tenantId: string;
  code: string;
  name: string;
  timezone?: string;
  isActive: boolean;
}>;

export function validateOrganization(organization: Organization): void {
  if (!organization.id.trim() || !organization.legalName.trim()) {
    throw new Error("An organization requires an ID and legal name.");
  }
  if (!/^[A-Z]{3}$/.test(organization.baseCurrency)) {
    throw new Error("Organization base currency must be a three-letter uppercase code.");
  }
  if (!Number.isInteger(organization.fiscalYearStartMonth) || organization.fiscalYearStartMonth < 1 || organization.fiscalYearStartMonth > 12) {
    throw new Error("Fiscal year start month must be between 1 and 12.");
  }
  if (!organization.locale.trim()) throw new Error("Organization locale is required.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: organization.timezone });
  } catch {
    throw new Error("Organization timezone must be a supported IANA timezone.");
  }
  if (organization.status !== "active" && organization.status !== "suspended") {
    throw new Error("Organization status is invalid.");
  }
}

export function validateBranch(branch: Branch): void {
  if (!branch.id.trim() || !branch.tenantId.trim() || !branch.code.trim() || !branch.name.trim()) {
    throw new Error("A branch requires an ID, tenant, code and name.");
  }
  if (branch.timezone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: branch.timezone });
    } catch {
      throw new Error("Branch timezone must be a supported IANA timezone.");
    }
  }
}

/** Resolve context only from a membership already fetched and verified by the server. */
export function resolveTenantContext(authenticatedUserId: string, membership: OrganizationMembership): TenantContext {
  if (!authenticatedUserId.trim() || membership.userId !== authenticatedUserId) {
    throw new Error("Membership does not belong to the authenticated user.");
  }
  if (membership.status !== "active") throw new Error("An active organization membership is required.");
  return requireTenantContext({ tenantId: membership.tenantId, userId: authenticatedUserId, role: membership.role });
}

/** Context must originate from authenticated, server-validated membership—not browser input. */
export function requireTenantContext(context: TenantContext | null): TenantContext {
  if (!context?.tenantId?.trim() || !context.userId?.trim()) {
    throw new Error("A verified tenant membership is required.");
  }
  if (!TENANT_ROLES.includes(context.role)) throw new Error("The tenant role is not recognized.");
  return context;
}
