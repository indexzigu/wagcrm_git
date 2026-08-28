// 원천징수 신고 리포트 계약 (2026-07-23).
// 핵심 불변식: ① 캠페인별 금액은 정산 명세서와 같은 SSOT(computeIndividualWithholding)
// 를 쓴다 ② 소득세+지방소득세 분리는 실제 원천징수액(3.3%)의 합계를 보존한다
// ③ 지급완료일이 해당 월인 개인 셀러만 잡힌다.
import { describe, expect, it } from "vitest";
import type { CampaignRow } from "../crm-types";
import { calcIndividualIncomeTax, computeIndividualWithholding } from "../seller-tax-utils";
import {
  buildWithholdingReport,
  isValidReportMonth,
  maskResidentNumber,
  simplifiedStatementDueDate,
  withholdingDueDate,
} from "../withholding-report";

/** 리포트가 실제로 읽는 필드만 채운 최소 캠페인 픽스처 */
function makeCampaign(overrides: Partial<CampaignRow>): CampaignRow {
  return {
    id: "c1",
    dealId: "d1",
    sellerId: "s1",
    campaignName: "테스트딜 - 셀러A",
    dealName: "테스트딜",
    partnerName: "거래처",
    sellerName: "달콤한하루",
    sellerRealName: "김철수",
    sellerResidentNumber: "900101-1234567",
    sellerTaxType: "INDIVIDUAL",
    snsType: "INSTAGRAM",
    snsHandle: "handle",
    startDate: "2026-06-01",
    endDate: "2026-06-07",
    salesChannel: "NAVER",
    actualSales: 1_100_000,
    quantity: 10,
    totalMarginRate: 30,
    sellerMarginRate: 20,
    netMarginRate: 10,
    status: "SETTLED",
    isManualMargin: false,
    isPayoutCompleted: true,
    payoutCompletedAt: "2026-06-25",
    updatedAt: "2026-06-25",
    ...overrides,
  } as CampaignRow;
}

describe("buildWithholdingReport — 대상 선별", () => {
  it("지급완료일이 해당 월인 개인 셀러만 잡는다", () => {
    const report = buildWithholdingReport(
      [
        makeCampaign({ id: "in", payoutCompletedAt: "2026-06-25" }),
        makeCampaign({ id: "other-month", payoutCompletedAt: "2026-07-02" }),
        makeCampaign({ id: "no-date", payoutCompletedAt: null as unknown as string }),
        makeCampaign({
          id: "business",
          sellerId: "s2",
          sellerTaxType: "BUSINESS",
          sellerCompanyBusinessNumber: "123-45-67890",
        }),
      ],
      "2026-06",
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].lines.map((l) => l.campaignId)).toEqual(["in"]);
  });

  it("sellerTaxType 미지정이면 사업자번호 부재로 개인 판정한다(isIndividualSeller 위임)", () => {
    const report = buildWithholdingReport(
      [makeCampaign({ sellerTaxType: null, sellerCompanyBusinessNumber: null })],
      "2026-06",
    );
    expect(report.rows).toHaveLength(1);
  });

  it("지급액 0 라인은 신고 대상이 아니다", () => {
    const report = buildWithholdingReport([makeCampaign({ actualSales: 0 })], "2026-06");
    expect(report.rows).toHaveLength(0);
  });
});

describe("buildWithholdingReport — 금액 SSOT 일치", () => {
  it("캠페인 라인 금액이 명세서 SSOT(computeIndividualWithholding)와 동일하다", () => {
    const campaign = makeCampaign({});
    const expected = computeIndividualWithholding({
      deals: [{ actualSales: 1_100_000, sellerMarginRate: 20 }],
      campaignSellerMarginRate: 20,
      savedSellerExpense: null,
    });

    const report = buildWithholdingReport([campaign], "2026-06");
    const line = report.rows[0].lines[0];
    expect(line.preTaxPayout).toBe(expected.preTaxPayout);
    expect(line.withholdingTax).toBe(expected.withholdingTax);
    // 1,100,000 → 공급가 1,000,000 → 20% = 200,000 → 3.3% = 6,600
    expect(line.preTaxPayout).toBe(200_000);
    expect(line.withholdingTax).toBe(6_600);
  });

  it("sellerExpense 수동 조정값이 있으면 명세서처럼 그 값으로 대체된다", () => {
    const report = buildWithholdingReport(
      [makeCampaign({ sellerExpense: 150_000 })],
      "2026-06",
    );
    expect(report.rows[0].preTaxTotal).toBe(150_000);
    expect(report.rows[0].withholdingTotal).toBe(calcIndividualIncomeTax(150_000));
  });

  it("같은 셀러의 여러 캠페인은 한 행으로 합산된다", () => {
    const report = buildWithholdingReport(
      [
        makeCampaign({ id: "c1", payoutCompletedAt: "2026-06-10" }),
        makeCampaign({ id: "c2", payoutCompletedAt: "2026-06-25" }),
      ],
      "2026-06",
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].lines).toHaveLength(2);
    expect(report.rows[0].preTaxTotal).toBe(400_000);
    expect(report.totals.sellerCount).toBe(1);
  });
});

describe("buildWithholdingReport — 세액 분리(합계 보존)", () => {
  it("소득세 + 지방소득세 = 실제 원천징수액(3.3%) — 어떤 금액에서도 성립한다", () => {
    // 반올림 경계를 포함한 다양한 지급액으로 불변식 검사
    for (const preTax of [1, 10, 50, 333, 1_000, 12_345, 150_000, 199_999, 200_001]) {
      const report = buildWithholdingReport(
        [makeCampaign({ sellerExpense: preTax })],
        "2026-06",
      );
      const row = report.rows[0];
      expect(row.incomeTax + row.localIncomeTax).toBe(row.withholdingTotal);
      expect(row.incomeTax).toBe(Math.floor(preTax * 0.03));
      expect(row.localIncomeTax).toBeGreaterThanOrEqual(0);
      expect(row.postTaxTotal).toBe(row.preTaxTotal - row.withholdingTotal);
    }
  });

  it("극소액 다건 합산에서도 지방소득세가 음수가 되지 않는다 (code-reviewer 재현 케이스)", () => {
    // 딜별 3.3% 반올림이 0 으로 떨어지는 15원 지급이 같은 셀러에 20건 누적되면
    // withholdingTotal=0 인데 합산 3% 는 9원이라, 클램프가 없으면 지방소득세가 -9 가 된다.
    const campaigns = Array.from({ length: 20 }, (_, i) =>
      makeCampaign({ id: `tiny-${i}`, sellerExpense: 15 }),
    );
    const report = buildWithholdingReport(campaigns, "2026-06");
    const row = report.rows[0];
    expect(row.withholdingTotal).toBe(0);
    expect(row.incomeTax).toBe(0); // min(floor(300×0.03)=9, 0) → 0 으로 클램프
    expect(row.localIncomeTax).toBe(0);
    expect(row.incomeTax + row.localIncomeTax).toBe(row.withholdingTotal); // 합계 보존 유지
  });

  it("다중 캠페인 합산 경로에서도 분리 불변식이 성립한다", () => {
    const campaigns = [17, 33, 1_499, 12_345, 98_765].map((amount, i) =>
      makeCampaign({ id: `multi-${i}`, sellerExpense: amount }),
    );
    const report = buildWithholdingReport(campaigns, "2026-06");
    const row = report.rows[0];
    expect(row.incomeTax + row.localIncomeTax).toBe(row.withholdingTotal);
    expect(row.localIncomeTax).toBeGreaterThanOrEqual(0);
    expect(row.incomeTax).toBeGreaterThanOrEqual(0);
  });

  it("합계도 행 합과 일치한다", () => {
    const report = buildWithholdingReport(
      [
        makeCampaign({ id: "c1", sellerId: "s1", sellerExpense: 123_456 }),
        makeCampaign({ id: "c2", sellerId: "s2", sellerRealName: "이영희", sellerExpense: 654_321 }),
      ],
      "2026-06",
    );
    const sum = (pick: (r: (typeof report.rows)[number]) => number) =>
      report.rows.reduce((acc, row) => acc + pick(row), 0);
    expect(report.totals.preTaxTotal).toBe(sum((r) => r.preTaxTotal));
    expect(report.totals.withholdingTotal).toBe(sum((r) => r.withholdingTotal));
    expect(report.totals.incomeTax).toBe(sum((r) => r.incomeTax));
    expect(report.totals.localIncomeTax).toBe(sum((r) => r.localIncomeTax));
    expect(report.totals.sellerCount).toBe(2);
  });
});

describe("buildWithholdingReport — 신고 요건 경고", () => {
  it("주민등록번호 미등록 셀러가 있으면 경고를 싣는다", () => {
    const report = buildWithholdingReport(
      [makeCampaign({ sellerResidentNumber: null })],
      "2026-06",
    );
    expect(report.rows[0].residentNumber).toBeNull();
    expect(report.warnings.some((w) => w.includes("주민등록번호 미등록"))).toBe(true);
  });

  it("실명과 별칭을 분리해 싣는다 — 신고 표기는 실명이다", () => {
    const report = buildWithholdingReport([makeCampaign({})], "2026-06");
    expect(report.rows[0].sellerRealName).toBe("김철수");
    expect(report.rows[0].sellerAlias).toBe("달콤한하루");
  });

  // 2026-08-04: `Seller.name` 에는 실무상 활동명이 들어가 있어, 실명 미입력을 표기명으로
  // 메우면 활동명이 그대로 홈택스 소득자 성명이 된다. 폴백 금지가 이 기능의 핵심 계약이다.
  it("실명이 없으면 활동명으로 폴백하지 않고 null 로 두고 경고한다", () => {
    const report = buildWithholdingReport([makeCampaign({ sellerRealName: null })], "2026-06");

    expect(report.rows[0].sellerRealName).toBeNull();
    // 누가 미입력인지는 알아야 고치러 갈 수 있다 — 표기명은 보조 칸에 남는다.
    expect(report.rows[0].sellerAlias).toBe("달콤한하루");
    expect(report.warnings.some((w) => w.includes("실명 미등록"))).toBe(true);
  });

  it("실명 미등록 행이 섞여 있어도 정렬이 깨지지 않는다", () => {
    const report = buildWithholdingReport(
      [
        makeCampaign({ id: "c1", sellerId: "s1", sellerRealName: null, sellerName: "하하" }),
        makeCampaign({ id: "c2", sellerId: "s2", sellerRealName: "가가" }),
      ],
      "2026-06",
    );

    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((r) => r.sellerRealName)).toEqual(["가가", null]);
  });
});

describe("보조 함수", () => {
  it("isValidReportMonth — YYYY-MM 만 허용", () => {
    expect(isValidReportMonth("2026-06")).toBe(true);
    expect(isValidReportMonth("2026-13")).toBe(false);
    expect(isValidReportMonth("2026-6")).toBe(false);
    expect(isValidReportMonth("junk")).toBe(false);
  });

  it("maskResidentNumber — 생년월일+성별자리만 남긴다", () => {
    expect(maskResidentNumber("900101-1234567")).toBe("900101-1******");
    expect(maskResidentNumber("9001011234567")).toBe("900101-1******");
    expect(maskResidentNumber("900101")).toBe("90****");
  });

  it("신고 기한 — 다음 달 10일 / 간이지급명세서는 다음 달 말일(연말 넘어감 포함)", () => {
    expect(withholdingDueDate("2026-06")).toBe("2026-07-10");
    expect(withholdingDueDate("2026-12")).toBe("2027-01-10");
    expect(simplifiedStatementDueDate("2026-06")).toBe("2026-07-31");
    expect(simplifiedStatementDueDate("2026-01")).toBe("2026-02-28");
    expect(simplifiedStatementDueDate("2026-12")).toBe("2027-01-31");
  });
});
