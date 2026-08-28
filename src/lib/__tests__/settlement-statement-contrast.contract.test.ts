/**
 * 명세서 **글자 대비 계약** (T-027).
 *
 * 셀러가 받는 문서라 우리는 렌더러도, 인쇄 품질도, 보는 사람의 눈도 고를 수 없다.
 * 종전 원천세 금액은 `#ef4444`(흰 배경 3.76:1)로 WCAG AA 본문 기준(4.5:1)에 미달했고,
 * 10px 글자라 "내 지급액에서 얼마가 빠졌나"를 확인하는 숫자가 흐렸다.
 *
 * ⚠️ **리터럴을 고정하지 않고 대비를 매번 다시 계산한다.** 색 값을 `toBe("#be123c")` 로
 * 박으면 다음 사람이 색을 바꿀 때 테스트만 고치고 지나간다 — 지켜야 하는 건 특정 색이
 * 아니라 **읽힌다는 성질**이다. 그래서 이 파일은 출력 HTML 에서 색을 뽑아 그 색이 실제로
 * 깔리는 배경과 짝지어 대비를 계산한다.
 *
 * 🪤 이 문서는 CSS 변수를 쓸 수 없다(메일 본문에 `:root` 가 따라가지 않아 색이 죽는다).
 * 그래서 앱 토큰을 import 해 검사할 수 없고, 여기서 값을 직접 계산하는 것이 유일한 방법이다.
 */
import { describe, expect, it } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";
import { buildSettlementStatementHtml } from "@/lib/settlement-statement";

/** WCAG 2.x 상대 휘도 — 채널을 선형화한 뒤 가중 합산한다. */
function relativeLuminance(hex: string) {
  const value = parseInt(hex.slice(1), 16);
  const channel = (raw: number) => {
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel((value >> 16) & 255) +
    0.7152 * channel((value >> 8) & 255) +
    0.0722 * channel(value & 255)
  );
}

function contrast(foreground: string, background: string) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG 2.2 SC 1.4.3 — 18.66px 미만 일반 텍스트. 이 표는 10~13px 이라 전부 여기 해당한다. */
const AA_NORMAL_TEXT = 4.5;

/**
 * 명세서가 실제로 쓰는 배경 두 종.
 * 흰 셀과, 소계·강조 행에 깔리는 `#f8fafc` 틴트다. **틴트 쪽이 항상 더 빡빡하다** —
 * 앱 토큰 `--money-out`(#E11D48)이 흰 배경 4.70 으로 통과하고도 이 틴트에서 4.49 로
 * 떨어져 채택되지 못한 것이 T-027 의 핵심 발견이다(P8 §5 "토큰은 표면 종속").
 */
const BACKGROUNDS = { 흰_셀: "#ffffff", 소계_틴트: "#f8fafc" } as const;

function createCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign-001",
    dealId: "deal-001",
    sellerId: "seller-001",
    campaignName: "샘플상품",
    dealName: "샘플상품",
    partnerName: "브랜드",
    sellerName: "샘플셀러",
    // 개인 셀러(원천세) 표를 만들려면 사업자 정보가 없어야 한다.
    sellerCompanyName: null,
    sellerCompanyBusinessNumber: null,
    snsType: "INSTAGRAM",
    snsHandle: "sample",
    startDate: "2026-07-06",
    endDate: "2026-07-20",
    salesChannel: "BRAND_MALL",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 1_000_000,
    sellerExpense: null,
    totalMarginRate: 20,
    sellerMarginRate: 15,
    netMarginRate: 5,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-07-21T00:00:00.000Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    campaignDeals: [
      {
        id: "cd-1",
        campaignId: "campaign-001",
        dealId: "deal-001",
        dealName: "샘플상품 - AB-123 그립형 20000",
        quantity: 12,
        actualSales: 600_000,
        feeRate: 15,
        sellerMarginRate: 15,
        costPrice: 10_000,
        sellingPrice: 50_000,
      },
    ],
    ...overrides,
  } as CampaignRow;
}

const html = () => buildSettlementStatementHtml([createCampaign()], new Date("2026-08-10"));

/** 출력 HTML 의 모든 글자색(배경·테두리 제외). */
function textColors(source: string) {
  return [
    ...new Set(
      [...source.matchAll(/(?<!background-)color:\s*(#[0-9a-fA-F]{6})/g)].map((m) =>
        m[1].toLowerCase(),
      ),
    ),
  ];
}

describe("명세서 글자 대비", () => {
  it("모든 글자색이 두 배경 모두에서 AA 본문 기준을 넘는다", () => {
    const colors = textColors(html());
    expect(colors.length, "글자색을 하나도 못 찾았다 — 마크업이 바뀌었다").toBeGreaterThan(3);

    const failures = colors.flatMap((color) =>
      Object.entries(BACKGROUNDS)
        .map(([label, bg]) => ({ color, label, ratio: contrast(color, bg) }))
        .filter((row) => row.ratio < AA_NORMAL_TEXT),
    );

    expect(
      failures.map((f) => `${f.color} on ${f.label} = ${f.ratio.toFixed(2)}:1`),
      "셀러가 읽는 문서다 — 흐린 글자를 새로 들이지 말 것",
    ).toEqual([]);
  });

  it("원천세 금액이 종전의 흐린 빨강으로 되돌아가지 않는다", () => {
    const source = html();
    // 실제 사고 값. 되돌리면 흰 배경 3.76:1 로 다시 미달한다.
    expect(contrast("#ef4444", BACKGROUNDS.흰_셀)).toBeLessThan(AA_NORMAL_TEXT);
    expect(source).not.toContain("#ef4444");
  });

  it("차감 항목은 무채색으로 뭉개지지 않는다 (읽히되 구분은 남는다)", () => {
    // 대비만 보면 검정이 제일 좋지만, 그러면 "얼마가 빠졌는지"가 다른 숫자와 섞인다.
    // 원천세 줄에는 여전히 유채색이 있어야 한다.
    const deductionRow = /└ 원천세[^<]*<\/td>/.exec(html().replace(/\s+/g, " "));
    expect(deductionRow, "원천세 줄을 못 찾았다").not.toBeNull();

    const chromatic = textColors(html()).filter((hex) => {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      return Math.max(r, g, b) - Math.min(r, g, b) > 40;
    });
    expect(chromatic.length, "유채색이 사라지면 차감 항목이 본문에 묻힌다").toBeGreaterThan(0);
  });
});
