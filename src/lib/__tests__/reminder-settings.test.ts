import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
const update = vi.fn();
const create = vi.fn();

vi.mock("../prisma", () => ({
  getPrisma: () => ({ reminderSettings: { findFirst, update, create } }),
}));
vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ reminderSettings: { findFirst, update, create } }),
}));

import {
  DEFAULT_REMINDER_SETTINGS,
  getReminderSettings,
  updateReminderSettings,
} from "@/lib/reminder-settings";

beforeEach(() => {
  findFirst.mockReset();
  update.mockReset();
  create.mockReset();
});

describe("getReminderSettings", () => {
  it("행이 없으면 기본값이다", async () => {
    findFirst.mockResolvedValue(null);
    await expect(getReminderSettings()).resolves.toEqual(DEFAULT_REMINDER_SETTINGS);
  });

  it("같은 JSON 의 다른 키는 응답에 싣지 않는다", async () => {
    findFirst.mockResolvedValue({
      id: "row-1",
      settings: JSON.stringify({
        scheduleThresholds: { idealDays: 50, minDays: 20, deadlineDays: 10 },
        priorYearTaxReference: { totalIncome: 1_000 },
      }),
    });

    await expect(getReminderSettings()).resolves.toEqual({
      scheduleThresholds: { idealDays: 50, minDays: 20, deadlineDays: 10 },
    });
  });
});

describe("updateReminderSettings", () => {
  it("자기가 모르는 키를 지우지 않는다 — 이 행에는 다른 설정이 함께 산다", async () => {
    const otherKey = { incomeYear: 2000, totalIncome: 1_000 };
    findFirst.mockResolvedValue({
      id: "row-1",
      settings: JSON.stringify({
        scheduleThresholds: { idealDays: 60, minDays: 30, deadlineDays: 21 },
        priorYearTaxReference: otherKey,
      }),
    });

    const result = await updateReminderSettings({
      scheduleThresholds: { idealDays: 45, minDays: 30, deadlineDays: 21 },
    });

    expect(result).toEqual({
      scheduleThresholds: { idealDays: 45, minDays: 30, deadlineDays: 21 },
    });
    expect(update).toHaveBeenCalledTimes(1);
    const written = JSON.parse(update.mock.calls[0][0].data.settings);
    expect(written).toEqual({
      scheduleThresholds: { idealDays: 45, minDays: 30, deadlineDays: 21 },
      priorYearTaxReference: otherKey,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("기존 JSON 이 깨져 있어도 저장은 된다", async () => {
    findFirst.mockResolvedValue({ id: "row-1", settings: "{not json" });

    await updateReminderSettings({
      scheduleThresholds: { idealDays: 45, minDays: 30, deadlineDays: 21 },
    });

    expect(JSON.parse(update.mock.calls[0][0].data.settings)).toEqual({
      scheduleThresholds: { idealDays: 45, minDays: 30, deadlineDays: 21 },
    });
  });

  it("행이 없으면 새로 만든다", async () => {
    findFirst.mockResolvedValue(null);

    await updateReminderSettings({
      scheduleThresholds: { idealDays: 45, minDays: 30, deadlineDays: 21 },
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
});
