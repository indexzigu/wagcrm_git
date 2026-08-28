import type { DealStatus } from "./crm-types";

export { dealStatusLabels } from "./crm-types";
export type { DealStatus } from "./crm-types";

/**
 * All possible deal statuses in pipeline order.
 */
export const DEAL_STATUSES: readonly DealStatus[] = [
  "SOURCING",
  "NEGOTIATING",
  "SAMPLE_TESTING",
  "CONFIRMED",
  "ARCHIVED",
  "DROPPED",
] as const;

/**
 * Valid status transitions for the deal pipeline.
 *
 * Rules:
 * - Forward transitions only: SOURCING → NEGOTIATING → SAMPLE_TESTING → CONFIRMED → ARCHIVED
 * - DROPPED is accessible from any status (terminal state)
 * - Reverse transitions are NOT allowed
 * - DROPPED → anything is NOT allowed
 */
const VALID_TRANSITIONS: Record<DealStatus, DealStatus[]> = {
  SOURCING: ["NEGOTIATING", "DROPPED"],
  NEGOTIATING: ["CONFIRMED", "SAMPLE_TESTING", "DROPPED"],
  SAMPLE_TESTING: ["CONFIRMED", "DROPPED"],
  CONFIRMED: ["ARCHIVED", "DROPPED"],
  ARCHIVED: ["DROPPED"],
  DROPPED: [], // terminal state — no transitions out
};

/**
 * Check whether a status transition is allowed by the deal state machine.
 */
export function isValidTransition(from: DealStatus, to: DealStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Get the list of statuses a deal can transition to from its current status.
 */
export function getValidNextStatuses(current: DealStatus): DealStatus[] {
  return VALID_TRANSITIONS[current] ?? [];
}

/**
 * Summarize deal statuses by grouping and counting.
 * Returns a record mapping each status to its count.
 */
export function summarizeDealStatuses(
  deals: Array<{ status: string }>
): Record<string, number> {
  return deals.reduce((acc, deal) => {
    acc[deal.status] = (acc[deal.status] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);
}
