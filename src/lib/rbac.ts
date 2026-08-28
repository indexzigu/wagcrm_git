import type { AuthContext, UserRole } from "./auth-context";

/**
 * RBAC utility for filtering data based on user role.
 *
 * - admin: full access to all data
 * - operator: restricted to assigned campaigns, no financial data
 */

/**
 * Apply RBAC filter to a Prisma where clause for campaigns.
 * Operators can only see campaigns assigned to them.
 */
export function applyRBACFilter(
  where: Record<string, unknown>,
  authContext: AuthContext | null
): Record<string, unknown> {
  if (!authContext || authContext.role === "admin") {
    return where;
  }

  // Operator: filter to only their assigned campaigns
  return {
    ...where,
    assignedTo: authContext.userId,
  };
}

/**
 * Fields that should be hidden from operator role.
 */
const SENSITIVE_FIELDS = [
  "netMarginRate",
  "costPrice",
  "operatingProfit",
  "operatingExpense",
] as const;

/**
 * Strip sensitive financial fields from a response object for operator role.
 */
export function stripSensitiveFields<T extends Record<string, unknown>>(
  data: T,
  role: UserRole
): T {
  if (role === "admin") return data;

  const stripped = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (field in stripped) {
      (stripped as Record<string, unknown>)[field] = null;
    }
  }
  return stripped;
}

/**
 * Strip sensitive fields from an array of objects.
 */
export function stripSensitiveFieldsArray<T extends Record<string, unknown>>(
  data: T[],
  role: UserRole
): T[] {
  if (role === "admin") return data;
  return data.map((item) => stripSensitiveFields(item, role));
}

/**
 * Check if a user has access to a specific feature.
 */
export function hasAccess(
  role: UserRole,
  feature: "settlement_report" | "financial_export" | "user_management"
): boolean {
  void feature;
  if (role === "admin") return true;

  // Operators cannot access these features
  return false;
}
