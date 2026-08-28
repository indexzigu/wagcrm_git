/**
 * Property-based tests for partner-seller UX revamp.
 *
 * Feature: partner-seller-ux-revamp, Property 1: 사업자번호 유효성 검증
 * Validates: Requirements 2.1, 2.3, 2.6
 *
 * For any 문자열 입력에 대해, 사업자번호 유효성 검증 함수는 정확히 10자리 숫자로만
 * 구성된 문자열 또는 빈 문자열만 유효로 판정하고, 그 외 모든 입력(비숫자 문자 포함,
 * 10자리 미만, 10자리 초과)은 무효로 판정해야 한다.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  validateBusinessNumber,
  validateChannelUrl,
  validatePartnerCreation,
  filterLinkedSellers,
  addCategoryTag,
} from "@/lib/validations/partner-seller";
import { PARTNER_TYPES } from "@/lib/validations/partner";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates exactly 10-digit numeric strings (always valid) */
const validBusinessNumberArb = fc.stringOf(
  fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
  { minLength: 10, maxLength: 10 },
);

/** Generates digit-only strings with length != 10 (always invalid) */
const wrongLengthDigitsArb = fc
  .stringOf(
    fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"),
    { minLength: 1, maxLength: 30 },
  )
  .filter((s) => s.length !== 10);

/** Generates arbitrary strings (may contain non-digit characters) */
const arbitraryStringArb = fc.string({ minLength: 1, maxLength: 30 });

/** Generates 10-character strings that contain at least one non-digit character */
const tenCharWithNonDigitArb = fc
  .string({ minLength: 10, maxLength: 10 })
  .filter((s) => !/^\d{10}$/.test(s));

// ---------------------------------------------------------------------------
// Property 1: 사업자번호 유효성 검증
// Validates: Requirements 2.1, 2.3, 2.6
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 1: 사업자번호 유효성 검증", () => {
  it("빈 문자열은 항상 유효로 판정한다", () => {
    const result = validateBusinessNumber("");
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("정확히 10자리 숫자 문자열은 항상 유효로 판정한다", () => {
    fc.assert(
      fc.property(validBusinessNumberArb, (input) => {
        const result = validateBusinessNumber(input);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it("10자리가 아닌 숫자 문자열은 항상 무효로 판정한다", () => {
    fc.assert(
      fc.property(wrongLengthDigitsArb, (input) => {
        const result = validateBusinessNumber(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("10자리이지만 비숫자 문자를 포함하면 무효로 판정한다", () => {
    fc.assert(
      fc.property(tenCharWithNonDigitArb, (input) => {
        const result = validateBusinessNumber(input);
        expect(result.valid).toBe(false);
        expect(result.error).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("임의 문자열에 대해 유효 판정은 빈 문자열이거나 정확히 10자리 숫자인 경우에만 참이다", () => {
    fc.assert(
      fc.property(arbitraryStringArb, (input) => {
        const result = validateBusinessNumber(input);
        const shouldBeValid = input === "" || /^\d{10}$/.test(input);
        expect(result.valid).toBe(shouldBeValid);
      }),
      { numRuns: 100 },
    );
  });

  it("빈 문자열을 포함한 모든 입력에 대해 유효/무효 판정이 일관된다 (oracle test)", () => {
    const allInputsArb = fc.oneof(
      fc.constant(""),
      validBusinessNumberArb,
      wrongLengthDigitsArb,
      arbitraryStringArb,
    );

    fc.assert(
      fc.property(allInputsArb, (input) => {
        const result = validateBusinessNumber(input);
        const isExactly10Digits = /^\d{10}$/.test(input);
        const isEmpty = input === "";

        if (isEmpty || isExactly10Digits) {
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        } else {
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 7: 채널 URL 유효성 검증
// Validates: Requirements 11.5
//
// For any 문자열 입력에 대해, 채널 URL 유효성 검증 함수는 "http://" 또는
// "https://"로 시작하는 비어있지 않은 문자열만 유효로 판정하고, 그 외 모든
// 입력은 무효로 판정해야 한다.
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 7: 채널 URL 유효성 검증", () => {
  it("http://로 시작하는 비어있지 않은 문자열은 항상 유효로 판정한다", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }).map((s) => "http://" + s),
        (url) => {
          const result = validateChannelUrl(url);
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("https://로 시작하는 비어있지 않은 문자열은 항상 유효로 판정한다", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 200 }).map((s) => "https://" + s),
        (url) => {
          const result = validateChannelUrl(url);
          expect(result.valid).toBe(true);
          expect(result.error).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("fc.webUrl()로 생성된 URL은 항상 유효로 판정한다", () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        const result = validateChannelUrl(url);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it("빈 문자열은 무효로 판정한다", () => {
    const result = validateChannelUrl("");
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("http:// 또는 https://로 시작하지 않는 문자열은 항상 무효로 판정한다", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 200 }).filter(
          (s) => !s.startsWith("http://") && !s.startsWith("https://"),
        ),
        (url) => {
          const result = validateChannelUrl(url);
          expect(result.valid).toBe(false);
          expect(result.error).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("임의 문자열에 대해 유효 판정은 http:// 또는 https://로 시작하는 경우에만 참이다 (oracle test)", () => {
    const allInputsArb = fc.oneof(
      fc.constant(""),
      fc.webUrl(),
      fc.string({ minLength: 0, maxLength: 200 }).map((s) => "http://" + s),
      fc.string({ minLength: 0, maxLength: 200 }).map((s) => "https://" + s),
      fc.string({ minLength: 0, maxLength: 200 }),
    );

    fc.assert(
      fc.property(allInputsArb, (url) => {
        const result = validateChannelUrl(url);
        const shouldBeValid =
          url.length > 0 &&
          (url.startsWith("http://") || url.startsWith("https://"));

        expect(result.valid).toBe(shouldBeValid);
        if (shouldBeValid) {
          expect(result.error).toBeUndefined();
        } else {
          expect(result.error).toBeDefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Generators for Property 5
// ---------------------------------------------------------------------------

/** Valid partner types */
const validPartnerTypeArb = fc.constantFrom(...PARTNER_TYPES);

/** Invalid partner types (empty string or non-matching strings) */
const invalidPartnerTypeArb = fc.oneof(
  fc.constant(""),
  fc.string({ minLength: 1, maxLength: 20 }).filter(
    (s) => !(PARTNER_TYPES as readonly string[]).includes(s),
  ),
);

/** Valid name: 1-50 characters, not whitespace-only */
const validNameArb = fc
  .string({ minLength: 1, maxLength: 50 })
  .filter((s) => s.trim().length > 0);

/** Invalid name: whitespace-only */
const whitespaceOnlyNameArb = fc.stringOf(
  fc.constantFrom(" ", "\t", "\n", "\r"),
  { minLength: 1, maxLength: 10 },
);

/** Invalid name: over 50 characters (trimmed length > 50) */
const tooLongNameArb = fc
  .string({ minLength: 51, maxLength: 100 })
  .filter((s) => s.trim().length > 50);

// ---------------------------------------------------------------------------
// Property 5: 거래처 생성 유효성 검증
// Validates: Requirements 7.3, 7.4
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 5: 거래처 생성 유효성 검증", () => {
  it("유효한 이름(1-50자 비공백)과 유효한 유형이면 생성이 성공한다", () => {
    fc.assert(
      fc.property(validNameArb, validPartnerTypeArb, (name, type) => {
        const result = validatePartnerCreation({ name, type });
        expect(result.valid).toBe(true);
        expect(Object.keys(result.errors)).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it("공백만으로 구성된 이름이면 생성이 차단된다", () => {
    fc.assert(
      fc.property(whitespaceOnlyNameArb, validPartnerTypeArb, (name, type) => {
        const result = validatePartnerCreation({ name, type });
        expect(result.valid).toBe(false);
        expect(result.errors.name).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("50자를 초과하는 이름이면 생성이 차단된다", () => {
    fc.assert(
      fc.property(tooLongNameArb, validPartnerTypeArb, (name, type) => {
        const result = validatePartnerCreation({ name, type });
        expect(result.valid).toBe(false);
        expect(result.errors.name).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("유형이 미선택(빈 문자열)이거나 유효하지 않으면 생성이 차단된다", () => {
    fc.assert(
      fc.property(validNameArb, invalidPartnerTypeArb, (name, type) => {
        const result = validatePartnerCreation({ name, type });
        expect(result.valid).toBe(false);
        expect(result.errors.type).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });

  it("임의 입력 조합에 대해 유효성 판정이 명세와 일치한다 (oracle test)", () => {
    const nameArb = fc.oneof(
      fc.constant(""),
      whitespaceOnlyNameArb,
      validNameArb,
      tooLongNameArb,
      fc.string({ minLength: 0, maxLength: 100 }),
    );
    const typeArb = fc.oneof(
      fc.constant(""),
      validPartnerTypeArb,
      fc.string({ minLength: 0, maxLength: 20 }),
    );

    fc.assert(
      fc.property(nameArb, typeArb, (name, type) => {
        const result = validatePartnerCreation({ name, type });

        const trimmedName = name.trim();
        const nameValid = trimmedName.length >= 1 && trimmedName.length <= 50;
        const typeValid = (PARTNER_TYPES as readonly string[]).includes(type);
        const expectedValid = nameValid && typeValid;

        expect(result.valid).toBe(expectedValid);
      }),
      { numRuns: 100 },
    );
  });

  it("빈 이름(빈 문자열)이면 생성이 차단된다", () => {
    fc.assert(
      fc.property(validPartnerTypeArb, (type) => {
        const result = validatePartnerCreation({ name: "", type });
        expect(result.valid).toBe(false);
        expect(result.errors.name).toBeDefined();
      }),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 10: 카테고리 태그 최대 개수 제한
// Validates: Requirements 13.1
//
// For any 태그 추가 시퀀스에 대해, 셀러에 할당된 카테고리 태그 수는 5개를
// 초과할 수 없으며, 5개 도달 후 추가 시도는 거부되어야 한다.
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 10: 카테고리 태그 최대 개수 제한", () => {
  /**
   * **Validates: Requirements 13.1**
   */

  it("임의의 태그 시퀀스를 순차 추가해도 결과 태그 수는 5개를 초과하지 않는다", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 10 }),
        (tagSequence) => {
          let currentTags: string[] = [];

          for (const tag of tagSequence) {
            const result = addCategoryTag(currentTags, tag);
            currentTags = result.tags;
          }

          expect(currentTags.length).toBeLessThanOrEqual(5);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("이미 5개 태그가 있을 때 추가 시도는 항상 거부된다", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 5, maxLength: 5 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (existingTags, newTag) => {
          const result = addCategoryTag(existingTags, newTag);
          expect(result.success).toBe(false);
          expect(result.tags).toEqual(existingTags);
          expect(result.tags.length).toBe(5);
          expect(result.error).toBeDefined();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("5개 미만일 때 중복되지 않는 새 태그 추가는 성공한다", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 4 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (existingTags, newTag) => {
          // Ensure newTag is not a duplicate (case-insensitive)
          const isDuplicate = existingTags.some(
            (t) => t.toLowerCase() === newTag.toLowerCase(),
          );

          const result = addCategoryTag(existingTags, newTag);

          if (isDuplicate) {
            expect(result.success).toBe(false);
            expect(result.tags).toEqual(existingTags);
          } else {
            expect(result.success).toBe(true);
            expect(result.tags.length).toBe(existingTags.length + 1);
            expect(result.tags).toContain(newTag);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("정확히 5개에 도달하면 그 이후 모든 추가 시도가 거부된다", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 5, maxLength: 10 }),
        (tagSequence) => {
          let currentTags: string[] = [];

          for (const tag of tagSequence) {
            const result = addCategoryTag(currentTags, tag);
            if (result.success) {
              currentTags = result.tags;
            }
          }

          // After processing, should have at most 5
          expect(currentTags.length).toBeLessThanOrEqual(5);

          // If we have 5, any additional tag should be rejected
          if (currentTags.length === 5) {
            const extraResult = addCategoryTag(currentTags, "extra-tag-attempt");
            expect(extraResult.success).toBe(false);
            expect(extraResult.tags.length).toBe(5);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("태그 추가 결과의 tags 배열은 항상 원본 태그를 보존한다 (불변성)", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 0, maxLength: 4 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (existingTags, newTag) => {
          const originalCopy = [...existingTags];
          const result = addCategoryTag(existingTags, newTag);

          // Original array should not be mutated
          expect(existingTags).toEqual(originalCopy);

          // Result tags should contain all original tags
          for (const tag of existingTags) {
            expect(result.tags).toContain(tag);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Property 11: 카테고리 검색 필터링 및 중복 방지
// Feature: partner-seller-ux-revamp, Property 11: 카테고리 검색 필터링 및 중복 방지
// Validates: Requirements 13.2, 13.5
//
// For any 검색 쿼리 문자열과 기존 카테고리 옵션 목록에 대해, 필터링 결과는 쿼리를
// 대소문자 무시 기준으로 포함(contains)하는 옵션만 반환해야 하며, 새 카테고리 생성 시
// 기존 옵션과 대소문자 무시 기준으로 동일한 이름이 있으면 기존 옵션을 재사용해야 한다.
// ---------------------------------------------------------------------------

import {
  filterCategories,
  findExistingByName,
} from "@/components/crm/category-tag-input";

// --- Generators for Property 11 ---

/** Generates a CategoryTag with a random id and name */
const categoryTagArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 30 }),
});

/** Generates a list of CategoryTag options */
const categoryOptionsArb = fc.array(categoryTagArb, {
  minLength: 0,
  maxLength: 20,
});

/** Generates a search query string */
const queryArb = fc.string({ minLength: 0, maxLength: 30 });

describe("Feature: partner-seller-ux-revamp, Property 11: 카테고리 검색 필터링 및 중복 방지", () => {
  // --- Part A: filterCategories case-insensitive contains ---

  it("필터링 결과의 모든 옵션은 쿼리를 대소문자 무시 기준으로 포함한다", () => {
    /**
     * **Validates: Requirements 13.2**
     */
    fc.assert(
      fc.property(queryArb, categoryOptionsArb, (query, options) => {
        const selectedIds = new Set<string>();
        const results = filterCategories(query, options, selectedIds);
        // filterCategories(=filterBySearchText)는 쿼리를 트림·NFC 정규화하고, 공백/빈 쿼리는
        // 필터 미적용(전체 반환)한다 — 컴포넌트도 query.trim()이 truthy일 때만 호출한다
        // (category-tag-input.tsx). 따라서 이 포함 불변식은 트림 후 비어있지 않은 쿼리에만,
        // 필터와 동일한 정규화 기준으로 성립한다(공백-only 쿼리에서 flaky 실패하던 것 교정).
        const lowerQuery = query.trim().normalize("NFC").toLowerCase();
        if (!lowerQuery) return;

        for (const result of results) {
          expect(result.name.normalize("NFC").toLowerCase()).toContain(lowerQuery);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("쿼리를 대소문자 무시 기준으로 포함하는 모든 옵션이 결과에 포함된다 (선택된 태그 제외)", () => {
    /**
     * **Validates: Requirements 13.2**
     */
    fc.assert(
      fc.property(queryArb, categoryOptionsArb, (query, options) => {
        const selectedIds = new Set<string>();
        const results = filterCategories(query, options, selectedIds);
        const resultIds = new Set(results.map((r) => r.id));
        const lowerQuery = query.toLowerCase();

        for (const opt of options) {
          if (opt.name.toLowerCase().includes(lowerQuery)) {
            expect(resultIds.has(opt.id)).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("이미 선택된 태그는 필터링 결과에서 제외된다", () => {
    /**
     * **Validates: Requirements 13.2**
     */
    fc.assert(
      fc.property(
        queryArb,
        categoryOptionsArb,
        fc.array(fc.uuid(), { minLength: 0, maxLength: 5 }),
        (query, options, selectedIdList) => {
          const selectedIds = new Set(selectedIdList);
          const results = filterCategories(query, options, selectedIds);

          for (const result of results) {
            expect(selectedIds.has(result.id)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("빈 쿼리는 선택되지 않은 모든 옵션을 반환한다", () => {
    /**
     * **Validates: Requirements 13.2**
     */
    fc.assert(
      fc.property(categoryOptionsArb, (options) => {
        const selectedIds = new Set<string>();
        const results = filterCategories("", options, selectedIds);
        // Empty string is contained in every string
        expect(results.length).toBe(options.length);
      }),
      { numRuns: 100 },
    );
  });

  // --- Part B: findExistingByName case-insensitive duplicate prevention ---

  it("기존 옵션과 대소문자 무시 기준으로 동일한 이름이 있으면 해당 옵션을 반환한다", () => {
    /**
     * **Validates: Requirements 13.5**
     */
    fc.assert(
      fc.property(
        categoryOptionsArb.filter((opts) => opts.length > 0),
        fc.nat(),
        (options, indexSeed) => {
          // Pick a random existing option and vary its case
          const idx = indexSeed % options.length;
          const target = options[idx];
          const variedName = target.name.toUpperCase();

          const found = findExistingByName(variedName, options);
          // Should find an option whose name matches case-insensitively
          expect(found).toBeDefined();
          expect(found!.name.toLowerCase()).toBe(variedName.toLowerCase());
        },
      ),
      { numRuns: 100 },
    );
  });

  it("기존 옵션에 대소문자 무시 기준으로 동일한 이름이 없으면 undefined를 반환한다", () => {
    /**
     * **Validates: Requirements 13.5**
     */
    fc.assert(
      fc.property(
        categoryOptionsArb,
        fc.string({ minLength: 1, maxLength: 30 }),
        (options, newName) => {
          // Only test when newName doesn't match any existing option
          const hasMatch = options.some(
            (opt) => opt.name.toLowerCase() === newName.toLowerCase(),
          );
          if (!hasMatch) {
            const found = findExistingByName(newName, options);
            expect(found).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("findExistingByName은 대소문자만 다른 이름을 동일하게 취급한다 (oracle test)", () => {
    /**
     * **Validates: Requirements 13.5**
     */
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        categoryOptionsArb,
        (name, options) => {
          const found = findExistingByName(name, options);
          const lowerName = name.toLowerCase();
          const expectedMatch = options.find(
            (opt) => opt.name.toLowerCase() === lowerName,
          );

          if (expectedMatch) {
            expect(found).toBeDefined();
            expect(found!.name.toLowerCase()).toBe(lowerName);
          } else {
            expect(found).toBeUndefined();
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// ---------------------------------------------------------------------------
// Generators for Property 6
// ---------------------------------------------------------------------------

/** Generates a seller record with a unique id */
const sellerRecordArb = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 20 }),
  snsType: fc.constantFrom("INSTAGRAM", "YOUTUBE"),
  snsHandle: fc.string({ minLength: 1, maxLength: 20 }),
});

/** Generates a linked seller record (only id needed) */
const linkedSellerArb = fc.record({
  id: fc.uuid(),
});

// ---------------------------------------------------------------------------
// Property 6: 연결된 셀러 검색 제외
// Validates: Requirements 10.4
//
// For any 거래처와 셀러 집합에 대해, 셀러 연결 검색 다이얼로그의 결과에는
// 현재 거래처에 이미 연결된 셀러가 포함되지 않아야 한다.
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 6: 연결된 셀러 검색 제외", () => {
  it("결과에는 연결된 셀러의 id가 포함되지 않는다", () => {
    fc.assert(
      fc.property(
        fc.array(sellerRecordArb, { minLength: 0, maxLength: 20 }),
        fc.array(linkedSellerArb, { minLength: 0, maxLength: 10 }),
        (allSellers, linkedSellers) => {
          const result = filterLinkedSellers(allSellers, linkedSellers);
          const linkedIds = new Set(linkedSellers.map((s) => s.id));

          for (const seller of result) {
            expect(linkedIds.has(seller.id)).toBe(false);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("연결되지 않은 셀러는 모두 결과에 포함된다", () => {
    fc.assert(
      fc.property(
        fc.array(sellerRecordArb, { minLength: 0, maxLength: 20 }),
        fc.array(linkedSellerArb, { minLength: 0, maxLength: 10 }),
        (allSellers, linkedSellers) => {
          const result = filterLinkedSellers(allSellers, linkedSellers);
          const linkedIds = new Set(linkedSellers.map((s) => s.id));

          const expectedUnlinked = allSellers.filter(
            (s) => !linkedIds.has(s.id),
          );
          expect(result).toHaveLength(expectedUnlinked.length);

          for (const seller of expectedUnlinked) {
            expect(result.some((r) => r.id === seller.id)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it("연결된 셀러가 비어있으면 전체 목록이 그대로 반환된다", () => {
    fc.assert(
      fc.property(
        fc.array(sellerRecordArb, { minLength: 0, maxLength: 20 }),
        (allSellers) => {
          const result = filterLinkedSellers(allSellers, []);
          expect(result).toHaveLength(allSellers.length);
          expect(result).toEqual(allSellers);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("전체 셀러가 모두 연결되어 있으면 빈 배열이 반환된다", () => {
    fc.assert(
      fc.property(
        fc.array(sellerRecordArb, { minLength: 1, maxLength: 20 }),
        (allSellers) => {
          // Use the same ids as linked
          const linkedSellers = allSellers.map((s) => ({ id: s.id }));
          const result = filterLinkedSellers(allSellers, linkedSellers);
          expect(result).toHaveLength(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("결과의 순서는 원본 배열의 순서를 유지한다", () => {
    fc.assert(
      fc.property(
        fc.array(sellerRecordArb, { minLength: 0, maxLength: 20 }),
        fc.array(linkedSellerArb, { minLength: 0, maxLength: 10 }),
        (allSellers, linkedSellers) => {
          const result = filterLinkedSellers(allSellers, linkedSellers);

          // Verify order preservation
          let lastIndex = -1;
          for (const seller of result) {
            const currentIndex = allSellers.findIndex(
              (s) => s.id === seller.id,
            );
            expect(currentIndex).toBeGreaterThan(lastIndex);
            lastIndex = currentIndex;
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
