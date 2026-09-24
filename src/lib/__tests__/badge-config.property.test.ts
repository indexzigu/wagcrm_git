/**
 * Property-based tests for SUB_STAGE_BADGE_CONFIG.
 *
 * Feature: pipeline-kanban-remodel
 * Property 4: Campaign card contains required data with unique badge
 * Validates: Requirements 2.1, 2.2, 2.3
 *
 * Tests that SUB_STAGE_BADGE_CONFIG has a configuration for each of the 8 campaign
 * statuses and that each badge config has bg, text, and label properties. Color
 * uniqueness follows the StatusBadge SSOT (P8 guardrail 2), which pairs PROPOSAL and
 * ACTIVE on the same navy tint — see the last test.
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

  it("all 8 statuses are covered (exhaustive check)", () => {
    // Deterministic check that the config covers exactly the 8 statuses
    const configKeys = Object.keys(SUB_STAGE_BADGE_CONFIG) as CampaignStatus[];

    expect(configKeys).toHaveLength(8);
    for (const status of ALL_CAMPAIGN_STATUSES) {
      expect(configKeys).toContain(status);
    }
  });

  it("색 조합이 겹치는 쌍은 정본(StatusBadge)이 겹치는 쌍뿐이다 — PROPOSAL = ACTIVE", () => {
    // ⚠️ 종전 이 자리의 단언은 "8개 색 조합이 전부 달라야 한다"였다(pipeline-kanban-remodel
    // 요구 2.x). P8 가드레일 2 는 StatusBadge 를 **유일 정본**으로 두고 이 맵을 거기에
    // 정렬하라고 하는데, 정본은 제안·판매 진행을 같은 네이비 틴트로 둔다(둘 다 "진행 중"
    // 계열이고 칸반에서 서로 다른 열이라 라벨이 구분한다). 그래서 고유성은 정본과 **같은
    // 겹침 구조**로 바뀐다 — 정렬 이후 새 겹침이 생기면 여기서 잡힌다(interfaces 묶음 F,
    // 2026-09-24 오너 지시).
    const colorKeys = ALL_CAMPAIGN_STATUSES.map((status) => {
      const config = SUB_STAGE_BADGE_CONFIG[status];
      return `${config.bg}|${config.text}`;
    });

    const duplicatedPairs: string[] = [];
    for (let i = 0; i < colorKeys.length; i++) {
      for (let j = i + 1; j < colorKeys.length; j++) {
        if (colorKeys[i] === colorKeys[j]) {
          duplicatedPairs.push(`${ALL_CAMPAIGN_STATUSES[i]}=${ALL_CAMPAIGN_STATUSES[j]}`);
        }
      }
    }
    expect(duplicatedPairs).toEqual(["PROPOSAL=ACTIVE"]);
    expect(new Set(colorKeys).size).toBe(ALL_CAMPAIGN_STATUSES.length - 1);
  });

});
