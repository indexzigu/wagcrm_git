/**
 * Property-based tests for SUB_STAGE_BADGE_CONFIG.
 *
 * Feature: pipeline-kanban-remodel
 * Property 4: Campaign card contains required data with unique badge
 * Validates: Requirements 2.1, 2.2, 2.3
 *
 * Tests that SUB_STAGE_BADGE_CONFIG has a unique configuration for each of the
 * 6 campaign statuses and that each badge config has bg, text, and label properties.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { SUB_STAGE_BADGE_CONFIG } from "../badge-config";
import type { CampaignStatus } from "../crm-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CAMPAIGN_STATUSES: CampaignStatus[] = [
  "PROPOSAL",
  "PREPARATION",
  "ACTIVE",
  "CLOSED",
  "SETTLEMENT_WAIT",
  "SETTLEMENT_IN_PROGRESS",
  "COMPLETED",
  "DROPPED",
];

// Arbitrary that generates a random CampaignStatus
const arbCampaignStatus = fc.constantFrom(...ALL_CAMPAIGN_STATUSES);

// ---------------------------------------------------------------------------
// Property 4: Campaign card contains required data with unique badge
// Validates: Requirements 2.1, 2.2, 2.3
// ---------------------------------------------------------------------------

describe("Property 4: Campaign card contains required data with unique badge", () => {
  it("SUB_STAGE_BADGE_CONFIG has an entry for all 8 campaign statuses", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (status) => {
        const config = SUB_STAGE_BADGE_CONFIG[status];
        expect(config).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("each badge config has non-empty bg, text, and label properties", () => {
    fc.assert(
      fc.property(arbCampaignStatus, (status) => {
        const config = SUB_STAGE_BADGE_CONFIG[status];

        expect(typeof config.bg).toBe("string");
        expect(config.bg.length).toBeGreaterThan(0);

        expect(typeof config.text).toBe("string");
        expect(config.text.length).toBeGreaterThan(0);

        expect(typeof config.label).toBe("string");
        expect(config.label.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it("no two statuses share the same bg+text color combination", () => {
    fc.assert(
      fc.property(
        arbCampaignStatus,
        arbCampaignStatus,
        (statusA, statusB) => {
          if (statusA === statusB) return; // skip same status comparison

          const configA = SUB_STAGE_BADGE_CONFIG[statusA];
          const configB = SUB_STAGE_BADGE_CONFIG[statusB];

          const colorKeyA = `${configA.bg}|${configA.text}`;
          const colorKeyB = `${configB.bg}|${configB.text}`;

          expect(colorKeyA).not.toBe(colorKeyB);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("all 8 statuses are covered (exhaustive check)", () => {
    // Deterministic check that the config covers exactly the 8 statuses
    const configKeys = Object.keys(SUB_STAGE_BADGE_CONFIG) as CampaignStatus[];

    expect(configKeys).toHaveLength(8);
    for (const status of ALL_CAMPAIGN_STATUSES) {
      expect(configKeys).toContain(status);
    }
  });

  it("all color combinations are globally unique across all statuses", () => {
    // Deterministic uniqueness check across all pairs
    const colorKeys = ALL_CAMPAIGN_STATUSES.map((status) => {
      const config = SUB_STAGE_BADGE_CONFIG[status];
      return `${config.bg}|${config.text}`;
    });

    const uniqueColorKeys = new Set(colorKeys);
    expect(uniqueColorKeys.size).toBe(ALL_CAMPAIGN_STATUSES.length);
  });
});
