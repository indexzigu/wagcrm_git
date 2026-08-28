/**
 * Unit tests for reminder-engine.ts
 *
 * Feature: ux-fixes-and-field-editing
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */

import { describe, it, expect } from "vitest";
import {
  recalculateReminders,
  invalidatePendingReminders,
  type ReminderSchedule,
} from "../reminder-engine";

describe("recalculateReminders", () => {
  it("returns empty array when endDate is in the past", () => {
    const result = recalculateReminders(
      "campaign-1",
      "2024-01-01",
      "2024-06-15",
    );
    expect(result).toEqual([]);
  });

  it("generates D-7, D-3, D-1, D-Day schedules for a future endDate", () => {
    const result = recalculateReminders(
      "campaign-1",
      "2024-07-20",
      "2024-07-01",
    );

    expect(result).toHaveLength(4);

    const types = result.map((r) => r.type);
    expect(types).toContain("D_MINUS_7");
    expect(types).toContain("D_MINUS_3");
    expect(types).toContain("D_MINUS_1");
    expect(types).toContain("D_DAY");

    // Verify dates
    const byType = Object.fromEntries(result.map((r) => [r.type, r]));
    expect(byType["D_MINUS_7"].scheduledAt).toBe("2024-07-13");
    expect(byType["D_MINUS_3"].scheduledAt).toBe("2024-07-17");
    expect(byType["D_MINUS_1"].scheduledAt).toBe("2024-07-19");
    expect(byType["D_DAY"].scheduledAt).toBe("2024-07-20");
  });

  it("only generates future-dated schedules (skips past offsets)", () => {
    // currentDate is 2024-07-18, endDate is 2024-07-20
    // D-7 = 2024-07-13 (past) → skip
    // D-3 = 2024-07-17 (past) → skip
    // D-1 = 2024-07-19 (future) → include
    // D-Day = 2024-07-20 (future) → include
    const result = recalculateReminders(
      "campaign-1",
      "2024-07-20",
      "2024-07-18",
    );

    expect(result).toHaveLength(2);
    const types = result.map((r) => r.type);
    expect(types).toContain("D_MINUS_1");
    expect(types).toContain("D_DAY");
  });

  it("includes D-Day schedule when currentDate equals endDate", () => {
    const result = recalculateReminders(
      "campaign-1",
      "2024-07-20",
      "2024-07-20",
    );

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("D_DAY");
    expect(result[0].scheduledAt).toBe("2024-07-20");
  });

  it("all generated schedules have PENDING status", () => {
    const result = recalculateReminders(
      "campaign-1",
      "2024-12-31",
      "2024-01-01",
    );

    for (const schedule of result) {
      expect(schedule.status).toBe("PENDING");
    }
  });

  it("all generated schedules have the correct campaignId", () => {
    const result = recalculateReminders(
      "my-campaign-id",
      "2024-12-31",
      "2024-01-01",
    );

    for (const schedule of result) {
      expect(schedule.campaignId).toBe("my-campaign-id");
    }
  });

  it("generates unique IDs for each schedule", () => {
    const result = recalculateReminders(
      "campaign-1",
      "2024-12-31",
      "2024-01-01",
    );

    const ids = result.map((r) => r.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all scheduledAt dates are at or before endDate", () => {
    const result = recalculateReminders(
      "campaign-1",
      "2024-08-15",
      "2024-07-01",
    );

    for (const schedule of result) {
      expect(schedule.scheduledAt <= "2024-08-15").toBe(true);
    }
  });
});

describe("invalidatePendingReminders", () => {
  it("marks PENDING reminders as CANCELLED", () => {
    const reminders: ReminderSchedule[] = [
      {
        id: "r1",
        campaignId: "c1",
        scheduledAt: "2024-07-13",
        type: "D_MINUS_7",
        status: "PENDING",
      },
      {
        id: "r2",
        campaignId: "c1",
        scheduledAt: "2024-07-17",
        type: "D_MINUS_3",
        status: "PENDING",
      },
    ];

    const result = invalidatePendingReminders(reminders);

    expect(result[0].status).toBe("CANCELLED");
    expect(result[1].status).toBe("CANCELLED");
  });

  it("does not change FIRED reminders", () => {
    const reminders: ReminderSchedule[] = [
      {
        id: "r1",
        campaignId: "c1",
        scheduledAt: "2024-07-13",
        type: "D_MINUS_7",
        status: "FIRED",
      },
      {
        id: "r2",
        campaignId: "c1",
        scheduledAt: "2024-07-17",
        type: "D_MINUS_3",
        status: "PENDING",
      },
    ];

    const result = invalidatePendingReminders(reminders);

    expect(result[0].status).toBe("FIRED");
    expect(result[1].status).toBe("CANCELLED");
  });

  it("does not change CANCELLED reminders", () => {
    const reminders: ReminderSchedule[] = [
      {
        id: "r1",
        campaignId: "c1",
        scheduledAt: "2024-07-13",
        type: "D_MINUS_7",
        status: "CANCELLED",
      },
    ];

    const result = invalidatePendingReminders(reminders);

    expect(result[0].status).toBe("CANCELLED");
  });

  it("returns a new array (does not mutate original)", () => {
    const reminders: ReminderSchedule[] = [
      {
        id: "r1",
        campaignId: "c1",
        scheduledAt: "2024-07-13",
        type: "D_MINUS_7",
        status: "PENDING",
      },
    ];

    const result = invalidatePendingReminders(reminders);

    expect(result).not.toBe(reminders);
    expect(reminders[0].status).toBe("PENDING");
  });

  it("handles empty array", () => {
    const result = invalidatePendingReminders([]);
    expect(result).toEqual([]);
  });
});
