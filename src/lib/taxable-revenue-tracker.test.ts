// 네이버 판매자 등급 과세기준매출 트래커 — 순수 함수 계약.
// ⚠️ 전 수치는 합성값이다(공개 레포 — P0). `now` 는 항상 주입한다 — 시스템
// 시각에 기대는 고정 날짜 픽스처는 P9 「시한폭탄」 부류라 쓰지 않는다.
import { describe, expect, it } from "vitest";
import {
  buildTaxableRevenueTracker,
  computeCampaignTaxableAmount,
  computeFeeIncrease,
  countOverlapDays,
  resolveCampaignDayRange,
  resolveCrossingCostWindow,
  resolveNaverSellerGradeIndex,
  resolveNextGradeUpdate,
  resolvePreviousGradeUpdate,
  resolveTaxableChannelGroup,
  resolveTaxableRevenueQueryFloor,
  resolveVatHalf,
  NAVER_SELLER_GRADES,
  type TaxableRevenueCampaignInput,
} from "./taxable-revenue-tracker";

/** KST 날짜의 정오 — 경계 흔들림 없이 「그 날」을 가리킨다. */
function kstNoon(ymd: string): Date {
  return new Date(`${ymd}T12:00:00+09:00`);
}

/**
 * 시작일을 안 주면 종료일 하루짜리 캠페인 — 일수 안분이 결과를 바꾸지 않는 기본형.
 * 기본 종료일(2026-08-10)은 NOW 기준 다음 갱신 기준기간(2026년) 안이고 **직전 갱신 기준기간**
 * (2025년 2기 + 2026년 1기) 밖이다 — 그래서 기본형만 쓰는 테스트의 현재 등급(CRM 추정)은 최하위다.
 */
function campaign(overrides: Partial<TaxableRevenueCampaignInput> = {}): TaxableRevenueCampaignInput {
  const endDate = overrides.endDate ?? kstNoon("2026-08-10");
  return {
    salesChannel: "OWN_MALL_NAVER",
    status: "CLOSED",
    actualSales: 1_100_000,
    sellerExpense: 110_000,
    settlementSales: 330_000,
    settlementItems: [],
    ...overrides,
    endDate,
    startDate: overrides.startDate ?? endDate,
  };
}

const NOW = kstNoon("2026-09-29"); // 기준 = 2026년 1기+2기, 다음 갱신 2027-02-14

describe("채널 판정", () => {
  it("미지정은 세무 보드 판정(→셀러몰)을 거치지 않고 따로 가른다", () => {
    expect(resolveTaxableChannelGroup("UNSPECIFIED")).toBe("UNSPECIFIED");
    expect(resolveTaxableChannelGroup("")).toBe("UNSPECIFIED");
    expect(resolveTaxableChannelGroup(null)).toBe("UNSPECIFIED");
    expect(resolveTaxableChannelGroup("OWN_MALL_KAKAO")).toBe("OWN_MALL");
    expect(resolveTaxableChannelGroup("BRAND_MALL")).toBe("BRAND_MALL");
    expect(resolveTaxableChannelGroup("SELLER_MALL")).toBe("SELLER_MALL");
  });
});

describe("채널별 과세 매출 기준", () => {
  it("자사몰은 actualSales 전액", () => {
    expect(computeCampaignTaxableAmount("OWN_MALL", campaign({ actualSales: 2_200_000 }))).toEqual({
      kind: "AMOUNT",
      vatIncluded: 2_200_000,
    });
  });

  it("셀러몰은 판매액 − 셀러수수료 **전체**다(수수료가 아니다)", () => {
    const result = computeCampaignTaxableAmount(
      "SELLER_MALL",
      campaign({ salesChannel: "SELLER_MALL", actualSales: 11_000_000, sellerExpense: 3_300_000 }),
    );
    expect(result).toEqual({ kind: "AMOUNT", vatIncluded: 7_700_000 });
  });

  it("브랜드몰은 영업수익(부가 항목 가산 포함 — 세무 보드 SSOT)", () => {
    const result = computeCampaignTaxableAmount(
      "BRAND_MALL",
      campaign({
        salesChannel: "BRAND_MALL",
        actualSales: 11_000_000,
        settlementSales: 2_200_000,
        settlementItems: [
          { invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 110_000 },
          // 다른 축 항목은 영업수익 계산서에 실리지 않는다
          { invoiceMode: "PURCHASE_RECEIVE", counterparty: "SELLER", amount: 55_000 },
        ],
      }),
    );
    expect(result).toEqual({ kind: "AMOUNT", vatIncluded: 2_310_000 });
  });

  it("미지정은 범위(하한 = 브랜드몰 산식, 상한 = actualSales)", () => {
    const result = computeCampaignTaxableAmount(
      "UNSPECIFIED",
      campaign({ salesChannel: "UNSPECIFIED", actualSales: 5_500_000, settlementSales: 1_100_000 }),
    );
    expect(result).toEqual({ kind: "RANGE", lowerVatIncluded: 1_100_000, upperVatIncluded: 5_500_000 });
  });

  it("미지정의 하한이 결번이면 0(표시용 하한) — 상한은 그대로", () => {
    const result = computeCampaignTaxableAmount(
      "UNSPECIFIED",
      campaign({ salesChannel: "UNSPECIFIED", actualSales: 5_500_000, settlementSales: null }),
    );
    expect(result).toEqual({ kind: "RANGE", lowerVatIncluded: 0, upperVatIncluded: 5_500_000 });
  });

  it("모르는 금액은 0 이 아니라 MISSING 이다", () => {
    expect(computeCampaignTaxableAmount("OWN_MALL", campaign({ actualSales: null }))).toEqual({ kind: "MISSING" });
    expect(
      computeCampaignTaxableAmount("SELLER_MALL", campaign({ salesChannel: "SELLER_MALL", sellerExpense: null })),
    ).toEqual({ kind: "MISSING" });
    expect(
      computeCampaignTaxableAmount("BRAND_MALL", campaign({ salesChannel: "BRAND_MALL", settlementSales: null })),
    ).toEqual({ kind: "MISSING" });
    expect(
      computeCampaignTaxableAmount("UNSPECIFIED", campaign({ salesChannel: "UNSPECIFIED", actualSales: null })),
    ).toEqual({ kind: "MISSING" });
  });
});

describe("집계 — 제외 상태 · 미입력 · 미지정", () => {
  it("PROPOSAL · DROPPED 는 제외하고 그 외 상태는 포함한다", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ status: "PROPOSAL", actualSales: 99_000_000 }),
        campaign({ status: "DROPPED", actualSales: 99_000_000 }),
        campaign({ status: "ACTIVE", actualSales: 1_100_000 }),
        campaign({ status: "SETTLED", actualSales: 2_200_000 }),
      ],
      NOW,
    );
    expect(tracker.channels.OWN_MALL.count).toBe(2);
    expect(tracker.cumulativeVatIncluded).toBe(3_300_000);
    expect(tracker.cumulativeSupply).toBe(3_000_000);
  });

  it("결번·null 은 합계에 0 으로 섞지 않고 「금액 미입력」 건수로 센다", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ actualSales: 1_100_000 }),
        campaign({ actualSales: null }),
        campaign({ salesChannel: "SELLER_MALL", actualSales: 1_100_000, sellerExpense: null }),
        campaign({ salesChannel: "BRAND_MALL", settlementSales: 0 }),
      ],
      NOW,
    );
    expect(tracker.cumulativeVatIncluded).toBe(1_100_000);
    expect(tracker.missingAmountCount).toBe(3);
    expect(tracker.channels.OWN_MALL).toMatchObject({ count: 1, missingCount: 1 });
    expect(tracker.channels.SELLER_MALL).toMatchObject({ count: 0, missingCount: 1 });
    expect(tracker.channels.BRAND_MALL).toMatchObject({ count: 0, missingCount: 1 });
  });

  it("미지정은 여유 판정에 상한(보수적)을 쓰고 하한 범위와 분류 필요 건수를 함께 낸다", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ actualSales: 11_000_000 }),
        campaign({ salesChannel: "UNSPECIFIED", actualSales: 5_500_000, settlementSales: 1_100_000 }),
        campaign({ salesChannel: "UNSPECIFIED", actualSales: null }),
      ],
      NOW,
    );
    expect(tracker.unspecifiedCount).toBe(2);
    expect(tracker.channels.UNSPECIFIED).toMatchObject({
      count: 1,
      missingCount: 1,
      vatIncluded: 5_500_000,
      supply: 5_000_000,
      lowerVatIncluded: 1_100_000,
      lowerSupply: 1_000_000,
    });
    expect(tracker.cumulativeSupply).toBe(15_000_000); // (11,000,000 + 5,500,000) / 1.1
    expect(tracker.cumulativeSupplyLower).toBe(11_000_000); // (11,000,000 + 1,100,000) / 1.1
    expect(tracker.headroomSupply).toBe(300_000_000 - 15_000_000);
  });

  it("공급가액은 합계에 한 번만 반올림한다", () => {
    const tracker = buildTaxableRevenueTracker(
      [campaign({ actualSales: 1_000 }), campaign({ salesChannel: "BRAND_MALL", settlementSales: 1_000 })],
      NOW,
    );
    // 각각 909.09 → 909 + 909 = 1,818 이지만 합계 2,000 / 1.1 = 1,818.18 → 1,818
    expect(tracker.cumulativeSupply).toBe(1_818);
  });
});

describe("귀속 기간 — endDate 의 KST 날짜가 속한 반기", () => {
  it("06-30 KST 는 1기, 07-01 KST 는 2기 — UTC 로 같은 날이어도 KST 로 가른다", () => {
    expect(resolveVatHalf("2026-06-30")).toEqual({ year: 2026, half: 1 });
    expect(resolveVatHalf("2026-07-01")).toEqual({ year: 2026, half: 2 });
  });

  it("8월 갱신 기준기간(전년 2기 + 당해 1기)에서 06-30/07-01 경계가 KST 로 갈린다", () => {
    const now = kstNoon("2027-03-01"); // 기준 = 2026년 2기 + 2027년 1기
    const tracker = buildTaxableRevenueTracker(
      [
        // UTC 2026-06-30T14:59:59Z = KST 06-30 23:59:59 → 2026년 1기 → 기준기간 밖
        campaign({ endDate: new Date("2026-06-30T14:59:59Z"), actualSales: 1_100_000 }),
        // UTC 2026-06-30T15:00:00Z = KST 07-01 00:00 → 2026년 2기 → 포함
        campaign({ endDate: new Date("2026-06-30T15:00:00Z"), actualSales: 2_200_000 }),
        // 2027년 1기 마지막 날 → 포함 · 2027년 2기 첫날 → 밖
        campaign({ endDate: new Date("2027-06-30T14:59:59Z"), actualSales: 3_300_000 }),
        campaign({ endDate: new Date("2027-06-30T15:00:00Z"), actualSales: 4_400_000 }),
      ],
      now,
    );
    expect(tracker.cumulativeVatIncluded).toBe(5_500_000);
    expect(tracker.channels.OWN_MALL.count).toBe(2);
  });
});

describe("다음 갱신일 · 기준기간 선택(KST 날짜)", () => {
  it("02-13 은 2/14 갱신(직전 달력연도), 02-14 부터는 8/14 갱신(전년 2기 + 당해 1기, 미확인 가정)", () => {
    expect(resolveNextGradeUpdate("2027-02-13")).toEqual({
      nextUpdateYmd: "2027-02-14",
      referencePeriod: {
        halves: [
          { year: 2026, half: 1 },
          { year: 2026, half: 2 },
        ],
        startYmd: "2026-01-01",
        endYmd: "2026-12-31",
        label: "2026년 1기+2기",
        assumed: false,
      },
    });
    expect(resolveNextGradeUpdate("2027-02-14")).toEqual({
      nextUpdateYmd: "2027-08-14",
      referencePeriod: {
        halves: [
          { year: 2026, half: 2 },
          { year: 2027, half: 1 },
        ],
        startYmd: "2026-07-01",
        endYmd: "2027-06-30",
        label: "2026년 2기 + 2027년 1기",
        assumed: true,
      },
    });
  });

  it("08-13 은 8/14 갱신, 08-14 부터는 익년 2/14 갱신(당해 달력연도)", () => {
    expect(resolveNextGradeUpdate("2026-08-13").nextUpdateYmd).toBe("2026-08-14");
    expect(resolveNextGradeUpdate("2026-08-13").referencePeriod.label).toBe("2025년 2기 + 2026년 1기");
    expect(resolveNextGradeUpdate("2026-08-14").nextUpdateYmd).toBe("2027-02-14");
    expect(resolveNextGradeUpdate("2026-08-14").referencePeriod.label).toBe("2026년 1기+2기");
    expect(resolveNextGradeUpdate("2026-12-31").nextUpdateYmd).toBe("2027-02-14");
    expect(resolveNextGradeUpdate("2027-01-01").nextUpdateYmd).toBe("2027-02-14");
  });

  it("경계는 UTC 가 아니라 KST 날짜로 판정한다", () => {
    // UTC 02-13 15:00 = KST 02-14 00:00
    expect(buildTaxableRevenueTracker([], new Date("2027-02-13T14:59:59Z")).nextUpdateYmd).toBe("2027-02-14");
    expect(buildTaxableRevenueTracker([], new Date("2027-02-13T15:00:00Z")).nextUpdateYmd).toBe("2027-08-14");
    expect(buildTaxableRevenueTracker([], new Date("2026-08-13T14:59:59Z")).nextUpdateYmd).toBe("2026-08-14");
    expect(buildTaxableRevenueTracker([], new Date("2026-08-13T15:00:00Z")).nextUpdateYmd).toBe("2027-02-14");
  });

  it("DB 프리필터 하한은 직전·다음 기준기간 첫날과 비용 창 중 가장 이른 날의 KST 자정", () => {
    // 2026-09-29 → 직전 기준 2025-07-01, 다음 기준 2026-01-01, 비용 창 (2026-03-29, …] → 2025-07-01
    expect(resolveTaxableRevenueQueryFloor(NOW).toISOString()).toBe("2025-06-30T15:00:00.000Z");
    // 2027-03-01 → 직전 기준 2026-01-01, 다음 기준 2026-07-01, 비용 창 (2026-09-01, …] → 2026-01-01
    expect(resolveTaxableRevenueQueryFloor(kstNoon("2027-03-01")).toISOString()).toBe("2025-12-31T15:00:00.000Z");
  });
});

describe("등급 · 기준선", () => {
  it("상한 「이하」가 그 등급이다 — 3억은 영세, 3억+1원은 중소1, 30억 초과는 일반", () => {
    expect(NAVER_SELLER_GRADES[resolveNaverSellerGradeIndex(300_000_000)].label).toBe("영세");
    expect(NAVER_SELLER_GRADES[resolveNaverSellerGradeIndex(300_000_001)].label).toBe("중소1");
    expect(NAVER_SELLER_GRADES[resolveNaverSellerGradeIndex(1_000_000_000)].label).toBe("중소2");
    expect(NAVER_SELLER_GRADES[resolveNaverSellerGradeIndex(3_000_000_001)].label).toBe("일반");
  });

  it("여유가 크면 WITHIN — 기준선은 누적이 속한 등급의 상한", () => {
    const tracker = buildTaxableRevenueTracker([campaign({ actualSales: 110_000_000 })], NOW);
    expect(tracker.status).toBe("WITHIN");
    expect(tracker.estimatedGrade.label).toBe("영세");
    expect(tracker.thresholdSupply).toBe(300_000_000);
    expect(tracker.headroomSupply).toBe(200_000_000);
    expect(tracker.vatIncludedMargin).toBe(300_000_000 - 110_000_000);
    expect(tracker.progressRatio).toBeCloseTo(100 / 300);
  });

  it("여유가 기준선의 10% 이하이면 NEAR", () => {
    const tracker = buildTaxableRevenueTracker([campaign({ actualSales: 308_000_000 })], NOW); // 공급 2.8억
    expect(tracker.status).toBe("NEAR");
    expect(tracker.headroomSupply).toBe(20_000_000);
    // VAT 포함 기준으로는 이미 넘었다 — 음수로 드러낸다
    expect(tracker.vatIncludedMargin).toBe(300_000_000 - 308_000_000);
  });

  it("직전 기준기간 누적이 없으면 현재 등급(CRM 추정)은 최하위 — 그 기준선을 넘으면 OVER", () => {
    const tracker = buildTaxableRevenueTracker([campaign({ actualSales: 352_000_000 })], NOW); // 공급 3.2억
    expect(tracker.status).toBe("OVER");
    expect(tracker.currentGrade.label).toBe("영세");
    expect(tracker.estimatedGrade.label).toBe("중소1");
    expect(tracker.thresholdSupply).toBe(300_000_000);
    expect(tracker.overSupply).toBe(20_000_000);
    expect(tracker.headroomSupply).toBeNull();
    expect(tracker.nextThresholdHeadroomSupply).toBe(180_000_000);
    expect(tracker.progressRatio).toBe(1);
  });
});

describe("넘었을 때 비용 — 네이버 자사몰 최근 6개월 × 요율 차", () => {
  it("요율 단위는 0.001%p 정수라 부동소수 찌꺼기가 없다", () => {
    expect(computeFeeIncrease(30_000_000, 1947, 2563)).toBe(184_800);
  });

  it("비용 창은 (오늘 − 6개월, 오늘] 이고 말일은 클램프한다", () => {
    expect(resolveCrossingCostWindow("2026-09-29")).toEqual({ afterYmd: "2026-03-29", toYmd: "2026-09-29" });
    expect(resolveCrossingCostWindow("2026-08-31")).toEqual({ afterYmd: "2026-02-28", toYmd: "2026-08-31" });
  });

  it("네이버 자사몰 최근 6개월만 표본이다 — 카카오·기타 자사몰·창 밖·미래·제외 상태는 빠진다", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ endDate: kstNoon("2026-03-30"), actualSales: 10_000_000 }), // 창 첫날
        campaign({ endDate: kstNoon("2026-09-29"), actualSales: 20_000_000 }), // 오늘
        campaign({ endDate: kstNoon("2026-03-29"), actualSales: 40_000_000 }), // 창 밖
        campaign({ endDate: kstNoon("2026-10-05"), actualSales: 80_000_000 }), // 아직 안 끝남
        campaign({ salesChannel: "OWN_MALL_KAKAO", endDate: kstNoon("2026-06-01"), actualSales: 160_000_000 }),
        campaign({ salesChannel: "OWN_MALL", endDate: kstNoon("2026-06-01"), actualSales: 1_000_000 }),
        campaign({ status: "DROPPED", endDate: kstNoon("2026-06-01"), actualSales: 2_000_000 }),
        campaign({ endDate: kstNoon("2026-06-01"), actualSales: null }),
      ],
      NOW,
    );
    expect(tracker.crossingCost).toMatchObject({
      kind: "IF_CROSSED",
      naverOwnMallSales: 30_000_000,
      naverOwnMallMissingCount: 1,
    });
    expect(tracker.crossingCost?.from.label).toBe("영세");
    expect(tracker.crossingCost?.to.label).toBe("중소1");
    expect(tracker.crossingCost?.amount).toBe(184_800);
  });

  it("이미 넘었으면 현재 등급 → 추정 등급 요율 차로 계산한다", () => {
    const tracker = buildTaxableRevenueTracker(
      [campaign({ endDate: kstNoon("2026-08-01"), actualSales: 550_000_000 })], // 공급 5억 → 중소1
      NOW,
    );
    expect(tracker.status).toBe("OVER");
    expect(tracker.crossingCost).toMatchObject({ kind: "ALREADY_OVER" });
    expect(tracker.crossingCost?.from.label).toBe("영세");
    expect(tracker.crossingCost?.to.label).toBe("중소1");
    expect(tracker.crossingCost?.amount).toBe(computeFeeIncrease(550_000_000, 1947, 2563));
  });

  it("일반 등급(위 등급 없음) 안에서는 비용이 없다 — 이미 넘은 경우는 현재 → 일반", () => {
    const tracker = buildTaxableRevenueTracker([campaign({ actualSales: 3_410_000_000 })], NOW); // 공급 31억
    expect(tracker.estimatedGrade.label).toBe("일반");
    expect(tracker.nextThresholdHeadroomSupply).toBeNull();
    expect(tracker.crossingCost?.to.label).toBe("일반");
  });
});

describe("자사몰 일수 안분 — 판매일 귀속 근사(나머지 채널은 종료일 귀속)", () => {
  it("12/26~01/01 자사몰 캠페인은 1/7 만 다음 해 기준기간에 들어간다", () => {
    const tracker = buildTaxableRevenueTracker(
      [campaign({ startDate: kstNoon("2025-12-26"), endDate: kstNoon("2026-01-01"), actualSales: 7_000_000 })],
      NOW,
    );
    expect(tracker.channels.OWN_MALL).toMatchObject({ count: 1, vatIncluded: 1_000_000 });
  });

  it("기준기간 안에 다 들면 전액, 다 밖이면 제외", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ startDate: kstNoon("2026-03-01"), endDate: kstNoon("2026-03-10"), actualSales: 3_300_000 }),
        campaign({ startDate: kstNoon("2025-12-01"), endDate: kstNoon("2025-12-31"), actualSales: 9_900_000 }),
      ],
      NOW,
    );
    expect(tracker.channels.OWN_MALL).toMatchObject({ count: 1, vatIncluded: 3_300_000 });
  });

  it("브랜드몰은 같은 기간이어도 종료일 반기에 통째로 귀속한다(계산서 기반)", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({
          salesChannel: "BRAND_MALL",
          startDate: kstNoon("2025-12-26"),
          endDate: kstNoon("2026-01-01"),
          settlementSales: 7_000_000,
        }),
      ],
      NOW,
    );
    expect(tracker.channels.BRAND_MALL.vatIncluded).toBe(7_000_000);
  });

  it("KST 날짜로 센다 — UTC 로는 전날인 시작 시각도 KST 날짜로 1일을 차지한다", () => {
    // 2025-12-31T15:00Z = KST 2026-01-01 00:00 → 구간은 01-01 하루뿐
    const range = resolveCampaignDayRange(new Date("2025-12-31T15:00:00Z"), new Date("2026-01-01T03:00:00Z"));
    expect(range).toEqual({ startYmd: "2026-01-01", endYmd: "2026-01-01", totalDays: 1 });
    expect(countOverlapDays(range, "2026-01-01", "2026-12-31")).toBe(1);
  });

  it("시작일이 종료일보다 늦은 잘못된 기간은 종료일 하루로 본다", () => {
    expect(resolveCampaignDayRange(kstNoon("2026-01-05"), kstNoon("2025-12-31"))).toEqual({
      startYmd: "2025-12-31",
      endYmd: "2025-12-31",
      totalDays: 1,
    });
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ startDate: kstNoon("2026-01-05"), endDate: kstNoon("2025-12-31"), actualSales: 5_000_000 }), // 2025 → 밖
        campaign({ startDate: kstNoon("2026-03-10"), endDate: kstNoon("2026-03-01"), actualSales: 2_200_000 }), // 03-01 하루 → 전액
      ],
      NOW,
    );
    expect(tracker.channels.OWN_MALL).toMatchObject({ count: 1, vatIncluded: 2_200_000 });
  });

  it("비용 표본 창 (오늘 − 6개월, 오늘] 도 일수로 안분한다", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        // 03-25~04-03(10일) 중 창 안 03-30~04-03 = 5일 → 절반
        campaign({ startDate: kstNoon("2026-03-25"), endDate: kstNoon("2026-04-03"), actualSales: 10_000_000 }),
        // 03-20~03-29 → 창 첫날(03-30) 전에 끝남 → 0
        campaign({ startDate: kstNoon("2026-03-20"), endDate: kstNoon("2026-03-29"), actualSales: 40_000_000 }),
        // 진행 중 09-25~10-04(10일) 중 오늘까지 5일 → 부분 실적의 절반
        campaign({ status: "ACTIVE", startDate: kstNoon("2026-09-25"), endDate: kstNoon("2026-10-04"), actualSales: 2_000_000 }),
      ],
      NOW,
    );
    expect(tracker.crossingCost?.naverOwnMallSales).toBe(6_000_000);
  });
});

describe("진행·예정(아직 안 끝남)은 「금액 미입력」과 가른다", () => {
  it("종료일이 오늘 이후인데 금액을 모르면 pending, 끝났는데 모르면 missing", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ status: "ACTIVE", startDate: kstNoon("2026-09-20"), endDate: kstNoon("2026-10-20"), actualSales: null }),
        campaign({ status: "PREPARATION", salesChannel: "BRAND_MALL", endDate: kstNoon("2026-11-30"), settlementSales: null }),
        campaign({ endDate: kstNoon("2026-06-01"), actualSales: null }),
        // 오늘 끝난 건은 끝난 것이다
        campaign({ salesChannel: "SELLER_MALL", endDate: NOW, sellerExpense: null }),
      ],
      NOW,
    );
    expect(tracker.pendingCount).toBe(2);
    expect(tracker.missingAmountCount).toBe(2);
    expect(tracker.channels.OWN_MALL).toMatchObject({ pendingCount: 1, missingCount: 1 });
    expect(tracker.channels.BRAND_MALL).toMatchObject({ pendingCount: 1, missingCount: 0 });
    expect(tracker.channels.SELLER_MALL).toMatchObject({ pendingCount: 0, missingCount: 1 });
    // 진행 중 네이버 자사몰의 빈 금액은 비용 표본의 「미입력」이 아니다
    expect(tracker.crossingCost?.naverOwnMallMissingCount).toBe(1);
    expect(tracker.cumulativeVatIncluded).toBe(0);
  });

  it("진행 중이라도 부분 실적이 있으면 그대로 안분해 넣는다", () => {
    const tracker = buildTaxableRevenueTracker(
      [campaign({ status: "ACTIVE", startDate: kstNoon("2026-09-20"), endDate: kstNoon("2026-10-19"), actualSales: 3_000_000 })],
      NOW,
    );
    expect(tracker.pendingCount).toBe(0);
    expect(tracker.channels.OWN_MALL).toMatchObject({ count: 1, vatIncluded: 3_000_000 });
  });
});

describe("현재 등급(CRM 추정) — 직전 갱신 기준기간의 누적으로 환산", () => {
  it("직전 갱신일·기준기간 선택(KST 날짜 경계)", () => {
    expect(resolvePreviousGradeUpdate("2027-02-13")).toMatchObject({
      updateYmd: "2026-08-14",
      referencePeriod: { startYmd: "2025-07-01", endYmd: "2026-06-30", assumed: true },
    });
    expect(resolvePreviousGradeUpdate("2027-02-14")).toMatchObject({
      updateYmd: "2027-02-14",
      referencePeriod: { startYmd: "2026-01-01", endYmd: "2026-12-31", assumed: false },
    });
    expect(resolvePreviousGradeUpdate("2026-08-13")).toMatchObject({
      updateYmd: "2026-02-14",
      referencePeriod: { startYmd: "2025-01-01", endYmd: "2025-12-31", assumed: false },
    });
    expect(resolvePreviousGradeUpdate("2026-08-14")).toMatchObject({
      updateYmd: "2026-08-14",
      referencePeriod: { startYmd: "2025-07-01", endYmd: "2026-06-30", assumed: true },
    });
    expect(resolvePreviousGradeUpdate("2026-12-31").updateYmd).toBe("2026-08-14");
    expect(resolvePreviousGradeUpdate("2027-01-01").referencePeriod.label).toBe("2025년 2기 + 2026년 1기");
  });

  it("직전 기준기간 누적이 3억을 넘으면 현재 등급이 중소1이고, 같은 등급 안이면 OVER 가 아니다", () => {
    // 2026-05-10 은 직전(2025년 2기 + 2026년 1기)과 다음(2026년) 기준기간에 모두 든다
    const tracker = buildTaxableRevenueTracker([campaign({ endDate: kstNoon("2026-05-10"), actualSales: 352_000_000 })], NOW);
    expect(tracker.currentGradeEstimated).toBe(true);
    expect(tracker.previousGradeUpdate).toMatchObject({ updateYmd: "2026-08-14", cumulativeSupply: 320_000_000 });
    expect(tracker.currentGrade.label).toBe("중소1");
    expect(tracker.estimatedGrade.label).toBe("중소1");
    expect(tracker.status).toBe("WITHIN");
    expect(tracker.thresholdSupply).toBe(500_000_000);
    expect(tracker.headroomSupply).toBe(180_000_000);
    expect(tracker.crossingCost).toMatchObject({ kind: "IF_CROSSED" });
    expect(tracker.crossingCost?.from.label).toBe("중소1");
    expect(tracker.crossingCost?.to.label).toBe("중소2");
  });

  it("현재 등급보다 내려갈 추정이면 OVER 가 아니고 기준선은 추정 등급의 상한이다", () => {
    const tracker = buildTaxableRevenueTracker(
      [
        campaign({ endDate: kstNoon("2025-10-01"), actualSales: 352_000_000 }), // 직전 기준기간에만
        campaign({ actualSales: 110_000_000 }), // 다음 기준기간에만
      ],
      NOW,
    );
    expect(tracker.currentGrade.label).toBe("중소1");
    expect(tracker.estimatedGrade.label).toBe("영세");
    expect(tracker.status).toBe("WITHIN");
    expect(tracker.thresholdSupply).toBe(300_000_000);
  });

  it("직전 기준기간도 자사몰은 일수로 안분한다", () => {
    // 06-25~07-04(10일): 6일은 2026년 1기(직전 기준기간 끝), 4일은 2기
    const tracker = buildTaxableRevenueTracker(
      [campaign({ startDate: kstNoon("2026-06-25"), endDate: kstNoon("2026-07-04"), actualSales: 1_100_000_000 })],
      NOW,
    );
    expect(tracker.previousGradeUpdate.cumulativeSupply).toBe(600_000_000);
    expect(tracker.currentGrade.label).toBe("중소2");
    expect(tracker.cumulativeSupply).toBe(1_000_000_000);
    expect(tracker.estimatedGrade.label).toBe("중소2");
  });
});
