/**
 * 거래처별 정산 금액 묶음 계약(오너 확정 2026-08-28).
 *
 * 고정하는 것: ①거래처 단위 상계 ②방향은 거래처 순액의 부호 ③합계는 절대값(양수)
 * ④상계로 0 이 된 거래처도 팝오버에는 남는다 — 사라지면 바의 합계를 설명하지 못한다.
 */
import { describe, expect, it } from "vitest";
import {
  buildPartnerSettlementBreakdown,
  PARTNER_UNLINKED_NAME,
  type PartnerBreakdownInput,
} from "../settlement-partner-breakdown";

function campaign(overrides: Partial<PartnerBreakdownInput> = {}): PartnerBreakdownInput {
  return {
    id: "c1",
    campaignName: "테스트딜 - 테스트셀러",
    partnerId: "p1",
    partnerName: "가거래처",
    salesChannel: "OWN_MALL",
    actualSales: 1_000_000,
    settlementSales: 300_000,
    settlementGoodsCost: 400_000,
    ...overrides,
  };
}

describe("buildPartnerSettlementBreakdown", () => {
  it("선택이 없으면 합계도 그룹도 비어 있다", () => {
    expect(buildPartnerSettlementBreakdown([])).toEqual({
      payable: 0,
      receivable: 0,
      groups: [],
      estimated: false,
    });
  });

  it("같은 거래처의 캠페인은 상계해 한 줄로 묶는다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", settlementGoodsCost: 400_000 }),
      campaign({ id: "c2", settlementGoodsCost: 100_000 }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].amount).toBe(-500_000);
    expect(result.groups[0].campaigns.map((c) => c.campaignId)).toEqual(["c1", "c2"]);
    expect(result.payable).toBe(500_000);
    expect(result.receivable).toBe(0);
  });

  it("방향이 다른 거래처는 각각의 칸으로 간다 — 합계는 양수다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", partnerId: "p1", partnerName: "가거래처" }),
      campaign({
        id: "c2",
        partnerId: "p2",
        partnerName: "나거래처",
        salesChannel: "BRAND_MALL",
        settlementSales: 350_000,
      }),
    ]);

    expect(result.payable).toBe(400_000);
    expect(result.receivable).toBe(350_000);
    // 보낼 돈이 먼저, 받을 돈이 뒤 — 바의 칸 순서와 같다.
    expect(result.groups.map((g) => g.partnerName)).toEqual(["가거래처", "나거래처"]);
  });

  it("한 거래처 안에서 방향이 섞이면 순액의 부호가 방향을 정한다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", settlementGoodsCost: 200_000 }),
      campaign({
        id: "c2",
        salesChannel: "BRAND_MALL",
        settlementSales: 500_000,
      }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].amount).toBe(300_000);
    expect(result.payable).toBe(0);
    expect(result.receivable).toBe(300_000);
  });

  it("상계로 순액이 0 이 된 거래처는 어느 칸에도 안 들어가지만 내역에는 남는다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", settlementGoodsCost: 300_000 }),
      campaign({ id: "c2", salesChannel: "BRAND_MALL", settlementSales: 300_000 }),
    ]);

    expect(result.payable).toBe(0);
    expect(result.receivable).toBe(0);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].amount).toBe(0);
    expect(result.groups[0].campaigns).toHaveLength(2);
  });

  it("금액이 0 인 캠페인은 내역 줄을 만들지 않는다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", settlementGoodsCost: 400_000 }),
      // 합산 이관(수기 0) — 이 캠페인 몫으로 오갈 돈이 없다.
      campaign({ id: "c2", settlementGoodsCost: 0 }),
    ]);

    expect(result.groups[0].campaigns.map((c) => c.campaignId)).toEqual(["c1"]);
    expect(result.groups[0].amount).toBe(-400_000);
  });

  it("거래처 미연결 캠페인은 한 덩어리로 묶는다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", partnerId: null, partnerName: null }),
      campaign({ id: "c2", partnerId: null, partnerName: null }),
    ]);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].partnerName).toBe(PARTNER_UNLINKED_NAME);
    expect(result.groups[0].amount).toBe(-800_000);
  });

  // 교차 검증 지적 2026-08-28: 재무 카드는 같은 판정을 「추정 포함」으로 이미 노출한다.
  // 여기서 신호를 떨어뜨리면 같은 금액이 두 화면에서 다른 확실성을 갖는다.
  it("물품대금 미입력은 추정으로 표시된다 — 관측값이 있으면 아니다", () => {
    const estimated = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", settlementGoodsCost: null }),
    ]);
    expect(estimated.estimated).toBe(true);
    expect(estimated.groups[0].estimated).toBe(true);
    expect(estimated.groups[0].campaigns[0].estimated).toBe(true);

    const observed = buildPartnerSettlementBreakdown([campaign({ id: "c1" })]);
    expect(observed.estimated).toBe(false);
    expect(observed.groups[0].estimated).toBe(false);
  });

  it("금액 0 인 캠페인은 추정 표시를 올리지 않는다 — 순액에 아무것도 안 더한다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({ id: "c1", settlementGoodsCost: 400_000 }),
      // 합산 이관(수기 0)은 추정이 아니고 기여값도 0 이다.
      campaign({ id: "c2", settlementGoodsCost: 0 }),
    ]);
    expect(result.estimated).toBe(false);
  });

  it("부가 항목이 금액에 반영된다 — 빠지면 재무 카드와 어긋난다", () => {
    const result = buildPartnerSettlementBreakdown([
      campaign({
        id: "c1",
        settlementGoodsCost: 400_000,
        settlementItems: [
          { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 150_000 },
        ],
      }),
    ]);

    expect(result.groups[0].amount).toBe(-250_000);
    expect(result.payable).toBe(250_000);
  });
});
