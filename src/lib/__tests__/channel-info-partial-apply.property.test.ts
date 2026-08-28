/**
 * Property-based tests for partial channel info application.
 *
 * Feature: partner-seller-ux-revamp, Property 8: 채널 정보 부분 적용
 * Validates: Requirements 11.6
 *
 * For any 채널 정보 API 응답(snsType, snsHandle, name, currentFollowers 중 임의의 부분집합)에 대해,
 * 반환된 필드만 셀러 데이터에 적용되고 반환되지 않은 필드는 기존 값을 유지해야 한다.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  applyChannelInfo,
  type ChannelInfoPartial,
  type SellerChannelData,
} from "../partner-seller-display";

// ---------------------------------------------------------------------------
// Property 8: 채널 정보 부분 적용
// Validates: Requirements 11.6
// ---------------------------------------------------------------------------

// Generator for existing seller channel data
const existingDataArb: fc.Arbitrary<SellerChannelData> = fc.record({
  snsType: fc.oneof(fc.constant(null), fc.constantFrom("INSTAGRAM", "YOUTUBE")),
  snsHandle: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 30 })),
  name: fc.oneof(fc.constant(null), fc.string({ minLength: 1, maxLength: 50 })),
  currentFollowers: fc.oneof(fc.constant(null), fc.nat({ max: 1000000 })),
});

// Generator for partial channel info response (any subset of fields)
const partialInfoArb: fc.Arbitrary<ChannelInfoPartial> = fc.record(
  {
    snsType: fc.constantFrom("INSTAGRAM", "YOUTUBE"),
    snsHandle: fc.string({ minLength: 1, maxLength: 30 }),
    name: fc.string({ minLength: 1, maxLength: 50 }),
    currentFollowers: fc.nat({ max: 1000000 }),
  },
  { requiredKeys: [] },
);

describe("Feature: partner-seller-ux-revamp, Property 8: 채널 정보 부분 적용", () => {
  it("applies only returned fields and preserves existing values for missing fields", () => {
    fc.assert(
      fc.property(existingDataArb, partialInfoArb, (existing, partial) => {
        const result = applyChannelInfo(existing, partial);

        // For each field: if partial has it (not undefined), result should use partial's value
        // Otherwise, result should keep existing value

        // snsType
        if (partial.snsType !== undefined) {
          expect(result.snsType).toBe(partial.snsType);
        } else {
          expect(result.snsType).toBe(existing.snsType);
        }

        // snsHandle
        if (partial.snsHandle !== undefined) {
          expect(result.snsHandle).toBe(partial.snsHandle);
        } else {
          expect(result.snsHandle).toBe(existing.snsHandle);
        }

        // name
        if (partial.name !== undefined) {
          expect(result.name).toBe(partial.name);
        } else {
          expect(result.name).toBe(existing.name);
        }

        // currentFollowers
        if (partial.currentFollowers !== undefined) {
          expect(result.currentFollowers).toBe(partial.currentFollowers);
        } else {
          expect(result.currentFollowers).toBe(existing.currentFollowers);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("returns existing data unchanged when partial response is empty", () => {
    fc.assert(
      fc.property(existingDataArb, (existing) => {
        const emptyPartial: ChannelInfoPartial = {};
        const result = applyChannelInfo(existing, emptyPartial);

        expect(result.snsType).toBe(existing.snsType);
        expect(result.snsHandle).toBe(existing.snsHandle);
        expect(result.name).toBe(existing.name);
        expect(result.currentFollowers).toBe(existing.currentFollowers);
      }),
      { numRuns: 100 },
    );
  });

  it("overwrites all fields when partial response contains all fields", () => {
    fc.assert(
      fc.property(
        existingDataArb,
        fc.record({
          snsType: fc.constantFrom("INSTAGRAM", "YOUTUBE"),
          snsHandle: fc.string({ minLength: 1, maxLength: 30 }),
          name: fc.string({ minLength: 1, maxLength: 50 }),
          currentFollowers: fc.nat({ max: 1000000 }),
        }),
        (existing, fullPartial) => {
          const result = applyChannelInfo(existing, fullPartial);

          expect(result.snsType).toBe(fullPartial.snsType);
          expect(result.snsHandle).toBe(fullPartial.snsHandle);
          expect(result.name).toBe(fullPartial.name);
          expect(result.currentFollowers).toBe(fullPartial.currentFollowers);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("does not mutate the existing data object", () => {
    fc.assert(
      fc.property(existingDataArb, partialInfoArb, (existing, partial) => {
        const existingCopy = { ...existing };
        applyChannelInfo(existing, partial);

        // Original object should remain unchanged
        expect(existing.snsType).toBe(existingCopy.snsType);
        expect(existing.snsHandle).toBe(existingCopy.snsHandle);
        expect(existing.name).toBe(existingCopy.name);
        expect(existing.currentFollowers).toBe(existingCopy.currentFollowers);
      }),
      { numRuns: 100 },
    );
  });
});
