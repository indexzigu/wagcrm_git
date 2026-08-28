/**
 * Property-based tests for seller creation validation.
 *
 * Feature: partner-seller-ux-revamp, Property 9: 셀러 생성 유효성 검증
 *
 * For any 입력 조합에 대해, 조합 A(유효한 URL 형식의 채널 URL) 또는
 * 조합 B(이름 1자 이상 + SNS유형 INSTAGRAM/YOUTUBE 중 택1 + SNS핸들 1자 이상)를
 * 만족하면 생성이 성공해야 하며, 어느 조합도 만족하지 않으면 생성이 차단되어야 한다.
 *
 * **Validates: Requirements 12.3, 12.4**
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { validateSellerCreation } from "@/lib/validations/partner-seller";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Valid URL starting with http:// or https:// */
const validUrl = fc.oneof(
  fc.webUrl().map((url) => url), // fast-check webUrl always starts with http(s)://
  fc
    .string({ minLength: 1, maxLength: 100 })
    .map((s) => `https://${s.replace(/\s/g, "")}`),
  fc
    .string({ minLength: 1, maxLength: 100 })
    .map((s) => `http://${s.replace(/\s/g, "")}`),
);

/** Invalid URL (does not start with http:// or https://) */
const invalidUrl = fc
  .string({ minLength: 0, maxLength: 200 })
  .filter((s) => !s.startsWith("http://") && !s.startsWith("https://"));

/** Non-empty trimmed string (at least 1 char after trim) */
const nonEmptyTrimmedString = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length >= 1);

/** Valid SNS type */
const validSnsType = fc.constantFrom("INSTAGRAM", "YOUTUBE", "X");

/** Invalid SNS type (not INSTAGRAM or YOUTUBE) */
const invalidSnsType = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s !== "INSTAGRAM" && s !== "YOUTUBE" && s !== "X");

// ---------------------------------------------------------------------------
// Property 9: 셀러 생성 유효성 검증
// Feature: partner-seller-ux-revamp, Property 9: 셀러 생성 유효성 검증
//
// **Validates: Requirements 12.3, 12.4**
// ---------------------------------------------------------------------------

describe("Property 9: 셀러 생성 유효성 검증", () => {
  it("Combination A: valid channel URL always results in valid creation", () => {
    fc.assert(
      fc.property(
        validUrl,
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (channelUrl, name, snsType, snsHandle) => {
          const result = validateSellerCreation({
            channelUrl,
            name,
            snsType,
            snsHandle,
          });
          expect(result.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Combination B: name + valid snsType + snsHandle always results in valid creation", () => {
    fc.assert(
      fc.property(
        nonEmptyTrimmedString,
        validSnsType,
        nonEmptyTrimmedString,
        fc.option(invalidUrl, { nil: undefined }),
        (name, snsType, snsHandle, channelUrl) => {
          const result = validateSellerCreation({
            channelUrl,
            name,
            snsType,
            snsHandle,
          });
          expect(result.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Both combinations satisfied: always valid", () => {
    fc.assert(
      fc.property(
        validUrl,
        nonEmptyTrimmedString,
        validSnsType,
        nonEmptyTrimmedString,
        (channelUrl, name, snsType, snsHandle) => {
          const result = validateSellerCreation({
            channelUrl,
            name,
            snsType,
            snsHandle,
          });
          expect(result.valid).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Neither combination satisfied: always invalid (no URL, missing name)", () => {
    fc.assert(
      fc.property(
        fc.option(invalidUrl, { nil: undefined }),
        fc.option(invalidSnsType, { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (channelUrl, snsType, snsHandle) => {
          // No valid URL and no name → neither combination can be satisfied
          const result = validateSellerCreation({
            channelUrl,
            name: undefined,
            snsType,
            snsHandle,
          });
          expect(result.valid).toBe(false);
          expect(Object.keys(result.errors).length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Neither combination satisfied: invalid URL + incomplete Combination B (missing snsType)", () => {
    fc.assert(
      fc.property(
        invalidUrl,
        nonEmptyTrimmedString,
        nonEmptyTrimmedString,
        (channelUrl, name, snsHandle) => {
          const result = validateSellerCreation({
            channelUrl,
            name,
            snsType: undefined,
            snsHandle,
          });
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Neither combination satisfied: invalid URL + invalid snsType in Combination B", () => {
    fc.assert(
      fc.property(
        invalidUrl,
        nonEmptyTrimmedString,
        invalidSnsType,
        nonEmptyTrimmedString,
        (channelUrl, name, snsType, snsHandle) => {
          const result = validateSellerCreation({
            channelUrl,
            name,
            snsType,
            snsHandle,
          });
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Neither combination satisfied: no URL + missing snsHandle in Combination B", () => {
    fc.assert(
      fc.property(
        nonEmptyTrimmedString,
        validSnsType,
        (name, snsType) => {
          const result = validateSellerCreation({
            channelUrl: undefined,
            name,
            snsType,
            snsHandle: undefined,
          });
          expect(result.valid).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Empty input: always invalid", () => {
    const result = validateSellerCreation({});
    expect(result.valid).toBe(false);
    expect(Object.keys(result.errors).length).toBeGreaterThan(0);
  });

  it("Validity is determined solely by combination satisfaction", () => {
    // For any arbitrary input, the result should be valid iff
    // Combination A or Combination B is satisfied
    fc.assert(
      fc.property(
        fc.record({
          channelUrl: fc.option(fc.string({ maxLength: 200 }), {
            nil: undefined,
          }),
          name: fc.option(fc.string({ maxLength: 100 }), { nil: undefined }),
          snsType: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
          snsHandle: fc.option(fc.string({ maxLength: 100 }), {
            nil: undefined,
          }),
        }),
        (input) => {
          const result = validateSellerCreation(input);

          // Compute expected validity
          const combinationA =
            !!input.channelUrl &&
            (input.channelUrl.startsWith("http://") ||
              input.channelUrl.startsWith("https://"));

          const hasName =
            !!input.name && input.name.trim().length >= 1;
          const hasValidSnsType =
            input.snsType === "INSTAGRAM" || input.snsType === "YOUTUBE" || input.snsType === "X";
          const hasSnsHandle =
            !!input.snsHandle && input.snsHandle.trim().length >= 1;
          const combinationB = hasName && hasValidSnsType && hasSnsHandle;

          const expectedValid = combinationA || combinationB;

          expect(result.valid).toBe(expectedValid);
        },
      ),
      { numRuns: 200 },
    );
  });
});
