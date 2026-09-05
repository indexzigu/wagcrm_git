// @vitest-environment jsdom
/**
 * 재무 정산 카드의 **3구간 재편**(브랜드사 → 셀러 → 자사 손익)과 부가 항목 렌더를
 * 실제 컴포넌트로 고정한다.
 *
 * 소스 스캔 계약(`settlement-items.contract.test.ts`)은 "파생이 오염되지 않는다"를 보고,
 * 이 파일은 **오너가 실제로 보는 화면**이 그 값을 어디에 어떻게 놓는지를 본다 — 특히
 * 「기준 vs 총액」이 갈려 보이는지, 원천세가 합산 한 줄인지, 셀러 항목이 셀러 구간에만
 * 뜨는지.
 */

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CampaignSidePanel } from "../campaign-side-panel";
import type { ApiCallLogRow, AssetRow, CampaignRow, StorageSummary } from "@/lib/crm-types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

const storage: StorageSummary = {
  supabaseLimitBytes: 1073741824,
  supabaseWarningBytes: 858993459,
  supabaseEstimatedBytes: 0,
  googleDriveConnected: false,
  recentAssets: [],
};

/**
 * 우리몰 개인 셀러 — 물품대금을 브랜드사에 지급하고 셀러는 원천징수 대상이다.
 *
 * `CampaignRow` 로 직접 타이핑한다 — `as` 캐스팅으로 우회하면 필드명 오타나 타입
 * 어긋남이 조용히 통과해 픽스처가 실제 화면과 다른 모양이 된다.
 */
const campaign: CampaignRow = {
  id: "camp-1",
  dealId: "deal-1",
  sellerId: "seller-1",
  campaignName: "테스트 캠페인",
  dealName: "테스트 딜",
  partnerName: "테스트 거래처",
  sellerName: "테스트 셀러",
  snsType: "INSTAGRAM",
  snsHandle: "@x",
  startDate: "2026-07-01",
  endDate: "2026-07-07",
  salesChannel: "OWN_MALL",
  baseNaverLink: "",
  generatedTrackingLink: "",
  actualSales: 38_900_000,
  settlementSales: 8_947_000,
  sellerExpense: 4_668_000,
  settlementGoodsCost: 29_500_000,
  operatingExpense: 0,
  miscExpense: 0,
  taxExpense: 0,
  totalMarginRate: 23,
  sellerMarginRate: 12,
  netMarginRate: 11,
  status: "COMPLETED",
  isManualMargin: false,
  sellerTaxType: "INDIVIDUAL",
  assignedTo: null,
  updatedAt: "2026-08-01T00:00:00Z",
  followerHistory: [],
  activityHistory: [],
  notes: [],
  campaignDeals: [],
  settlementItems: [
    { id: "i1", invoiceMode: "PURCHASE_RECEIVE", counterparty: "BRAND", amount: 60_000, note: "반품배송비", sortOrder: 0 },
    { id: "i2", invoiceMode: "SALES_ISSUE", counterparty: "BRAND", amount: 550_000, note: "광고비", sortOrder: 1 },
    { id: "i3", invoiceMode: "NO_INVOICE", counterparty: "SELLER", amount: 550_000, note: "광고비", sortOrder: 2 },
    { id: "i4", invoiceMode: "NO_INVOICE", counterparty: "INTERNAL", amount: 60_000, note: "반품배송비 현금 수취", sortOrder: 3 },
  ],
};

function renderCard(overrides: Partial<CampaignRow> = {}) {
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ items: [] }) });
  return render(
    <CampaignSidePanel
      campaign={{ ...campaign, ...overrides }}
      logs={[] as ApiCallLogRow[]}
      assets={[] as AssetRow[]}
      storage={storage}
      open
      settlementWorkspace
      onOpenChange={vi.fn()}
      onCampaignUpdated={vi.fn()}
    />,
  );
}

describe("재무 카드 — 3구간 재편", () => {
  it("돈의 흐름 순서대로 세 구간 헤더가 있다", () => {
    renderCard();
    expect(screen.getByText("브랜드사 정산")).toBeInTheDocument();
    expect(screen.getByText("셀러 정산")).toBeInTheDocument();
    expect(screen.getByText("자사 손익")).toBeInTheDocument();
  });

  it("⛔ 계산서 발행·수취 상태를 이 카드에 넣지 않는다(오너 확정)", () => {
    // 「정산 및 회계 일정」 카드가 유일 표면이다 — 요약이라도 실으면 두 카드가 같은
    // 상태를 말하다 갈라진다.
    const { container } = renderCard();
    const financeCard = screen.getByText("재무 정산 내역").closest("section");
    expect(financeCard).toBeTruthy();
    expect(financeCard!.textContent).not.toContain("계산서 발행");
    expect(financeCard!.textContent).not.toContain("수취 확인");
    expect(container).toBeTruthy();
  });

  it("기준 vs 총액이 갈려 보인다 — 기준액은 「고정」 태그를 단다", () => {
    renderCard();
    expect(screen.getByText("정산 기준액")).toBeInTheDocument();
    expect(screen.getByText("고정")).toBeInTheDocument();
    expect(screen.getByText("셀러 지급 총액")).toBeInTheDocument();
  });

  // 오너 정정 2026-08-27: 「정산 기준액」은 **판매대행비를 계산할 때 곱하는 매출액**을
  // 가리키는 말인데, 종전 화면은 그 자리에 판매대행비(=곱한 결과)를 그대로 넣어 두 줄이
  // 같은 숫자였다. 기준은 세무 유형이 가른다(`getSellerPayoutBase`) — 개인은 공급가액,
  // 사업자는 총 거래액이라, 종전 도움말 「총 거래액 × 셀러수수료율」은 개인 셀러에게
  // 사실이 아니었다.
  it("정산 기준액은 판매대행비가 아니라 그 계산의 기준 매출액이다 — 개인은 공급가액", () => {
    renderCard();
    const baseRow = screen.getByText("정산 기준액").closest("div.grid");
    expect(baseRow).toBeTruthy();
    // 38,900,000 ÷ 1.1 = 35,363,636 (개인 셀러 = 공급가액 기준)
    expect(baseRow!.textContent).toContain("35,363,636원");
    // ⛔ 판매대행비(4,668,000)를 다시 보여주지 않는다 — 두 줄이 같은 숫자이던 것이 결함이었다.
    expect(baseRow!.textContent).not.toContain("4,668,000원");
    // 오너 지시 2026-08-28: 설명 서브텍스트는 줄 아래 상시 표시가 아니라 눌러서 본다.
    expect(baseRow!.textContent).not.toContain("공급가액");
    expect(baseRow!.textContent).not.toContain("총 거래액 × 셀러수수료율");
    expect(screen.getByRole("button", { name: "정산 기준액 설명" })).toBeInTheDocument();
  });

  it("설명을 누르면 기준의 이름과 「고정」의 뜻이 나온다", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "정산 기준액 설명" }));
    expect(await screen.findByText(/공급가액\(총 거래액 ÷ 1\.1\)/)).toBeInTheDocument();
    expect(screen.getByText(/부가 항목 무관/)).toBeInTheDocument();
  });

  it("사업자 셀러의 기준 매출액은 총 거래액이다", () => {
    renderCard({ sellerTaxType: "BUSINESS", sellerCompanyBusinessNumber: "123-45-67890" });
    const baseRow = screen.getByText("정산 기준액").closest("div.grid");
    expect(baseRow!.textContent).toContain("38,900,000원");
    // 기준의 이름(총 거래액/공급가액)은 설명 팝업 안에 있고 줄에는 금액만 남는다.
    expect(baseRow!.textContent).not.toContain("총 거래액");
  });

  // 오너 지시 2026-08-27: 「주고받을」은 방향을 뭉갠다 — 돈이 나가는지 들어오는지를
  // 라벨이 직접 말한다. 라벨은 **화면에 찍히는 금액의 부호**를 따른다(부호와 말이 어긋나면
  // 그 줄이 거짓말이 된다). 금액이 0이면 부호가 없으므로 채널이 정한 방향을 쓴다.
  it("브랜드사 총액은 방향을 라벨로 말한다 — 우리몰은 지급", () => {
    renderCard();
    expect(screen.getByText("브랜드사에 지급할 총액")).toBeInTheDocument();
    expect(screen.queryByText("브랜드사와 주고받을 총액")).not.toBeInTheDocument();
  });

  it("브랜드몰은 받는 쪽이라 라벨이 뒤집힌다", () => {
    // 브랜드몰은 우리가 브랜드사에 청구서를 발행하고 영업수익을 받는다.
    renderCard({ salesChannel: "BRAND_MALL", settlementItems: [] });
    expect(screen.getByText("브랜드사에서 받을 총액")).toBeInTheDocument();
    expect(screen.queryByText("브랜드사에 지급할 총액")).not.toBeInTheDocument();
  });

  it("영업이익 라벨 충돌이 해소됐다 — 중간값은 매출총이익이다", () => {
    renderCard();
    expect(screen.getByText("매출총이익")).toBeInTheDocument();
    // 최종 영업이익은 그대로 하나만 남는다(같은 이름의 다른 숫자가 둘이면 오독한다).
    expect(screen.getAllByText("영업이익")).toHaveLength(1);
  });
});

describe("부가 항목 — 대상이 곧 구간이다", () => {
  it("비고가 행 라벨이고 서브텍스트를 만들지 않는다(오너 9차)", () => {
    renderCard();
    // 브랜드사 반품배송비 · 셀러 광고비 · 자사 현금 수취가 각자 자기 구간에 뜬다.
    expect(screen.getAllByText("광고비").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("반품배송비 현금 수취")).toBeInTheDocument();
    // 「브랜드사 · 매입계산서 수취」 같은 서브텍스트는 폐기됐다.
    expect(screen.queryByText(/매입계산서 수취/)).toBeNull();
  });

  it("부호가 방향을 말한다 — 지급은 −, 수취는 +", () => {
    renderCard();
    expect(screen.getAllByText("-60,000원").length).toBeGreaterThanOrEqual(1); // 브랜드사에 낼 반품배송비
    expect(screen.getByText("+60,000원")).toBeInTheDocument(); // 자사 잡이익(현금 수취)
  });

  it("원천세는 대행비 + 부가 항목을 합산해 한 줄로 공제한다", () => {
    renderCard();
    // (4,668,000 + 550,000) × 3.3% = 172,194
    expect(screen.getByText(/원천세 3\.3%/)).toBeInTheDocument();
    expect(screen.getByText("-172,194원")).toBeInTheDocument();
  });

  it("⛔ 물품대금 3-상태 — 행과 총액이 갈리지 않는다(교차 검증에서 잡힌 회귀)", () => {
    // 종전엔 이 화면이 3-상태 판정을 손으로 다시 구현해 `0`(합산 이관)을 `null`(미입력)과
    // 같이 취급했다. 그 결과 항목 행은 「합산 이관」이라고 말하는데 **포커스 총액**은
    // 공식 추정치를 확정값처럼 보여줬다 — 이 PR 이 없애려던 이중 기준의 재발이었다.
    const { unmount } = renderCard({ settlementGoodsCost: 0 });
    expect(screen.getByText("합산 이관 (계산서 없음)")).toBeInTheDocument();
    // 합산 이관이면 낼 물품대금이 없다 → 총액은 부가 항목 합(−60,000 + 550,000)뿐.
    expect(screen.getByText("+490,000원")).toBeInTheDocument();
    // 확정 상태이므로 「추정 포함」 힌트를 붙이지 않는다.
    expect(screen.queryByText("추정 포함")).toBeNull();
    unmount();

    // 미입력(null)이면 공식 추정이고, 그 사실을 라벨·힌트로 밝힌다.
    renderCard({ settlementGoodsCost: null });
    expect(screen.getByText("물품대금 (추정)")).toBeInTheDocument();
    expect(screen.getByText("추정 포함")).toBeInTheDocument();
  });

  it("자사 손익에 매입 부대비용 참조 1줄이 뜬다(A안) — 조정 후 손익의 출처", () => {
    renderCard();
    expect(screen.getByText("매입 부대비용 (브랜드사 정산 참조)")).toBeInTheDocument();
    // 반품배송비 −60,000 과 잡이익 +60,000 이 상계돼 조정 후 손익은 영업이익과 같다.
    expect(screen.getByText(/부가 항목 반영 후/)).toBeInTheDocument();
  });
});
