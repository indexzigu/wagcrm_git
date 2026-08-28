// Feature: auto-reminders
// Property 5: Stagnant suggestion correctness
// Validates: Requirements 3.1, 3.2

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { STAGNANT_SUGGESTIONS, getStagnantSuggestion } from "../lib/stagnant";
import type { CampaignStatus } from "../lib/crm-types";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * All CampaignStatus values excluding COMPLETED, as the property only applies
 * to statuses that have a meaningful suggestion (COMPLETED maps to "").
 */
const ACTIONABLE_STATUSES: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
];

const actionableStatusArb: fc.Arbitrary<CampaignStatus> = fc.constantFrom(
  ...ACTIONABLE_STATUSES,
);

// ---------------------------------------------------------------------------
// Property 5: Stagnant suggestion correctness
// For any valid CampaignStatus (excluding COMPLETED), getStagnantSuggestion
// returns the predefined Korean suggestion string for that status.
// Validates: Requirements 3.1, 3.2
// ---------------------------------------------------------------------------

describe("Property 5: Stagnant suggestion correctness", () => {
  it(
    "getStagnantSuggestion returns the predefined suggestion for each actionable status",
    () => {
      fc.assert(
        fc.property(actionableStatusArb, (status) => {
          const result = getStagnantSuggestion(status);
          const expected = STAGNANT_SUGGESTIONS[status];

          expect(result).toBe(expected);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "getStagnantSuggestion returns a non-empty string for each actionable status",
    () => {
      fc.assert(
        fc.property(actionableStatusArb, (status) => {
          const result = getStagnantSuggestion(status);

          expect(result.length).toBeGreaterThan(0);
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "PROPOSAL status returns the correct Korean suggestion (Req 3.2)",
    () => {
      fc.assert(
        fc.property(fc.constant("PROPOSAL" as CampaignStatus), (status) => {
          expect(getStagnantSuggestion(status)).toBe(
            "셀러에게 재연락하거나 다른 셀러를 탐색하세요",
          );
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "PREPARATION status returns the correct Korean suggestion (Req 3.2)",
    () => {
      fc.assert(
        fc.property(fc.constant("PREPARATION" as CampaignStatus), (status) => {
          expect(getStagnantSuggestion(status)).toBe(
            "세팅 완료 후 ACTIVE로 전환하세요",
          );
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "ACTIVE status returns the correct Korean suggestion (Req 3.2)",
    () => {
      fc.assert(
        fc.property(fc.constant("ACTIVE" as CampaignStatus), (status) => {
          expect(getStagnantSuggestion(status)).toBe(
            "캠페인 성과를 확인하고 종료 여부를 결정하세요",
          );
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "CLOSED status returns the correct Korean suggestion (Req 3.2)",
    () => {
      fc.assert(
        fc.property(fc.constant("CLOSED" as CampaignStatus), (status) => {
          expect(getStagnantSuggestion(status)).toBe("정산 처리를 시작하세요");
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "SETTLEMENT_WAIT status returns the correct Korean suggestion (Req 3.2)",
    () => {
      fc.assert(
        fc.property(
          fc.constant("SETTLEMENT_WAIT" as CampaignStatus),
          (status) => {
            expect(getStagnantSuggestion(status)).toBe(
              "반품기간과 정산금 입금 여부를 확인하세요",
            );
          },
        ),
        { numRuns: 100 },
      );
    },
  );

  it(
    "COMPLETED status returns an empty string (excluded from actionable set)",
    () => {
      fc.assert(
        fc.property(fc.constant("COMPLETED" as CampaignStatus), (status) => {
          expect(getStagnantSuggestion(status)).toBe("");
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "result is always a string (never undefined or null) for any CampaignStatus",
    () => {
      const allStatusArb: fc.Arbitrary<CampaignStatus> = fc.constantFrom(
        "PROPOSAL",
        "PREPARATION",
        "ACTIVE",
        "CLOSED",
        "SETTLEMENT_WAIT",
        "COMPLETED",
      );

      fc.assert(
        fc.property(allStatusArb, (status) => {
          const result = getStagnantSuggestion(status);

          expect(typeof result).toBe("string");
          expect(result).not.toBeNull();
          expect(result).not.toBeUndefined();
        }),
        { numRuns: 100 },
      );
    },
  );

  it(
    "each actionable status maps to a unique suggestion string",
    () => {
      // Verify the mapping is injective (no two statuses share the same suggestion)
      const suggestions = ACTIONABLE_STATUSES.map((s) =>
        getStagnantSuggestion(s),
      );
      const uniqueSuggestions = new Set(suggestions);

      expect(uniqueSuggestions.size).toBe(ACTIONABLE_STATUSES.length);
    },
  );
});
