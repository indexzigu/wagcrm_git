import { describe, it, expect } from "vitest";
import { isSalesCampaignLocked } from "../mapping-service";

// 회귀: salesCampaigns select에서 status가 누락되면 sc.status=undefined가 들어와
// status.toUpperCase()로 판매기간 재동기화가 통째로 크래시했다(#137 회귀, prod 330건+).
// 방어선으로 null/undefined는 "락 아님"으로 취급한다(크래시 금지).
describe("isSalesCampaignLocked", () => {
  it("잠금 상태(정산중·완료·드랍)는 true", () => {
    expect(isSalesCampaignLocked("SETTLEMENT_IN_PROGRESS")).toBe(true);
    expect(isSalesCampaignLocked("COMPLETED")).toBe(true);
    expect(isSalesCampaignLocked("DROPPED")).toBe(true);
  });

  it("비잠금 상태(진행중·정산대기)는 false", () => {
    expect(isSalesCampaignLocked("ACTIVE")).toBe(false);
    expect(isSalesCampaignLocked("SETTLEMENT_WAIT")).toBe(false);
  });

  it("소문자도 대문자 정규화로 동일 판정", () => {
    expect(isSalesCampaignLocked("completed")).toBe(true);
  });

  it("null·undefined·빈문자는 크래시 없이 false", () => {
    expect(isSalesCampaignLocked(null)).toBe(false);
    expect(isSalesCampaignLocked(undefined)).toBe(false);
    expect(isSalesCampaignLocked("")).toBe(false);
  });
});
