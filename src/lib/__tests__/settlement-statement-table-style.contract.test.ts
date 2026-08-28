/**
 * 명세서 품목 표의 **줄바꿈·정렬 계약** (T-024).
 *
 * 오너 신고: 품목명이 `샘플상품 - AB-123 그립형 20000` 같은 이름에서 `2000` / `0` 으로 **숫자
 * 한가운데** 잘렸다. 숫자가 갈라지면 셀러가 다른 모델로 읽을 수 있어 미관 문제가 아니다.
 *
 * 이 계약이 지키는 것은 세 가지다:
 *   ① 줄바꿈 규칙 — `break-all` 금지, `keep-all` + `overflow-wrap: anywhere`
 *   ② 정렬 축 — 헤더는 전부 가운데(오너 확정), 본문은 품목명 좌·수수료율 가운데·나머지 우
 *   ③ 개인·법인 **두 표가 같은 규칙**을 쓴다 — 이 파일이 반복해서 갈라진 지점이다(T-023)
 *
 * ⚠️ 값이 아니라 **출력 HTML** 을 본다. 스타일이 인라인이라(메일 클라이언트가 class 를
 * 떼어낸다) 상수만 검사하면 호출부가 상수를 안 쓰는 회귀를 놓친다.
 */
import { describe, expect, it } from "vitest";

import type { CampaignRow } from "@/lib/crm-types";
import { buildSettlementStatementHtml } from "@/lib/settlement-statement";

const deal = (id: string, dealName: string) => ({
  id,
  campaignId: "campaign-001",
  dealId: `deal-${id}`,
  dealName,
  quantity: 12,
  actualSales: 600_000,
  feeRate: 15,
  sellerMarginRate: 15,
  costPrice: 10_000,
  sellingPrice: 50_000,
});

function createCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "campaign-001",
    dealId: "deal-001",
    sellerId: "seller-001",
    campaignName: "샘플상품",
    dealName: "샘플상품",
    partnerName: "브랜드",
    sellerName: "샘플셀러",
    sellerCompanyName: "샘플 주식회사",
    sellerCompanyBusinessNumber: "0000000000",
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
      deal("cd-1", "샘플상품 - AB-123 그립형 20000"),
      deal("cd-2", "샘플상품 - AB-998 파우치"),
    ],
    ...overrides,
  } as CampaignRow;
}

/** 법인(부가세) 표와 개인(원천세) 표 — 두 표가 같은 규칙을 쓰는지 항상 함께 본다. */
const SURFACES: Array<[string, () => string]> = [
  ["법인 셀러 표", () => buildSettlementStatementHtml([createCampaign()], new Date("2026-08-10"))],
  [
    "개인 셀러 표",
    () =>
      buildSettlementStatementHtml(
        [createCampaign({ sellerCompanyName: null, sellerCompanyBusinessNumber: null })],
        new Date("2026-08-10"),
      ),
  ],
];

/**
 * 품목 표의 `<th>`·`<td>` 만 뽑는다.
 *
 * 🪤 `indexOf("품목명")` 으로 자르지 말 것 — 그 위치는 **품목명 `<th>` 태그 안**이라
 * 첫 헤더 셀이 통째로 잘려 나가고, 그러면 "0번 열이 가장 넓다" 같은 단언이 조용히
 * 판매가 열을 검사하게 된다(초판이 실제로 그랬다). 품목 표는 이 조각에서 유일하게
 * `<thead>` 를 가진 표이므로 그 지점을 앵커로 쓴다(상단 캠페인명·기간 표에는 없다).
 */
function itemTableCells(html: string) {
  const start = html.indexOf("<thead>");
  expect(start, "품목 표를 찾지 못했다 — 픽스처나 마크업이 바뀌었다").toBeGreaterThan(-1);
  const section = html.slice(start);
  return {
    // 🪤 `/<th[^>]*>/` 는 `<thead>` 도 문다(`<th` + `ead`). 태그 경계를 요구한다.
    heads: section.match(/<th(?=[\s>])[^>]*>/g) ?? [],
    names: section.match(/<td[^>]*>\[?샘플상품[^<]*<\/td>/g) ?? [],
    all: section,
  };
}

describe.each(SURFACES)("%s — 줄바꿈", (_label, build) => {
  it("품목명을 어절 단위로 넘긴다 (숫자 한가운데서 자르지 않는다)", () => {
    const { names } = itemTableCells(build());
    expect(names.length, "품목명 셀을 찾지 못했다").toBeGreaterThan(0);

    for (const cell of names) {
      expect(cell, "break-all 로 되돌아갔다 — 20000 이 2000/0 으로 갈라진다").not.toContain(
        "break-all",
      );
      expect(cell).toContain("word-break: keep-all");
    }
  });

  it("열보다 긴 토큰 하나는 최후수단으로 잘라 표 넘침을 막는다", () => {
    const { names } = itemTableCells(build());
    for (const cell of names) {
      expect(cell, "overflow-wrap 이 없으면 긴 SKU 하나가 표를 밀어낸다").toContain(
        "overflow-wrap: anywhere",
      );
    }
  });
});

describe.each(SURFACES)("%s — 정렬", (_label, build) => {
  it("헤더는 전 열 가운데 정렬이다 (오너 확정)", () => {
    const { heads } = itemTableCells(build());
    expect(heads).toHaveLength(8);
    for (const th of heads) {
      expect(th, "헤더가 본문 축을 따라가도록 되돌아갔다").toContain("text-align: center");
    }
  });

  it("금액·수량은 우측 정렬이다 (자릿수를 세로로 맞춰 소계와 대조한다)", () => {
    const { all } = itemTableCells(build());
    // 금액 셀에는 tabular-nums 가 함께 붙는다 — 그 조합을 한 덩어리로 본다.
    const numericCells = all.match(/<td style="[^"]*tabular-nums[^"]*"/g) ?? [];
    expect(numericCells.length, "숫자 셀을 찾지 못했다").toBeGreaterThan(0);
    for (const cell of numericCells) {
      expect(cell).toContain("text-align: right");
    }
  });

  it("수수료율 본문만 가운데 정렬이다", () => {
    const { all } = itemTableCells(build());
    const rateCells = all.match(/<td[^>]*>\d+(?:\.\d+)?%<\/td>/g) ?? [];
    expect(rateCells.length, "수수료율 셀을 찾지 못했다").toBeGreaterThan(0);
    for (const cell of rateCells) {
      expect(cell).toContain("text-align: center");
    }
  });

  it("상하 정렬을 렌더러 기본값에 맡기지 않는다", () => {
    const { heads, names } = itemTableCells(build());
    for (const cell of [...heads, ...names]) {
      expect(cell, "vertical-align 이 빠지면 메일 클라이언트마다 축이 갈린다").toContain(
        "vertical-align: middle",
      );
    }
  });
});

/**
 * 숫자 셀의 **좌우 패딩 합**은 콘텐츠 폭을 정한다 — 여기가 줄바꿈 사고의 입구다.
 *
 * 오너 신고(2026-08-19)를 「罫線 쪽 여백이 좁아서」로 오진하고 #424 가 오른쪽 여백을
 * 8→10px 로 벌렸다가, 오너 원본 PNG 실측에서 **증상이 그대로**임이 확인돼 원복했다
 * (진짜 원인은 자릿수 차이가 만드는 **왼쪽 끝** 들쭉날쭉함 — `STMT_NUM_CELL` 주석의
 * 실측표 참조). 여백 값은 8/8 로 돌아왔지만 **그때 발견한 함정은 그대로 유효하다.**
 *
 * **오른쪽만 늘리면** 열 너비가 퍼센트라 글자 자리가 그만큼 줄어든다. 공급가액 열의
 * 실측 여유는 6.60px 이고 정산금이 1천만 원대면 10자리 값이 들어와 0.35px 까지
 * 떨어진다 — 거기서 2px 를 더 먹으면 금액이 **두 줄로 갈라진다**(셀러에게 가는 문서라
 * 미관 문제가 아니다).
 *
 * 그래서 이 계약은 **좌우 합 16px**(= 콘텐츠 폭)를 못 박는다. 8/8 이든 6/10 이든
 * 합만 지키면 통과하므로, 여백 배분은 자유롭되 **콘텐츠 폭을 줄이는 변경만** 막힌다.
 */
describe.each(SURFACES)("%s — 숫자 셀 가로 여백", (_label, build) => {
  it("좌우 패딩 합 16px 를 유지한다 (콘텐츠 폭 불변 = 금액 줄바꿈 위험 0)", () => {
    const { all } = itemTableCells(build());
    const numericCells = all.match(/<td style="[^"]*tabular-nums[^"]*"/g) ?? [];
    expect(numericCells.length, "숫자 셀을 찾지 못했다").toBeGreaterThan(0);

    for (const cell of numericCells) {
      const padding = /padding: ([^;]+);/.exec(cell)?.[1];
      expect(padding, `숫자 셀에 padding 이 없다: ${cell}`).toBeDefined();

      // 🪤 CSS padding 축약은 **네 가지**다(1·2·3·4값). 초판은 4값과 2값만 다뤄
      // `padding: 8px`(1값, 소계 셀) 에서 `parts[1]` 이 undefined → 합이 NaN 이 됐다.
      // 표기를 바꾸는 것만으로 계약이 무너지면 안 되므로 넷 다 정규화한다.
      const parts = (padding as string).trim().split(/\s+/).map((v) => Number.parseFloat(v));
      expect(parts.length, `padding 값 개수가 1~4 가 아니다: ${padding}`).toBeGreaterThanOrEqual(1);
      expect(parts.length, `padding 값 개수가 1~4 가 아니다: ${padding}`).toBeLessThanOrEqual(4);
      expect(parts.every(Number.isFinite), `padding 을 숫자로 못 읽었다: ${padding}`).toBe(true);
      const right = parts.length === 1 ? parts[0] : parts[1];
      const left = parts.length === 4 ? parts[3] : right;

      expect(left + right, `좌우 합이 16px 를 벗어났다 — 금액이 두 줄로 갈라진다: ${padding}`).toBe(16);
      expect(
        right,
        `罫線 쪽 여백이 왼쪽보다 좁다 — 숫자가 세로선에 붙는다: ${padding}`,
      ).toBeGreaterThanOrEqual(left);
    }
  });
});

describe("두 표의 뼈대 동등성", () => {
  it("열 너비 합이 100% 이고 두 표가 같은 배분을 쓴다", () => {
    const widthsOf = (html: string) =>
      (itemTableCells(html).heads.map((th) => /width: (\d+)%/.exec(th)?.[1]).filter(Boolean) as string[]).map(
        Number,
      );

    const [business, individual] = SURFACES.map(([, build]) => widthsOf(build()));

    expect(business).toHaveLength(8);
    expect(business.reduce((sum, w) => sum + w, 0)).toBe(100);
    expect(individual, "개인 표만 다른 열 너비를 쓰면 두 명세서가 달라 보인다").toEqual(business);
  });

  it("품목명 열이 가장 넓다 (줄넘김이 애초에 안 생기게 하는 쪽)", () => {
    const widths = (itemTableCells(SURFACES[0][1]()).heads.map((th) =>
      Number(/width: (\d+)%/.exec(th)?.[1]),
    ));
    expect(Math.max(...widths)).toBe(widths[0]);
    expect(widths[0], "26% 시절로 되돌아가면 SKU 이름이 다시 두 줄이 된다").toBeGreaterThanOrEqual(30);
  });
});
