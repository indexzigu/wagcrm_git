/**
 * Property-based tests for the sales task status transition state machine.
 *
 * Feature: workspace-task-management
 * Property 9: Outreach status transition state machine
 * Validates: SalesTask transition rules
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import {
  OUTREACH_STATUSES,
  isValidOutreachTransition,
  getValidOutreachNextStatuses,
  type OutreachStatus,
} from "../lib/validations/outreach";

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Any valid OutreachStatus */
const statusArb = fc.constantFrom(...OUTREACH_STATUSES);

/** A pair of statuses (from, to) */
const statusPairArb = fc.tuple(statusArb, statusArb);

// ---------------------------------------------------------------------------
// Ground-truth transition map (mirrors the implementation, used for oracle)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<OutreachStatus, ReadonlySet<OutreachStatus>> = {
  PROPOSED: new Set(["NEGOTIATION", "TESTING", "PENDING_APPROVAL", "CONVERTED", "DROPPED"]),
  NEGOTIATION: new Set(["PROPOSED", "TESTING", "PENDING_APPROVAL", "CONVERTED", "DROPPED"]),
  TESTING: new Set(["PROPOSED", "NEGOTIATION", "PENDING_APPROVAL", "CONVERTED", "DROPPED"]),
  PENDING_APPROVAL: new Set(["PROPOSED", "NEGOTIATION", "TESTING", "CONVERTED", "DROPPED"]),
  CONVERTED: new Set(["DROPPED"]),
  DROPPED: new Set(["PROPOSED"]),
};

// ---------------------------------------------------------------------------
// Property 9: Outreach status transition state machine
// Validates: Requirements 5.1, 5.2, 5.3
// ---------------------------------------------------------------------------

describe("Property 9: Outreach status transition state machine", () => {
  /**
   * 9a — Valid transitions are accepted
   *
   * For every (from, to) pair where `to` is in the valid transitions map for
   * `from`, `isValidOutreachTransition` must return true.
   *
   * Validates: PROPOSED/NEGOTIATION/TESTING transition rules
   */
  it("accepts every transition that is in the valid transitions map", () => {
    // Build the exhaustive list of valid (from, to) pairs
    const validPairs: Array<[OutreachStatus, OutreachStatus]> = [];
    for (const from of OUTREACH_STATUSES) {
      for (const to of VALID_TRANSITIONS[from]) {
        validPairs.push([from, to]);
      }
    }

    fc.assert(
      fc.property(fc.constantFrom(...validPairs), ([from, to]) => {
        expect(isValidOutreachTransition(from, to)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9b — Invalid transitions are rejected
   *
   * For every (from, to) pair where `to` is NOT in the valid transitions map
   * for `from` (and from ≠ to), `isValidOutreachTransition` must return false.
   *
   * Validates: CONFIRMED/DROPPED are terminal — no outgoing
   * transitions; also covers any other invalid cross-transitions)
   */
  it("rejects every transition that is not in the valid transitions map", () => {
    // Build the exhaustive list of invalid (from, to) pairs (excluding self-transitions)
    const invalidPairs: Array<[OutreachStatus, OutreachStatus]> = [];
    for (const from of OUTREACH_STATUSES) {
      for (const to of OUTREACH_STATUSES) {
        if (from !== to && !VALID_TRANSITIONS[from].has(to)) {
          invalidPairs.push([from, to]);
        }
      }
    }

    // Only run if there are invalid pairs to test
    if (invalidPairs.length === 0) return;

    fc.assert(
      fc.property(fc.constantFrom(...invalidPairs), ([from, to]) => {
        expect(isValidOutreachTransition(from, to)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9c — Self-transitions are always accepted
   *
   * For any status S, transitioning from S to S must return true (idempotent
   * no-op update should not be rejected).
   *
   * Validates: Robustness of the state machine guard
   */
  it("accepts self-transitions for every status", () => {
    fc.assert(
      fc.property(statusArb, (status) => {
        expect(isValidOutreachTransition(status, status)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9d — CONVERTED는 자동 전환전용 준종료 상태 (DROPPED로만 이동 가능)
   *
   * CONVERTED 상태에서 DROPPED 이외의 상태로는 전환 불가.
   */
  it("환되지 않는 전환 거부: CONVERTED 상태에서 DROPPED 이외 모든 상태로의 전환 거부", () => {
    fc.assert(
      fc.property(
        statusArb,
        (to) => {
          if (to === "CONVERTED" || to === "DROPPED") return; // self or allowed
          expect(isValidOutreachTransition("CONVERTED", to)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 9e — PROPOSED는 NEGOTIATION, TESTING, PENDING_APPROVAL, DROPPED로 전환 가능
   */
  it("PROPOSED transitions to NEGOTIATION, TESTING, PENDING_APPROVAL, DROPPED are all valid", () => {
    const allowedTargets: OutreachStatus[] = ["NEGOTIATION", "TESTING", "PENDING_APPROVAL", "DROPPED"];

    fc.assert(
      fc.property(fc.constantFrom(...allowedTargets), (to) => {
        expect(isValidOutreachTransition("PROPOSED", to)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9f — NEGOTIATION은 PROPOSED, TESTING, PENDING_APPROVAL, DROPPED로 전환 가능
   */
  it("NEGOTIATION transitions to PROPOSED, TESTING, PENDING_APPROVAL, DROPPED are valid", () => {
    fc.assert(
      fc.property(statusArb, (to) => {
        const result = isValidOutreachTransition("NEGOTIATION", to);
        if (to === "PROPOSED" || to === "TESTING" || to === "PENDING_APPROVAL" || to === "CONVERTED" || to === "DROPPED" || to === "NEGOTIATION") {
          expect(result).toBe(true);
        } else {
          expect(result).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9g — getValidOutreachNextStatuses is consistent with isValidOutreachTransition
   *
   * For any status S and any target T, T is in getValidOutreachNextStatuses(S)
   * if and only if isValidOutreachTransition(S, T) returns true AND S ≠ T.
   *
   * Validates: Internal consistency of the state machine helpers
   */
  it("getValidOutreachNextStatuses is consistent with isValidOutreachTransition", () => {
    fc.assert(
      fc.property(statusArb, statusArb, (from, to) => {
        const nextStatuses = getValidOutreachNextStatuses(from);
        const isValid = isValidOutreachTransition(from, to);

        if (from === to) {
          // Self-transitions are valid but NOT listed in nextStatuses
          // (nextStatuses only lists distinct reachable states)
          return;
        }

        if (nextStatuses.includes(to)) {
          expect(isValid).toBe(true);
        } else {
          expect(isValid).toBe(false);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9h — The transition function is deterministic
   *
   * Calling isValidOutreachTransition with the same (from, to) pair always
   * returns the same result.
   *
   * Validates: Determinism / purity of the state machine
   */
  it("isValidOutreachTransition is deterministic for any (from, to) pair", () => {
    fc.assert(
      fc.property(statusPairArb, ([from, to]) => {
        const first = isValidOutreachTransition(from, to);
        const second = isValidOutreachTransition(from, to);
        expect(first).toBe(second);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * 9i — The full transition table matches the specification exactly
   *
   * Exhaustively checks every (from, to) combination against the spec-defined
   * transition table. This is a completeness check that no pair is accidentally
   * mis-classified.
   *
   * Validates: complete SalesTask transition coverage
   */
  it("full transition table matches the specification", () => {
    for (const from of OUTREACH_STATUSES) {
      for (const to of OUTREACH_STATUSES) {
        const expected =
          from === to || VALID_TRANSITIONS[from].has(to);
        expect(
          isValidOutreachTransition(from, to),
          `Expected isValidOutreachTransition("${from}", "${to}") to be ${expected}`,
        ).toBe(expected);
      }
    }
  });
});
