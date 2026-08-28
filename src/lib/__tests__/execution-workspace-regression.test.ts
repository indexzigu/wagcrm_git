import { describe, expect, it } from "vitest";

import {
  DEFAULT_CAMPAIGN_CHECKLIST_TEMPLATES,
  EXECUTION_CHECKLIST_GROUPS,
  getNextCampaignStatus,
  getWorkspaceStatuses,
} from "../campaign-checklist";
import { getZoneForStatus } from "../zone-config";

describe("execution workspace regression guard", () => {
  it("keeps settlement wait in the execution workspace until manual settlement handoff", () => {
    expect(getWorkspaceStatuses("pipeline")).toEqual([
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(getWorkspaceStatuses("settlement")).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(getNextCampaignStatus("SETTLEMENT_WAIT")).toBeNull();
  });

  it("keeps dropped campaigns outside the normal execution flow", () => {
    expect(getZoneForStatus("DROPPED")).toBe("DROPPED");
    expect(getNextCampaignStatus("DROPPED")).toBeNull();
  });

  it("uses grouped execution checklist templates instead of a flat generic list", () => {
    expect(EXECUTION_CHECKLIST_GROUPS.PREPARATION.map((group) => group.title)).toEqual([
      "일정/조건 확정",
      "상품/가격 확인",
      "링크/트래킹 세팅",
      "콘텐츠/운영자료 확인",
      "오픈 전 점검",
    ]);
    expect(DEFAULT_CAMPAIGN_CHECKLIST_TEMPLATES.PREPARATION).toEqual(
      expect.arrayContaining([
        { label: "행사 일정 확정" },
        { label: "트래킹 링크 생성 및 검수" },
        { label: "오픈 전 최종 점검" },
      ]),
    );
  });
});
