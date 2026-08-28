/**
 * Property-based tests for comment validation.
 *
 * Feature: multi-user-collaboration
 * Property 6: Comment validation rejects whitespace-only content
 *
 * Validates: Requirement 4.3
 *
 * 자기멘션 제외(구 Requirement 6.3)는 여기서 다루지 않는다 — 유일한 소비자였던
 * MENTION 알림 생성이 알림센터 해체와 함께 제거되면서(2026-07-24,
 * `src/app/api/comments/route.ts`) 제외 로직 자체가 사라졌다. 멘션 파싱·해석의
 * 회귀(트레일링 하이픈 경계 포함)는 `mention-parser.test.ts`가 덮는다.
 */

import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Replicates the exact validation guard used in the POST /api/comments handler:
 *   if (!content.trim()) → reject
 */
function isWhitespaceOnly(content: string): boolean {
  return !content.trim();
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Generates strings composed entirely of whitespace characters. */
const whitespaceStringArb = fc
  .array(fc.constantFrom(" ", "\t", "\n", "\r", "\r\n", "\u00a0"), {
    minLength: 1,
    maxLength: 50,
  })
  .map((chars) => chars.join(""));

// ---------------------------------------------------------------------------
// Property 6: Comment validation rejects whitespace-only content
// Validates: Requirements 4.3
// ---------------------------------------------------------------------------

describe("Property 6: Comment validation rejects whitespace-only content", () => {
  it("rejects any string composed entirely of whitespace characters", () => {
    // Feature: multi-user-collaboration, Property 6: Comment validation rejects whitespace-only content
    fc.assert(
      fc.property(whitespaceStringArb, (content) => {
        expect(isWhitespaceOnly(content)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("accepts strings that contain at least one non-whitespace character", () => {
    // Feature: multi-user-collaboration, Property 6: Comment validation rejects whitespace-only content
    const nonEmptyContentArb = fc
      .tuple(
        fc.string({ minLength: 1 }),
        fc.string(),
        fc.string(),
      )
      .map(([nonWs, prefix, suffix]) => {
        // Ensure at least one non-whitespace character exists
        const trimmed = nonWs.trim();
        if (trimmed.length === 0) {
          return "a" + prefix + suffix;
        }
        return prefix + trimmed + suffix;
      });

    fc.assert(
      fc.property(nonEmptyContentArb, (content) => {
        // Any string with at least one non-whitespace char must NOT be rejected
        expect(isWhitespaceOnly(content)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("empty string is also rejected (edge case)", () => {
    expect(isWhitespaceOnly("")).toBe(true);
  });

  it("single space is rejected", () => {
    expect(isWhitespaceOnly(" ")).toBe(true);
  });

  it("tab and newline combinations are rejected", () => {
    expect(isWhitespaceOnly("\t\n\r")).toBe(true);
  });
});

