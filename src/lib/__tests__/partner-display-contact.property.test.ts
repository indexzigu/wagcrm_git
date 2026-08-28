/**
 * Property-based tests for getDisplayContact.
 *
 * Feature: partner-seller-ux-revamp
 * Property 4: 첫 번째 담당자 연락처 표시
 * Validates: Requirements 4.5
 *
 * For any 1명 이상의 담당자를 가진 거래처에 대해,
 * 거래처 목록의 "연락처" 컬럼은 첫 번째 담당자의 연락처 정보를 표시해야 한다.
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import { getDisplayContact } from "../partner-seller-display";

// ---------------------------------------------------------------------------
// Property 4: 첫 번째 담당자 연락처 표시
// Validates: Requirements 4.5
// ---------------------------------------------------------------------------

describe("Feature: partner-seller-ux-revamp, Property 4: 첫 번째 담당자 연락처 표시", () => {
  const contactArb = fc.record({
    phoneNumber: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.stringOf(fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-"), {
        minLength: 1,
        maxLength: 20,
      }),
    ),
    email: fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.emailAddress(),
    ),
  });

  const nonEmptyContactsArb = fc.array(contactArb, { minLength: 1, maxLength: 10 });

  it("always returns the first contact's phoneNumber when it is a non-empty string", () => {
    const contactWithPhoneArb = fc.record({
      phoneNumber: fc.stringOf(
        fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "-"),
        { minLength: 1, maxLength: 20 },
      ),
      email: fc.oneof(fc.constant(null), fc.constant(undefined), fc.emailAddress()),
    });

    const restContactsArb = fc.array(contactArb, { minLength: 0, maxLength: 9 });

    fc.assert(
      fc.property(contactWithPhoneArb, restContactsArb, (firstContact, rest) => {
        const contacts = [firstContact, ...rest];
        const result = getDisplayContact(contacts);
        expect(result).toBe(firstContact.phoneNumber);
      }),
      { numRuns: 100 },
    );
  });

  it("returns the first contact's email when phoneNumber is null/undefined and email exists", () => {
    const contactWithEmailOnlyArb = fc.record({
      phoneNumber: fc.oneof(fc.constant(null), fc.constant(undefined)),
      email: fc.emailAddress(),
    });

    const restContactsArb = fc.array(contactArb, { minLength: 0, maxLength: 9 });

    fc.assert(
      fc.property(contactWithEmailOnlyArb, restContactsArb, (firstContact, rest) => {
        const contacts = [firstContact, ...rest];
        const result = getDisplayContact(contacts);
        expect(result).toBe(firstContact.email);
      }),
      { numRuns: 100 },
    );
  });

  it("returns empty string when first contact has neither phoneNumber nor email", () => {
    const contactWithNothingArb = fc.record({
      phoneNumber: fc.oneof(fc.constant(null), fc.constant(undefined)),
      email: fc.oneof(fc.constant(null), fc.constant(undefined)),
    });

    const restContactsArb = fc.array(contactArb, { minLength: 0, maxLength: 9 });

    fc.assert(
      fc.property(contactWithNothingArb, restContactsArb, (firstContact, rest) => {
        const contacts = [firstContact, ...rest];
        const result = getDisplayContact(contacts);
        expect(result).toBe("");
      }),
      { numRuns: 100 },
    );
  });

  it("result depends only on the first contact regardless of other contacts in the array", () => {
    fc.assert(
      fc.property(nonEmptyContactsArb, (contacts) => {
        const result = getDisplayContact(contacts);
        const first = contacts[0];
        const expected = first.phoneNumber || first.email || "";
        expect(result).toBe(expected);
      }),
      { numRuns: 100 },
    );
  });
});
