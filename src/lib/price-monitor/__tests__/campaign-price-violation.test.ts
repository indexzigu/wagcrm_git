import { describe, it, expect } from "vitest";
import {
  resolveLatestVerdictByDeal,
  buildViolatedCampaignSummaries,
} from "../campaign-price-violation";

describe("resolveLatestVerdictByDeal (UX1-C)", () => {
  it("dealId별로 snapshotDate가 가장 최신인 verdict만 남긴다", () => {
    const rows = [
      { dealId: "deal-1", snapshotDate: "2026-07-01", verdict: "OK" as const },
      { dealId: "deal-1", snapshotDate: "2026-07-03", verdict: "VIOLATED" as const },
      { dealId: "deal-1", snapshotDate: "2026-07-02", verdict: "TIE" as const },
    ];

    const result = resolveLatestVerdictByDeal(rows);

    expect(result.get("deal-1")).toBe("VIOLATED");
  });

  it("여러 딜을 각각 독립적으로 해소한다", () => {
    const rows = [
      { dealId: "deal-1", snapshotDate: "2026-07-01", verdict: "VIOLATED" as const },
      { dealId: "deal-2", snapshotDate: "2026-07-01", verdict: "OK" as const },
    ];

    const result = resolveLatestVerdictByDeal(rows);

    expect(result.get("deal-1")).toBe("VIOLATED");
    expect(result.get("deal-2")).toBe("OK");
  });

  it("입력이 비어있으면 빈 Map을 반환한다", () => {
    expect(resolveLatestVerdictByDeal([]).size).toBe(0);
  });

  it("같은 날짜에 중복 스냅샷이 있으면 나중 항목(배열 순서상 뒤)을 우선한다", () => {
    // upsertDaily가 dealId+snapshotDate 유일성을 보장하므로 실제로는 발생하지 않지만,
    // 방어적으로 동일 날짜 중복 입력 시 결정적 동작(마지막 값 채택)을 보장한다.
    const rows = [
      { dealId: "deal-1", snapshotDate: "2026-07-01", verdict: "OK" as const },
      { dealId: "deal-1", snapshotDate: "2026-07-01", verdict: "VIOLATED" as const },
    ];

    expect(resolveLatestVerdictByDeal(rows).get("deal-1")).toBe("VIOLATED");
  });
});

describe("buildViolatedCampaignSummaries (UX1-C)", () => {
  it("캠페인의 딜(메인+하위) 중 최신 verdict가 VIOLATED인 것이 있으면 위반으로 집계한다", () => {
    const campaignDealIds = new Map<string, string[]>([
      ["campaign-1", ["deal-main-1", "deal-child-1"]],
    ]);
    const latestVerdictByDeal = new Map([
      ["deal-main-1", "OK" as const],
      ["deal-child-1", "VIOLATED" as const],
    ]);

    const result = buildViolatedCampaignSummaries(campaignDealIds, latestVerdictByDeal);

    expect(result.get("campaign-1")).toEqual({ violatedDealCount: 1 });
  });

  it("여러 딜이 위반이면 violatedDealCount에 모두 반영한다", () => {
    const campaignDealIds = new Map<string, string[]>([
      ["campaign-1", ["deal-a", "deal-b", "deal-c"]],
    ]);
    const latestVerdictByDeal = new Map([
      ["deal-a", "VIOLATED" as const],
      ["deal-b", "VIOLATED" as const],
      ["deal-c", "OK" as const],
    ]);

    const result = buildViolatedCampaignSummaries(campaignDealIds, latestVerdictByDeal);

    expect(result.get("campaign-1")).toEqual({ violatedDealCount: 2 });
  });

  it("위반 딜이 없으면 결과 Map에 해당 캠페인 키가 없다", () => {
    const campaignDealIds = new Map<string, string[]>([
      ["campaign-1", ["deal-a"]],
    ]);
    const latestVerdictByDeal = new Map([["deal-a", "OK" as const]]);

    const result = buildViolatedCampaignSummaries(campaignDealIds, latestVerdictByDeal);

    expect(result.has("campaign-1")).toBe(false);
  });

  it("스냅샷이 아예 없는 딜(latestVerdictByDeal에 없음)은 위반으로 집계하지 않는다", () => {
    const campaignDealIds = new Map<string, string[]>([
      ["campaign-1", ["deal-no-snapshot"]],
    ]);
    const latestVerdictByDeal = new Map<string, "OK" | "TIE" | "VIOLATED" | "NO_DATA">();

    const result = buildViolatedCampaignSummaries(campaignDealIds, latestVerdictByDeal);

    expect(result.has("campaign-1")).toBe(false);
  });
});
