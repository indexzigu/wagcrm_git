/**
 * Property-based tests for reminder-engine.ts
 *
 * Feature: ux-fixes-and-field-editing
 * Property 1: Reminder recalculation produces schedules aligned to endDate
 * **Validates: Requirements 1.1, 1.2, 1.3**
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { recalculateReminders } from "../reminder-engine";

// ---------------------------------------------------------------------------
// Helpers & Arbitraries
// ---------------------------------------------------------------------------

/** Generate a valid YYYY-MM-DD date string within a reasonable range. */
const dateStringArb = fc
  .date({
    min: new Date("2020-01-01T00:00:00"),
    max: new Date("2030-12-31T00:00:00"),
  })
  .map((d) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  });

/** Generate a non-empty campaign ID string. */
const campaignIdArb = fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0);

/** Parse YYYY-MM-DD to Date at midnight. */
function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

// ---------------------------------------------------------------------------
// Property 1: Reminder recalculation produces schedules aligned to endDate
// Validates: Requirements 1.1, 1.2, 1.3
// ---------------------------------------------------------------------------

describe("Property 1: Reminder recalculation produces schedules aligned to endDate", () => {
  /**
   * 1a — Requirement 1.3: Past endDate returns empty array
   *
   * For any endDate strictly before currentDate, recalculateReminders
   * SHALL return an empty array.
   */
  it("returns empty array when endDate is in the past (Req 1.3)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        // Generate a currentDate that is strictly after endDate
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const endD = parseDate(endDate);
          const curD = parseDate(currentDate);

          // Only test when endDate is strictly before currentDate
          fc.pre(endD < curD);

          const result = recalculateReminders(campaignId, endDate, currentDate);
          expect(result).toEqual([]);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1b — Requirement 1.1, 1.2: All generated schedules are at D-7, D-3, D-1, D-Day offsets
   *
   * For any future endDate, every generated schedule SHALL have a scheduledAt
   * that corresponds to exactly one of the D-7, D-3, D-1, D-Day offsets from endDate.
   */
  it("all schedules are at valid D-7/D-3/D-1/D-Day offsets from endDate (Req 1.1, 1.2)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const endD = parseDate(endDate);
          const curD = parseDate(currentDate);

          // Only test when endDate is today or in the future
          fc.pre(endD >= curD);

          const result = recalculateReminders(campaignId, endDate, currentDate);

          for (const schedule of result) {
            const scheduledD = parseDate(schedule.scheduledAt);
            const diffMs = endD.getTime() - scheduledD.getTime();
            const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));

            // The offset must be one of the known offsets
            const validOffsets = [7, 3, 1, 0];
            expect(validOffsets).toContain(diffDays);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1c — Requirement 1.2: All scheduledAt dates are at or before endDate
   *
   * For any inputs, every generated schedule SHALL have scheduledAt <= endDate.
   */
  it("all scheduledAt dates are at or before endDate (Req 1.2)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const endD = parseDate(endDate);
          const curD = parseDate(currentDate);

          fc.pre(endD >= curD);

          const result = recalculateReminders(campaignId, endDate, currentDate);

          for (const schedule of result) {
            expect(schedule.scheduledAt <= endDate).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1d — Requirement 1.2: Only future-dated schedules are generated
   *
   * For any future endDate, every generated schedule SHALL have scheduledAt >= currentDate.
   * Schedules that would fall before currentDate are excluded.
   */
  it("only generates schedules with scheduledAt >= currentDate (Req 1.2)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const endD = parseDate(endDate);
          const curD = parseDate(currentDate);

          fc.pre(endD >= curD);

          const result = recalculateReminders(campaignId, endDate, currentDate);

          for (const schedule of result) {
            expect(schedule.scheduledAt >= currentDate).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1e — Requirement 1.1: All generated schedules have PENDING status
   *
   * For any inputs, every generated schedule SHALL have status "PENDING".
   */
  it("all generated schedules have PENDING status (Req 1.1)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const endD = parseDate(endDate);
          const curD = parseDate(currentDate);

          fc.pre(endD >= curD);

          const result = recalculateReminders(campaignId, endDate, currentDate);

          for (const schedule of result) {
            expect(schedule.status).toBe("PENDING");
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1f — Requirement 1.1: Correct campaignId propagation
   *
   * For any campaignId and valid dates, every generated schedule SHALL
   * have the same campaignId as the input.
   */
  it("all generated schedules have the correct campaignId (Req 1.1)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const endD = parseDate(endDate);
          const curD = parseDate(currentDate);

          fc.pre(endD >= curD);

          const result = recalculateReminders(campaignId, endDate, currentDate);

          for (const schedule of result) {
            expect(schedule.campaignId).toBe(campaignId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1g — Requirement 1.2: Result is bounded to at most 4 schedules
   *
   * Since there are only 4 possible offsets (D-7, D-3, D-1, D-Day),
   * the result SHALL never contain more than 4 schedules.
   */
  it("result contains at most 4 schedules (Req 1.2)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const result = recalculateReminders(campaignId, endDate, currentDate);
          expect(result.length).toBeLessThanOrEqual(4);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * 1h — Requirement 1.2: Each reminder type appears at most once
   *
   * For any inputs, the result SHALL not contain duplicate reminder types.
   */
  it("each reminder type appears at most once (Req 1.2)", () => {
    fc.assert(
      fc.property(
        campaignIdArb,
        dateStringArb,
        dateStringArb,
        (campaignId, endDate, currentDate) => {
          const result = recalculateReminders(campaignId, endDate, currentDate);
          const types = result.map((r) => r.type);
          const uniqueTypes = new Set(types);
          expect(uniqueTypes.size).toBe(types.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
