// 정산 명세서 평문(클립보드 text/plain) 계약 — **셀러가 읽는 문서다.**
//
// 왜 이 파일이 있나: 정산 **상세 패널**이 자체 평문 빌더를 갖고 있다가 셀러에게 보내는
// 메일에 `■ 재무 정산 상세(영업이익·순이익)` + `■ 정산 수수료율(자사 순수수료율)` 을
// 실어보냈다. **정산 목록**은 셀러용 서식(총 거래액·차인지급액·원천세)이라 멀쩡했다 —
// 클립보드는 text/html 과 text/plain 을 함께 싣는데 HTML 은 양쪽이 같아서 눈에 안 띄었고,
// 오너가 *"목록은 정상인데 상세만 다르게 작동"* 으로 발견했다(2026-07-16).
//
// AGENTS.md P0 "Seller-Facing Data Exposure"(오너 확정): 셀러 표면에 내부 원가·마진을
// 어떤 형태로도 노출하지 않는다. **이건 취향이 아니라 금지다** — 그래서 눈이 아니라
// 테스트가 지킨다.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSettlementStatementText,
  computeSettlementPayoutTotals,
} from "@/lib/settlement-statement";
import type { CampaignRow } from "@/lib/crm-types";

const SRC = join(process.cwd(), "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

/** 법인 셀러 1건. 마진 필드에 일부러 눈에 띄는 값을 넣어 유출 시 단언이 잡게 한다. */
function makeCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: "테스트 캠페인",
    dealName: "테스트 딜",
    partnerName: "테스트 파트너",
    sellerName: "테스트 셀러",
    sellerCompanyName: "테스트 상사",
    sellerCompanyBusinessNumber: "123-45-67890",
    sellerCompanyCeoName: "홍길동",
    sellerCompanyAddress: "서울시 어딘가",
    snsType: "INSTAGRAM",
    snsHandle: "test_handle",
    status: "COMPLETED",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    actualSales: 10_000_000,
    settlementSales: 2_000_000,
    sellerExpense: 1_000_000,
    operatingExpense: 100_000,
    taxExpense: 50_000,
    miscExpense: 10_000,
    // 아래 3개가 셀러에게 새면 안 되는 값들 — 유일무이한 숫자로 심어둔다.
    operatingProfit: 840_000,
    totalMarginRate: 20,
    sellerMarginRate: 10,
    netMarginRate: 8.4,
    ...overrides,
  } as CampaignRow;
}

describe("평문 명세서 — 자사 마진이 셀러에게 새지 않는다 (P0)", () => {
  const text = buildSettlementStatementText([makeCampaign()], new Date("2026-02-01T00:00:00Z"));

  it("내부 전용 라벨이 하나도 없다", () => {
    for (const forbidden of [
      "영업이익",
      "순이익",
      "순 수수료",
      "수수료율",
      "영업 수익",
      "재무 정산 상세",
      "운영 비용",
    ]) {
      expect(text, `평문에 내부 라벨 "${forbidden}" 유출`).not.toContain(forbidden);
    }
  });

  it("내부 전용 수치가 하나도 없다", () => {
    // 심어둔 마진 값들이 어떤 서식으로도 안 나와야 한다.
    for (const forbidden of ["840,000", "8.4", "20%", "10%"]) {
      expect(text, `평문에 내부 수치 "${forbidden}" 유출`).not.toContain(forbidden);
    }
  });

  it("셀러가 알아야 할 것은 담는다 — 총 거래액과 차인지급액", () => {
    expect(text).toContain("[정산 명세서]");
    expect(text).toContain("정산 대상: 테스트 셀러");
    expect(text).toContain("발행일: 2026-02-01");
    expect(text).toContain("총 거래액: 10,000,000원");
    expect(text).toContain("차인지급액");
  });

  it("법인은 공급가액·부가세액으로 쪼개 보여준다", () => {
    expect(text).toContain("공급가액");
    expect(text).toContain("부가세액");
    expect(text).not.toContain("원천세");
  });

  it("개인 셀러는 원천세 3.3% 로 쪼개 보여준다", () => {
    // 사업자정보가 없으면 개인 — getRecipient 가 seller: 키로 떨어진다.
    const individual = buildSettlementStatementText([
      makeCampaign({
        sellerCompanyName: null,
        sellerCompanyBusinessNumber: null,
        sellerCompanyCeoName: null,
        sellerCompanyAddress: null,
      }),
    ]);
    expect(individual).toContain("원천세 3.3%");
    expect(individual).toContain("대행비 합계");
    expect(individual).not.toContain("부가세액");
  });

  it("수신자가 불명확하면 발행하지 않고 throw 한다 — HTML 빌더와 같은 계약", () => {
    const a = makeCampaign({ id: "a", sellerCompanyBusinessNumber: "111-11-11111" });
    const b = makeCampaign({ id: "b", sellerCompanyBusinessNumber: "222-22-22222" });
    expect(() => buildSettlementStatementText([a, b])).toThrow();
  });
});

describe("합계 — 확정값이 추정값을 이긴다", () => {
  it("sellerExpense 가 저장돼 있으면 그 값을 쓴다(딜별 역산 아님)", () => {
    const totals = computeSettlementPayoutTotals([makeCampaign({ sellerExpense: 1_000_000 })]);
    expect(totals.totalPreTaxPayout).toBe(1_000_000);
  });

  it("sellerExpense 가 없으면 딜별 sellerMarginRate 로 역산한다", () => {
    const totals = computeSettlementPayoutTotals([
      makeCampaign({ sellerExpense: null, sellerCompanyName: null, sellerCompanyBusinessNumber: null }),
    ]);
    expect(totals.totalPreTaxPayout).toBeGreaterThan(0);
  });

  it("법인은 원천세를 떼지 않는다 — 세전=세후", () => {
    const totals = computeSettlementPayoutTotals([makeCampaign({ sellerExpense: 1_000_000 })]);
    expect(totals.isIndividual).toBe(false);
    expect(totals.totalWithholdingTaxOnly).toBe(0);
    expect(totals.totalPostTaxPayout).toBe(totals.totalPreTaxPayout);
  });

  it("개인은 원천세만큼 세후가 작다", () => {
    const totals = computeSettlementPayoutTotals([
      makeCampaign({
        sellerExpense: 1_000_000,
        sellerCompanyName: null,
        sellerCompanyBusinessNumber: null,
      }),
    ]);
    expect(totals.isIndividual).toBe(true);
    expect(totals.totalWithholdingTaxOnly).toBeGreaterThan(0);
    expect(totals.totalPostTaxPayout).toBe(totals.totalPreTaxPayout - totals.totalWithholdingTaxOnly);
  });
});

describe("세 표면이 같은 빌더를 쓴다 — 갈라지면 또 새는 쪽이 생긴다", () => {
  const PANEL = read("components/crm/campaign-side-panel.tsx");
  // 2026-08-24: 명세서 액션은 정산 표 → **선택 액션 바**로 옮겼다(진행 중·완료 두 표가
  // 바 하나를 공유해야 해서다). 표면 좌표만 바뀌었고 "같은 빌더를 쓴다" 계약은 그대로다.
  const TABLE = read("components/crm/settlement-selection-bar.tsx");

  it("상세 패널은 자체 평문 빌더를 갖지 않는다", () => {
    // 이 파일 안에서 `function buildSettlementStatementText` 를 다시 정의하면 = 사고 재발.
    expect(PANEL).not.toMatch(/function\s+buildSettlementStatementText/);
    expect(PANEL).toContain('from "@/lib/settlement-statement"');
    expect(PANEL).toContain("buildSettlementStatementText([campaign])");
  });

  it("정산 목록도 같은 빌더를 쓴다", () => {
    expect(TABLE).not.toMatch(/function\s+buildSettlementStatementText/);
    expect(TABLE).toContain("buildSettlementStatementText(selectedCampaigns)");
  });

  it("화면이 세율을 직접 계산하지 않는다 — 계산은 lib 소관", () => {
    for (const source of [PANEL, TABLE]) {
      expect(source).not.toContain("calcIndividualIncomeTax");
      expect(source).not.toContain("calcBusinessVatBreakdown");
      expect(source).not.toContain("getSellerPayoutBase");
    }
  });

  // ── 이미지: 같은 사고의 세 번째 매체였다 ──────────────────────────────────
  //
  // ⚠️ 이 아래 단언은 **주석을 걸러야 한다.** 위 설명 주석들이 금지 심볼 이름
  // (`renderSettlementSummaryPng` 등)을 그대로 적고 있어서 raw 파일 매칭을 하면 자기
  // 주석에 걸린다(실제로 걸렸다). 그래서 코드 줄만 남기고 본다.
  const codeOnly = (source: string) =>
    source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");

  it("이미지도 정본 HTML 을 렌더해 찍는다 — 명세서를 손으로 다시 그리지 않는다", () => {
    // 상세 패널은 SVG 로 명세서를 재작성하고 있었고 그 SVG 가 내부 문서였다.
    expect(codeOnly(PANEL)).not.toMatch(/buildSettlementSummarySvg|renderSettlementSummaryPng/);
    expect(PANEL).toContain("renderSettlementStatementPng([campaign])");
    expect(TABLE).toContain("renderSettlementStatementPng(selectedCampaigns)");
  });

  it("화면 DOM 을 캡처하지 않는다 — 내부 패널을 찍으면 마진이 그대로 간다", () => {
    // `html2canvas(financialCardRef)` 로 되돌아가면 어떤 템플릿을 고쳐도 다시 샌다.
    // 캡처는 `lib` 안에서 **정본 HTML 을 오프스크린에 렌더한 컨테이너**에만 건다.
    for (const source of [PANEL, TABLE]) {
      expect(codeOnly(source)).not.toContain("html2canvas");
      expect(codeOnly(source)).not.toContain("financialCardRef");
    }
  });
});
