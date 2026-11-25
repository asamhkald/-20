import { hasPermission, type Permission } from "../permissions";
import {
  TENANT_ROLES,
  validateBranch,
  validateOrganization,
  type Branch,
  type Organization,
  type OrganizationMembership,
  type TenantContext,
  type TenantRole,
} from "../tenant";

export type VerifiedSessionContext = Readonly<{
  tenantId: string;
  userId: string;
  role: TenantRole;
  organization: Organization;
  membership: OrganizationMembership;
  branch?: Branch;
  expiresAtIso?: string;
}>;

export function resolveVerifiedSession(input: {
  userId: string;
  organization: Organization;
  membership: OrganizationMembership;
  branch?: Branch;
  expiresAtIso?: string;
  nowIso?: string;
}): VerifiedSessionContext {
  const userId = input.userId.trim();
  if (!userId) throw new Error("Authenticated user ID is required.");

  validateOrganization(input.organization);
  if (input.organization.status !== "active") {
    throw new Error(`Organization "${input.organization.legalName}" is suspended.`);
  }

  const m = input.membership;
  if (!m.id.trim() || !m.tenantId.trim() || !m.userId.trim()) {
    throw new Error("Membership record is incomplete.");
  }
  if (m.userId !== userId) {
    throw new Error("Security violation: membership user does not match authenticated user.");
  }
  if (m.tenantId !== input.organization.id) {
    throw new Error("Security violation: cross-tenant membership mismatch.");
  }
  if (m.status !== "active") {
    throw new Error(`Membership is not active (status: ${m.status}).`);
  }
  if (!TENANT_ROLES.includes(m.role)) {
    throw new Error(`Unsupported role: ${String(m.role)}`);
  }

  if (input.expiresAtIso) {
    const expMs = Date.parse(input.expiresAtIso);
    const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
    if (!Number.isFinite(expMs) || !Number.isFinite(nowMs)) {
      throw new Error("Invalid subscription expiration timestamp.");
    }
    if (expMs <= nowMs) throw new Error("Tenant subscription has expired.");
  }

  if (input.branch) {
    validateBranch(input.branch);
    if (input.branch.tenantId !== input.organization.id) {
      throw new Error("Security violation: branch belongs to a different organization.");
    }
    if (!input.branch.isActive) {
      throw new Error(`Branch "${input.branch.code}" is inactive.`);
    }
  }

  return Object.freeze({
    tenantId: input.organization.id,
    userId,
    role: m.role,
    organization: Object.freeze({ ...input.organization }),
    membership: Object.freeze({ ...m }),
    branch: input.branch ? Object.freeze({ ...input.branch }) : undefined,
    expiresAtIso: input.expiresAtIso,
  });
}

export function toTenantContext(session: VerifiedSessionContext): TenantContext {
  return Object.freeze({
    tenantId: session.tenantId,
    userId: session.userId,
    role: session.role,
  });
}

export function assertSessionAuthorized(
  session: VerifiedSessionContext,
  targetTenantId: string,
  permission: Permission,
): void {
  if (session.tenantId !== targetTenantId) {
    throw new Error("Cross-tenant access denied.");
  }
  if (!hasPermission(session.role, permission)) {
    throw new Error(`Permission denied: role "${session.role}" cannot perform "${permission}".`);
  }
}
