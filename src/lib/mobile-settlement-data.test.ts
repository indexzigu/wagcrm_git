import { describe, it, expect } from "vitest";
import {
  toMobileSettlementCampaign,
  type MobileSettlementCampaignSource,
} from "./mobile-settlement-data";

function makeSource(
  overrides: Partial<MobileSettlementCampaignSource> = {},
): MobileSettlementCampaignSource {
  return {
    id: "camp-1",
    groupId: null,
    roundNumber: 2,
    status: "SETTLEMENT_WAIT",
    salesChannel: "BRAND_MALL",
    startDate: new Date("2026-06-01T00:00:00+09:00"),
    endDate: new Date("2026-06-15T00:00:00+09:00"),
    expectedDepositDate: new Date("2026-07-20T00:00:00+09:00"),
    expectedPayoutDate: new Date("2026-07-25T00:00:00+09:00"),
    expectedSupplierPayoutDate: null,
    settlementSales: { toString: () => "4820000" },
    actualSales: null,
    actualPayoutAmount: null,
    settlementGoodsCost: null,
    sellerExpense: { toString: () => "3150000" },
    isDepositReceived: false,
    isPayoutCompleted: true,
    isSupplierPayoutCompleted: false,
    deal: { dealName: "비타민C 앰플" },
    seller: { name: "김하늘", alias: "하늘맘" },
    group: null,
    ...overrides,
  };
}

describe("toMobileSettlementCampaign — 정산 대기 스냅샷 매퍼", () => {
  it("비그룹 캠페인은 자기 필드를 그대로 쓰고 Decimal은 number로 변환한다", () => {
    const row = toMobileSettlementCampaign(makeSource());
    expect(row).toMatchObject({
      id: "camp-1",
      groupId: null,
      dealName: "비타민C 앰플",
      roundNumber: 2,
      status: "SETTLEMENT_WAIT",
      expectedDepositDate: "2026-07-20",
      expectedPayoutDate: "2026-07-25",
      settlementSales: 4_820_000,
      sellerExpense: 3_150_000,
      isDepositReceived: false,
      isPayoutCompleted: true,
    });
  });

  it("셀러 별칭이 있으면 별칭, 없으면(빈 문자열 포함) 실명을 쓴다 — P2 alias 우선", () => {
    expect(toMobileSettlementCampaign(makeSource()).sellerName).toBe("하늘맘");
    expect(
      toMobileSettlementCampaign(makeSource({ seller: { name: "김하늘", alias: null } }))
        .sellerName,
    ).toBe("김하늘");
    expect(
      toMobileSettlementCampaign(makeSource({ seller: { name: "김하늘", alias: "" } }))
        .sellerName,
    ).toBe("김하늘");
  });

  it("날짜는 KST 달력일로 변환된다 — UTC 늦저녁은 KST 다음 날", () => {
    const row = toMobileSettlementCampaign(
      makeSource({ expectedDepositDate: new Date("2026-06-30T20:00:00Z") }),
    );
    expect(row.expectedDepositDate).toBe("2026-07-01");
  });

  it("그룹 캠페인은 그룹 정산 일정·플래그가 정본이다 (CG-2 dual-read, toCampaignRow와 동일)", () => {
    const row = toMobileSettlementCampaign(
      makeSource({
        groupId: "group-1",
        isDepositReceived: false,
        isPayoutCompleted: false,
        group: {
          name: null,
          expectedDepositDate: new Date("2026-08-01T00:00:00+09:00"),
          expectedPayoutDate: null,
          expectedSupplierPayoutDate: null,
          isDepositReceived: true,
          isPayoutCompleted: false,
          isSupplierPayoutCompleted: false,
        },
      }),
    );
    expect(row.expectedDepositDate).toBe("2026-08-01");
    // 그룹 값이 null이어도 캠페인 잔존값(2026-07-25)으로 폴백하지 않는다.
    expect(row.expectedPayoutDate).toBeNull();
    expect(row.isDepositReceived).toBe(true);
    expect(row.isPayoutCompleted).toBe(false);
  });

  it("정산 금액은 그룹이 있어도 캠페인 소유를 유지한다(방화벽)", () => {
    const row = toMobileSettlementCampaign(
      makeSource({
        groupId: "group-1",
        settlementSales: 100,
        sellerExpense: 50,
        group: {
          name: null,
          expectedDepositDate: null,
          expectedPayoutDate: null,
          expectedSupplierPayoutDate: null,
          isDepositReceived: false,
          isPayoutCompleted: false,
          isSupplierPayoutCompleted: false,
        },
      }),
    );
    expect(row.settlementSales).toBe(100);
    expect(row.sellerExpense).toBe(50);
  });
});
