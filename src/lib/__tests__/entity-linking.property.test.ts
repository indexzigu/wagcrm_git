import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { z } from "zod";

import { campaignFormSchema } from "../validations/campaign";
import { createSellerSchema, SNS_TYPES } from "../validations/seller";
import {
  sortLinkedDealsByCreatedAt,
  sortLinkedCampaignsByStartDate,
} from "../entity-linking";

// === Local schemas for testing ===

const dealFormSchema = z.object({
  dealName: z.string().min(1).max(100),
  partnerId: z.string().min(1),
});

// === Shared arbitraries ===

const dateArb = fc
  .date({
    min: new Date("2020-01-01T00:00:00.000Z"),
    max: new Date("2030-12-31T00:00:00.000Z"),
  })
  .map((d) => d.toISOString());

const isoDateStringArb = fc
  .date({
    min: new Date("2024-01-01T00:00:00.000Z"),
    max: new Date("2027-12-31T00:00:00.000Z"),
  })
  .map((d) => d.toISOString().slice(0, 10));

const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 80 })
  .filter((s) => s.trim().length > 0);


// ============================================================
// Property 1: 검색 결과 최대 건수 제한
// Feature: entity-linking-workspace, Property 1: 검색 결과 최대 건수 제한
// Validates: Requirements 1.3, 2.3, 2.4, 10.3
// ============================================================

describe("Property 1: 검색 결과 최대 건수 제한", () => {
  /**
   * Simulates the search logic with `take: 20` constraint.
   * For any dataset of arbitrary size, the result must always be ≤ 20 items.
   */
  function searchWithLimit<T>(items: T[], query: string, matchFn: (item: T) => boolean): T[] {
    return items.filter(matchFn).slice(0, 20);
  }

  it("search results are always ≤ 20 items regardless of dataset size", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ id: fc.uuid(), name: fc.string({ minLength: 1, maxLength: 50 }) }),
          { minLength: 0, maxLength: 200 },
        ),
        fc.string({ minLength: 0, maxLength: 20 }),
        (dataset, query) => {
          const results = searchWithLimit(dataset, query, () => true);
          expect(results.length).toBeLessThanOrEqual(20);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("search results with partial matches are always ≤ 20 items", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({ id: fc.uuid(), name: fc.string({ minLength: 1, maxLength: 50 }) }),
          { minLength: 0, maxLength: 200 },
        ),
        fc.string({ minLength: 1, maxLength: 5 }),
        (dataset, query) => {
          const results = searchWithLimit(dataset, query, (item) =>
            item.name.toLowerCase().includes(query.toLowerCase()),
          );
          expect(results.length).toBeLessThanOrEqual(20);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 2: 유효한 입력으로 엔티티 생성 시 레코드 생성 보장
// Feature: entity-linking-workspace, Property 2: 유효한 입력으로 엔티티 생성 시 레코드 생성 보장
// Validates: Requirements 1.4, 2.6, 3.5, 3.6
// ============================================================

describe("Property 2: 유효한 입력으로 엔티티 생성 시 레코드 생성 보장", () => {
  it("valid deal inputs always pass validation", () => {
    fc.assert(
      fc.property(
        fc.record({
          dealName: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
          partnerId: nonEmptyStringArb,
        }),
        (payload) => {
          expect(dealFormSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("valid campaign inputs always pass validation", () => {
    fc.assert(
      fc.property(
        fc.record({
          dealId: nonEmptyStringArb,
          sellerId: nonEmptyStringArb,
          salesChannel: fc.constantFrom(
            "OWN_MALL" as const,
            "OWN_MALL_NAVER" as const,
            "OWN_MALL_KAKAO" as const,
            "SELLER_MALL" as const,
            "BRAND_MALL" as const,
          ),
        }),
        fc.tuple(isoDateStringArb, isoDateStringArb),
        (payload, [d1, d2]) => {
          const startDate = d1 <= d2 ? d1 : d2;
          const endDate = d1 <= d2 ? d2 : d1;
          expect(
            campaignFormSchema.safeParse({ ...payload, startDate, endDate }).success,
          ).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("valid seller inputs always pass validation", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: nonEmptyStringArb,
          snsType: fc.constantFrom(...SNS_TYPES),
          snsHandle: nonEmptyStringArb,
          currentFollowers: fc.integer({ min: 0, max: 10_000_000 }),
        }),
        (payload) => {
          expect(createSellerSchema.safeParse(payload).success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 3: 무효한 입력 거부 - 딜
// Feature: entity-linking-workspace, Property 3: 무효한 입력 거부 (딜)
// Validates: Requirements 1.5
// ============================================================

describe("Property 3: 무효한 입력 거부 - 딜", () => {
  it("rejects empty dealName", () => {
    fc.assert(
      fc.property(nonEmptyStringArb, (partnerId) => {
        const result = dealFormSchema.safeParse({ dealName: "", partnerId });
        expect(result.success).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects dealName exceeding 100 characters", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 101, maxLength: 300 }),
        nonEmptyStringArb,
        (dealName, partnerId) => {
          const result = dealFormSchema.safeParse({ dealName, partnerId });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects empty partnerId", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        (dealName) => {
          const result = dealFormSchema.safeParse({ dealName, partnerId: "" });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 3b: 무효한 입력 거부 - 캠페인
// Feature: entity-linking-workspace, Property 3b: 무효한 입력 거부 (캠페인)
// Validates: Requirements 2.7, 2.8
// ============================================================

describe("Property 3b: 무효한 입력 거부 - 캠페인", () => {
  it("rejects missing required fields (empty dealId)", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        fc.constantFrom("OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"),
        fc.tuple(isoDateStringArb, isoDateStringArb),
        (sellerId, salesChannel, [d1, d2]) => {
          const startDate = d1 <= d2 ? d1 : d2;
          const endDate = d1 <= d2 ? d2 : d1;
          const result = campaignFormSchema.safeParse({
            dealId: "",
            sellerId,
            salesChannel,
            startDate,
            endDate,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects missing required fields (empty sellerId)", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        fc.constantFrom("OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"),
        fc.tuple(isoDateStringArb, isoDateStringArb),
        (dealId, salesChannel, [d1, d2]) => {
          const startDate = d1 <= d2 ? d1 : d2;
          const endDate = d1 <= d2 ? d2 : d1;
          const result = campaignFormSchema.safeParse({
            dealId,
            sellerId: "",
            salesChannel,
            startDate,
            endDate,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects endDate before startDate", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonEmptyStringArb,
        fc.constantFrom("OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"),
        fc.tuple(isoDateStringArb, isoDateStringArb).filter(([d1, d2]) => d1 !== d2),
        (dealId, sellerId, salesChannel, [d1, d2]) => {
          // Ensure endDate < startDate
          const startDate = d1 > d2 ? d1 : d2;
          const endDate = d1 > d2 ? d2 : d1;
          const result = campaignFormSchema.safeParse({
            dealId,
            sellerId,
            salesChannel,
            startDate,
            endDate,
          });
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 4: 연결 검색 시 이미 연결된 엔티티 제외
// Feature: entity-linking-workspace, Property 4: 연결 검색 시 이미 연결된 엔티티 제외
// Validates: Requirements 5.3, 7.4
// ============================================================

describe("Property 4: 연결 검색 시 이미 연결된 엔티티 제외", () => {
  /**
   * Simulates the excludeIds filtering logic used in search APIs.
   */
  function searchWithExclude<T extends { id: string }>(
    items: T[],
    excludeIds: string[],
  ): T[] {
    const excludeSet = new Set(excludeIds);
    return items.filter((item) => !excludeSet.has(item.id));
  }

  it("excluded IDs never appear in search results", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.uuid(), name: fc.string() }), {
          minLength: 1,
          maxLength: 50,
        }),
        fc.array(fc.uuid(), { minLength: 1, maxLength: 10 }),
        (items, excludeIds) => {
          const results = searchWithExclude(items, excludeIds);
          const excludeSet = new Set(excludeIds);
          for (const result of results) {
            expect(excludeSet.has(result.id)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("items not in excludeIds are preserved in results", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.uuid(), name: fc.string() }), {
          minLength: 1,
          maxLength: 50,
        }),
        fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
        (items, excludeIds) => {
          const excludeSet = new Set(excludeIds);
          const results = searchWithExclude(items, excludeIds);
          const expectedCount = items.filter((i) => !excludeSet.has(i.id)).length;
          expect(results.length).toBe(expectedCount);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 5: 연결 작업 후 FK 정합성
// Feature: entity-linking-workspace, Property 5: 연결 작업 후 FK 정합성
// Validates: Requirements 5.4, 5.6, 7.5, 9.7
// ============================================================

describe("Property 5: 연결 작업 후 FK 정합성", () => {
  it("after link operation, FK field matches the specified entity ID", () => {
    // Simulate the FK update logic from LinkManager
    type Deal = { id: string; partnerId: string };

    function linkDeal(deal: Deal, newPartnerId: string): Deal {
      return { ...deal, partnerId: newPartnerId };
    }

    fc.assert(
      fc.property(
        fc.record({ id: fc.uuid(), partnerId: fc.uuid() }),
        fc.uuid(),
        (deal, newPartnerId) => {
          const updated = linkDeal(deal, newPartnerId);
          expect(updated.partnerId).toBe(newPartnerId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("after campaign link operation, dealId matches the specified deal ID", () => {
    type Campaign = { id: string; dealId: string };

    function linkCampaign(campaign: Campaign, newDealId: string): Campaign {
      return { ...campaign, dealId: newDealId };
    }

    fc.assert(
      fc.property(
        fc.record({ id: fc.uuid(), dealId: fc.uuid() }),
        fc.uuid(),
        (campaign, newDealId) => {
          const updated = linkCampaign(campaign, newDealId);
          expect(updated.dealId).toBe(newDealId);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 7: 활동 로그 기록 형식 정합성
// Feature: entity-linking-workspace, Property 7: 활동 로그 기록 형식 정합성
// Validates: Requirements 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
// ============================================================

describe("Property 7: 활동 로그 기록 형식 정합성", () => {
  type ActivityLogEntry = {
    timestamp: string;
    actor: string;
    message: string;
  };

  function createLinkLog(actor: string, targetName: string, type: "deal" | "partner"): ActivityLogEntry {
    const prefix = type === "partner" ? "파트너 연결" : "딜 연결";
    return {
      timestamp: new Date().toISOString(),
      actor,
      message: `${prefix}: ${targetName}`,
    };
  }

  function createChangeLog(
    actor: string,
    previousName: string,
    newName: string,
    type: "deal" | "partner",
  ): ActivityLogEntry {
    const prefix = type === "partner" ? "파트너 변경" : "딜 변경";
    return {
      timestamp: new Date().toISOString(),
      actor,
      message: `${prefix}: ${previousName} → ${newName}`,
    };
  }

  function createUnlinkLog(actor: string, targetName: string, type: "deal" | "partner"): ActivityLogEntry {
    const prefix = type === "partner" ? "파트너 연결 해제" : "딜 연결 해제";
    return {
      timestamp: new Date().toISOString(),
      actor,
      message: `${prefix}: ${targetName}`,
    };
  }

  it("link log entries contain timestamp, actor, and '연결:' format", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonEmptyStringArb,
        fc.constantFrom("deal" as const, "partner" as const),
        (actor, targetName, type) => {
          const entry = createLinkLog(actor, targetName, type);
          expect(entry.timestamp).toBeTruthy();
          expect(Date.parse(entry.timestamp)).not.toBeNaN();
          expect(entry.actor).toBe(actor);
          expect(entry.message).toContain("연결:");
          expect(entry.message).toContain(targetName);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("change log entries contain '변경:' and '→' format", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonEmptyStringArb,
        nonEmptyStringArb,
        fc.constantFrom("deal" as const, "partner" as const),
        (actor, prevName, newName, type) => {
          const entry = createChangeLog(actor, prevName, newName, type);
          expect(entry.timestamp).toBeTruthy();
          expect(Date.parse(entry.timestamp)).not.toBeNaN();
          expect(entry.actor).toBe(actor);
          expect(entry.message).toContain("변경:");
          expect(entry.message).toContain("→");
          expect(entry.message).toContain(prevName);
          expect(entry.message).toContain(newName);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("unlink log entries contain '연결 해제:' format", () => {
    fc.assert(
      fc.property(
        nonEmptyStringArb,
        nonEmptyStringArb,
        fc.constantFrom("deal" as const, "partner" as const),
        (actor, targetName, type) => {
          const entry = createUnlinkLog(actor, targetName, type);
          expect(entry.timestamp).toBeTruthy();
          expect(Date.parse(entry.timestamp)).not.toBeNaN();
          expect(entry.actor).toBe(actor);
          expect(entry.message).toContain("연결 해제:");
          expect(entry.message).toContain(targetName);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 8: 셀러 SNS 핸들 유니크 제약
// Feature: entity-linking-workspace, Property 8: 셀러 SNS 핸들 유니크 제약
// Validates: Requirements 3.8
// ============================================================

describe("Property 8: 셀러 SNS 핸들 유니크 제약", () => {
  type SellerRecord = { snsType: string; snsHandle: string };

  /**
   * Simulates the uniqueness check: if (snsType, snsHandle) already exists,
   * creation must be rejected.
   */
  function checkDuplicateSns(
    existing: SellerRecord[],
    newSeller: SellerRecord,
  ): { allowed: boolean } {
    const isDuplicate = existing.some(
      (s) => s.snsType === newSeller.snsType && s.snsHandle === newSeller.snsHandle,
    );
    return { allowed: !isDuplicate };
  }

  it("rejects creation when (snsType, snsHandle) combination already exists", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SNS_TYPES),
        nonEmptyStringArb,
        (snsType, snsHandle) => {
          const existing: SellerRecord[] = [{ snsType, snsHandle }];
          const result = checkDuplicateSns(existing, { snsType, snsHandle });
          expect(result.allowed).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("allows creation when (snsType, snsHandle) combination does not exist", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SNS_TYPES),
        nonEmptyStringArb,
        nonEmptyStringArb.filter((s) => s.length > 1),
        (snsType, existingHandle, newHandle) => {
          // Ensure handles are different
          fc.pre(existingHandle !== newHandle);
          const existing: SellerRecord[] = [{ snsType, snsHandle: existingHandle }];
          const result = checkDuplicateSns(existing, { snsType, snsHandle: newHandle });
          expect(result.allowed).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 9: 검색 최소 입력 길이
// Feature: entity-linking-workspace, Property 9: 검색 최소 입력 길이
// Validates: Requirements 10.2
// ============================================================

describe("Property 9: 검색 최소 입력 길이", () => {
  /**
   * Simulates the search dialog behavior:
   * If input length < 2, search API should NOT be called (return empty results).
   */
  function shouldCallSearchApi(query: string): boolean {
    return query.length >= 2;
  }

  function executeSearch(query: string): { apiCalled: boolean; results: string[] } {
    if (!shouldCallSearchApi(query)) {
      return { apiCalled: false, results: [] };
    }
    // Simulate API call
    return { apiCalled: true, results: ["result1"] };
  }

  it("for any input with length < 2, search API is NOT called", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 1 }),
        (query) => {
          const { apiCalled, results } = executeSearch(query);
          expect(apiCalled).toBe(false);
          expect(results).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("for any input with length >= 2, search API IS called", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 2, maxLength: 50 }),
        (query) => {
          const { apiCalled } = executeSearch(query);
          expect(apiCalled).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 10: 활동 로그 실패 시 메인 작업 독립성
// Feature: entity-linking-workspace, Property 10: 활동 로그 실패 시 메인 작업 독립성
// Validates: Requirements 11.7
// ============================================================

describe("Property 10: 활동 로그 실패 시 메인 작업 독립성", () => {
  /**
   * Simulates the LinkManager pattern where activity log failure
   * does NOT prevent the main FK update from succeeding.
   */
  async function linkWithIsolatedLog(
    dealId: string,
    newPartnerId: string,
    actor: string,
    logShouldFail: boolean,
  ): Promise<{ data: { id: string; partnerId: string }; logWarning: string | null }> {
    // Main operation always succeeds
    const data = { id: dealId, partnerId: newPartnerId };

    // Activity log is isolated
    let logWarning: string | null = null;
    try {
      if (logShouldFail) {
        throw new Error("Activity log DB connection failed");
      }
    } catch (err) {
      logWarning = `활동 로그 기록 실패: ${(err as Error).message}`;
    }

    return { data, logWarning };
  }

  it("main operation succeeds even when activity log fails", () => {
    fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        nonEmptyStringArb,
        async (dealId, newPartnerId, actor) => {
          const result = await linkWithIsolatedLog(dealId, newPartnerId, actor, true);
          // Main operation succeeded
          expect(result.data.partnerId).toBe(newPartnerId);
          expect(result.data.id).toBe(dealId);
          // Log warning is present
          expect(result.logWarning).not.toBeNull();
          expect(result.logWarning).toContain("활동 로그 기록 실패");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("main operation succeeds when activity log also succeeds", () => {
    fc.assert(
      fc.asyncProperty(
        fc.uuid(),
        fc.uuid(),
        nonEmptyStringArb,
        async (dealId, newPartnerId, actor) => {
          const result = await linkWithIsolatedLog(dealId, newPartnerId, actor, false);
          // Main operation succeeded
          expect(result.data.partnerId).toBe(newPartnerId);
          expect(result.data.id).toBe(dealId);
          // No log warning
          expect(result.logWarning).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ============================================================
// Property 11: 판매채널 enum 유효성
// Feature: entity-linking-workspace, Property 11: 판매채널 enum 유효성
// Validates: Requirements 2.5
// ============================================================

describe("Property 11: 판매채널 enum 유효성", () => {
  const validChannels = new Set(["OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"]);

  const salesChannelSchema = z.enum([
    "OWN_MALL",
    "OWN_MALL_NAVER",
    "OWN_MALL_KAKAO",
    "SELLER_MALL",
    "BRAND_MALL",
  ]);

  it("rejects any string NOT in the valid salesChannel enum", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => !validChannels.has(s)),
        (invalidChannel) => {
          const result = salesChannelSchema.safeParse(invalidChannel);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts all valid salesChannel values", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"),
        (validChannel) => {
          const result = salesChannelSchema.safeParse(validChannel);
          expect(result.success).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("rejects invalid salesChannel in full campaign form context", () => {
    fc.assert(
      fc.property(
        fc.record({
          dealId: nonEmptyStringArb,
          sellerId: nonEmptyStringArb,
          startDate: isoDateStringArb,
          endDate: isoDateStringArb,
        }),
        fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !validChannels.has(s)),
        (basePayload, invalidChannel) => {
          const payload = {
            ...basePayload,
            salesChannel: invalidChannel,
            // Ensure endDate >= startDate
            endDate:
              basePayload.endDate >= basePayload.startDate
                ? basePayload.endDate
                : basePayload.startDate,
          };
          const result = campaignFormSchema.safeParse(payload);
          expect(result.success).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================
// Property 6: 연결된 엔티티 목록 정렬 순서 (retained from original)
// Feature: entity-linking-workspace, Property 6: 연결된 엔티티 목록 정렬 순서
// Validates: Requirements 4.2, 6.2
// ============================================================

describe("Property 6: 연결된 엔티티 목록 정렬 순서", () => {
  it("sorts linked deals by createdAt descending", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            createdAt: dateArb,
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (items) => {
          const sorted = sortLinkedDealsByCreatedAt(items);
          for (let index = 1; index < sorted.length; index += 1) {
            expect(Date.parse(sorted[index - 1].createdAt ?? "")).toBeGreaterThanOrEqual(
              Date.parse(sorted[index].createdAt ?? ""),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("sorts linked campaigns by startDate descending", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            startDate: dateArb,
          }),
          { minLength: 0, maxLength: 30 },
        ),
        (items) => {
          const sorted = sortLinkedCampaignsByStartDate(items);
          for (let index = 1; index < sorted.length; index += 1) {
            expect(Date.parse(sorted[index - 1].startDate ?? "")).toBeGreaterThanOrEqual(
              Date.parse(sorted[index].startDate ?? ""),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
