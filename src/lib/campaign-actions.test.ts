// T-313 — a "기간 미정" campaign has placeholder dates, so no due date may be derived from them
// (otherwise a freshly created campaign shows as overdue on the board and mobile cards).
import { describe, expect, it } from "vitest";
import { getCampaignAction } from "./campaign-actions";
import type { CampaignRow } from "./crm-types";

const now = new Date("2026-11-20T12:00:00+09:00");

function row(overrides: Partial<CampaignRow>): CampaignRow {
  return {
    status: "PREPARATION",
    startDate: "2026-11-17",
    endDate: "2026-11-17",
    periodUnset: false,
    updatedAt: "2026-11-20T00:00:00Z",
    ...overrides,
  } as CampaignRow;
}

describe("getCampaignAction — 기간 미정(T-313)", () => {
  it("기간 미정이면 자리표시 날짜로 기한을 만들지 않는다", () => {
    const action = getCampaignAction(row({ periodUnset: true }), now);
    expect(action.dueDate).toBeNull();
    expect(action.tone).not.toBe("overdue");
    expect(action.label).toBe("오픈준비");
  });

  it("기간이 정해진 캠페인은 시작일 기준 기한을 그대로 만든다(대조군)", () => {
    const action = getCampaignAction(row({}), now);
    expect(action.dueDate).toBe("2026-11-16");
    expect(action.tone).toBe("overdue");
  });
});
