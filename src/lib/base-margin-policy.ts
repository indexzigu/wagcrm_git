import type { BaseMarginPolicy } from "@/lib/crm-types";
import { seedMarginPolicy } from "@/lib/mock-data";

function isBaseMarginPolicy(value: unknown): value is BaseMarginPolicy {
  return (
    !!value &&
    typeof value === "object" &&
    "byChannel" in value &&
    typeof (value as { byChannel?: unknown }).byChannel === "object"
  );
}

/**
 * Normalize a stored base margin policy into the runtime shape.
 * Supports legacy string values by falling back to the seeded default policy.
 */
export function parseBaseMarginPolicy(
  value: string | BaseMarginPolicy | null | undefined,
): BaseMarginPolicy {
  if (!value) return seedMarginPolicy;

  if (typeof value === "object" && isBaseMarginPolicy(value)) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return seedMarginPolicy;

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isBaseMarginPolicy(parsed)) {
        return parsed;
      }
    } catch {
      // fall through to default policy
    }
  }

  return seedMarginPolicy;
}
