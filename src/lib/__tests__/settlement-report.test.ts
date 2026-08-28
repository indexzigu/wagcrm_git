import { describe, expect, it } from "vitest";
import {
  buildSettlementReportModel,
  parseSettlementStatusFilter,
} from "@/lib/settlement-report";

describe("settlement-report", () => {
  it("includes both in-progress and completed campaigns in the report model", () => {
    const report = buildSettlementReportModel(
      [
        {
          id: "camp-1",
          status: "SETTLEMENT_IN_PROGRESS",
          updatedAt: new Date("2026-05-10T00:00:00.000Z"),
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-03T00:00:00.000Z"),
          actualSales: 1000000,
          totalMarginRate: 30,
          sellerMarginRate: 10,
          deal: { dealName: "앰플 공구", brandName: "브랜드A" },
          seller: { name: "셀러A" },
          sellerTaxType: "BUSINESS",
        },
        {
          id: "camp-2",
          status: "COMPLETED",
          updatedAt: new Date("2026-05-12T00:00:00.000Z"),
          startDate: new Date("2026-05-04T00:00:00.000Z"),
          endDate: new Date("2026-05-08T00:00:00.000Z"),
          actualSales: 500000,
          totalMarginRate: 25,
          sellerMarginRate: 8,
          deal: { dealName: "선크림 공구", brandName: null },
          seller: { name: "셀러B" },
          sellerTaxType: "BUSINESS",
        },
      ],
      "2026-05",
    );

    expect(report.summary.campaignCount).toBe(2);
    expect(report.campaigns.map((campaign) => campaign.status)).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(report.summary.totalRevenue).toBe(1500000);
    expect(report.summary.totalMargin).toBe(285000);
    expect(report.summary.totalSellerPayouts).toBe(140000);
  });

  it("reads the settlement schedule from the group when the campaign is grouped (CG-2 dual-read)", () => {
    const base = {
      status: "SETTLEMENT_IN_PROGRESS",
      updatedAt: new Date("2026-05-10T00:00:00.000Z"),
      startDate: new Date("2026-05-01T00:00:00.000Z"),
      endDate: new Date("2026-05-03T00:00:00.000Z"),
      actualSales: 1000000,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      deal: { dealName: "앰플 공구", brandName: "브랜드A" },
      seller: { name: "셀러A" },
    };

    const report = buildSettlementReportModel(
      [
        {
          // 그룹 캠페인: 캠페인 잔존값 대신 그룹 일정이 정본
          ...base,
          id: "grouped",
          expectedDepositDate: new Date("2026-05-20T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-05-25T00:00:00.000Z"),
          group: {
            expectedDepositDate: new Date("2026-06-01T00:00:00.000Z"),
            expectedPayoutDate: new Date("2026-06-05T00:00:00.000Z"),
          },
        },
        {
          // 그룹 캠페인인데 그룹 일정 미입력: 캠페인 잔존값으로 폴백하지 않는다(stale 방지)
          ...base,
          id: "grouped-empty",
          expectedDepositDate: new Date("2026-05-20T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-05-25T00:00:00.000Z"),
          group: { expectedDepositDate: null, expectedPayoutDate: null },
        },
        {
          // 무그룹 캠페인: 기존대로 캠페인 값 사용
          ...base,
          id: "ungrouped",
          expectedDepositDate: new Date("2026-05-20T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-05-25T00:00:00.000Z"),
          group: null,
        },
      ],
      "2026-05",
    );

    const byId = new Map(report.campaigns.map((c) => [c.id, c]));
    // 줄 구성·라벨은 채널 슬롯에서 파생한다 — 픽스처 채널 미지정은 셀러몰 갈래
    // (= 입금(셀러) + 지급(공급사))로 떨어진다.
    expect(byId.get("grouped")!.schedule).toBe("셀러 입금: 2026-06-01\\n공급사 지급: 2026-06-05");
    expect(byId.get("grouped-empty")!.schedule).toBe("");
    expect(byId.get("ungrouped")!.schedule).toBe("셀러 입금: 2026-05-20\\n공급사 지급: 2026-05-25");
  });

  /**
   * 자사몰(2026-08-25 2단계) — 종전 `입금 && 지급` AND 조건에서 자사몰은 입금 예정일이
   * 없어 **항상 빈 문자열**이었다(내보내기에서 일정 칸이 통째로 비었다).
   */
  it("자사몰 일정 문자열은 지급 두 줄로 나오고 입금 줄이 없다", () => {
    const report = buildSettlementReportModel(
      [
        {
          id: "own",
          status: "SETTLEMENT_IN_PROGRESS",
          salesChannel: "OWN_MALL_NAVER",
          updatedAt: new Date("2026-05-30T00:00:00.000Z"),
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-10T00:00:00.000Z"),
          actualSales: 1000,
          totalMarginRate: 30,
          sellerMarginRate: 15,
          deal: { dealName: "앰플 공구", brandName: "브랜드A" },
          seller: { name: "셀러A" },
          // 레거시 입금 예정일이 남아 있어도 칸이 없으므로 줄이 되지 않는다.
          expectedDepositDate: new Date("2026-06-01T00:00:00.000Z"),
          expectedSupplierPayoutDate: new Date("2026-06-03T00:00:00.000Z"),
          expectedPayoutDate: new Date("2026-06-07T00:00:00.000Z"),
          group: null,
        },
      ],
      "2026-05",
    );
    expect(report.campaigns[0].schedule).toBe("공급사 지급: 2026-06-03\\n셀러 지급: 2026-06-07");
  });

  it("한쪽 예정일만 입력돼도 그 줄은 살린다(종전 AND 조건은 통째로 버렸다)", () => {
    const report = buildSettlementReportModel(
      [
        {
          id: "half",
          status: "SETTLEMENT_IN_PROGRESS",
          salesChannel: "BRAND_MALL",
          updatedAt: new Date("2026-05-30T00:00:00.000Z"),
          startDate: new Date("2026-05-01T00:00:00.000Z"),
          endDate: new Date("2026-05-10T00:00:00.000Z"),
          actualSales: 1000,
          totalMarginRate: 30,
          sellerMarginRate: 15,
          deal: { dealName: "앰플 공구", brandName: "브랜드A" },
          seller: { name: "셀러A" },
          expectedDepositDate: new Date("2026-06-01T00:00:00.000Z"),
          expectedPayoutDate: null,
          group: null,
        },
      ],
      "2026-05",
    );
    expect(report.campaigns[0].schedule).toBe("공급사 입금: 2026-06-01");
  });

  // T-022: 정산완료 캠페인의 영업수익을 고쳐도 정산 페이지 목록에 반영되지 않던 결함.
  // 「정산 완료」 표는 이 모델을 읽고 「정산 진행 중」 표는 저장 컬럼을 읽는데, 이 모델이
  // 요율로 금액을 다시 계산해 두 표가 갈라져 있었다.
  describe("영업수익·판매대행비는 저장 컬럼이 정본이다 (T-022)", () => {
    const base = {
      status: "COMPLETED" as const,
      updatedAt: new Date("2026-05-12T00:00:00.000Z"),
      startDate: new Date("2026-05-04T00:00:00.000Z"),
      endDate: new Date("2026-05-08T00:00:00.000Z"),
      actualSales: 1000000,
      totalMarginRate: 30,
      sellerMarginRate: 10,
      deal: { dealName: "앰플 공구", brandName: "브랜드A" },
      seller: { name: "셀러A" },
      sellerTaxType: "BUSINESS",
    };

    it("수동으로 고친 영업수익이 목록 금액에 그대로 나온다", () => {
      const report = buildSettlementReportModel(
        [{ ...base, id: "manual", settlementSales: 250000, sellerExpense: 90000 }],
        "2026-05",
      );

      const campaign = report.campaigns[0];
      // 요율 재계산이면 300000/100000 이 나온다 — 저장값이 이겨야 한다.
      expect(campaign.totalMarginAmount).toBe(250000);
      expect(campaign.sellerPayoutAmount).toBe(90000);
      expect(campaign.netMarginAmount).toBe(160000);
      expect(report.summary.totalMargin).toBe(160000);
      expect(report.summary.totalSellerPayouts).toBe(90000);
    });

    it("개인 셀러의 판매대행비는 VAT 제외 기준 저장값을 따른다", () => {
      // 개인 셀러의 sellerExpense 는 actualSales/1.1 을 기준으로 계산돼 저장된다 —
      // 요율을 총매출에 그대로 곱하면 실제 지급액보다 커진다.
      const report = buildSettlementReportModel(
        [{ ...base, id: "individual", sellerTaxType: "INDIVIDUAL", sellerExpense: 90909 }],
        "2026-05",
      );

      expect(report.campaigns[0].sellerPayoutAmount).toBe(90909);
    });

    it("영업수익 0 은 미입력이 아니라 값이다", () => {
      const report = buildSettlementReportModel(
        [{ ...base, id: "zero", settlementSales: 0, sellerExpense: 0 }],
        "2026-05",
      );

      expect(report.campaigns[0].totalMarginAmount).toBe(0);
      expect(report.campaigns[0].sellerPayoutAmount).toBe(0);
    });

    it("저장 컬럼이 비어 있으면 종전 요율 식으로 폴백한다", () => {
      const report = buildSettlementReportModel(
        [
          { ...base, id: "null-col", settlementSales: null, sellerExpense: null },
          { ...base, id: "no-col" },
        ],
        "2026-05",
      );

      for (const campaign of report.campaigns) {
        expect(campaign.totalMarginAmount).toBe(300000);
        expect(campaign.sellerPayoutAmount).toBe(100000);
        expect(campaign.netMarginAmount).toBe(200000);
      }
    });
  });

  it("parses status filters conservatively", () => {
    expect(parseSettlementStatusFilter(null)).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
    expect(parseSettlementStatusFilter("SETTLEMENT_IN_PROGRESS")).toEqual([
      "SETTLEMENT_IN_PROGRESS",
    ]);
    expect(parseSettlementStatusFilter("COMPLETED")).toEqual(["COMPLETED"]);
    expect(parseSettlementStatusFilter("unexpected")).toEqual([
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
    ]);
  });
});
