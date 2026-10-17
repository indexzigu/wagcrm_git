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
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignSidePanel } from "../campaign-side-panel";
import { toast } from "sonner";
import { CAMPAIGN_FINANCIAL_STALE_MESSAGE } from "@/lib/campaign-patch";
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

/** 패널은 열 때 최신 행을 확인하는 동안 편집을 잠근다 — 열릴 때까지 기다린다. */
async function enabledEditButton() {
  const button = await screen.findByRole("button", { name: "편집" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

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

  // 오너 정정 2026-08-27: 「정산 기준액」은 **셀러지급액을 계산할 때 곱하는 매출액**을
  // 가리키는 말인데, 종전 화면은 그 자리에 셀러지급액(=곱한 결과)를 그대로 넣어 두 줄이
  // 같은 숫자였다. 기준은 세무 유형이 가른다(`getSellerPayoutBase`) — 개인은 공급가액,
  // 사업자는 총거래액이라, 종전 도움말 「총거래액 × 셀러수수료율」은 개인 셀러에게
  // 사실이 아니었다.
  it("정산 기준액은 셀러지급액이 아니라 그 계산의 기준 매출액이다 — 개인은 공급가액", () => {
    renderCard();
    const baseRow = screen.getByText("정산 기준액").closest("div.grid");
    expect(baseRow).toBeTruthy();
    // 38,900,000 ÷ 1.1 = 35,363,636 (개인 셀러 = 공급가액 기준)
    expect(baseRow!.textContent).toContain("35,363,636원");
    // ⛔ 셀러지급액(4,668,000)를 다시 보여주지 않는다 — 두 줄이 같은 숫자이던 것이 결함이었다.
    expect(baseRow!.textContent).not.toContain("4,668,000원");
    // 오너 지시 2026-08-28: 설명 서브텍스트는 줄 아래 상시 표시가 아니라 눌러서 본다.
    expect(baseRow!.textContent).not.toContain("공급가액");
    expect(baseRow!.textContent).not.toContain("총거래액 × 셀러수수료율");
    expect(screen.getByRole("button", { name: "정산 기준액 설명" })).toBeInTheDocument();
  });

  it("설명을 누르면 기준의 이름과 「고정」의 뜻이 나온다", async () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: "정산 기준액 설명" }));
    expect(await screen.findByText(/공급가액\(총거래액 ÷ 1\.1\)/)).toBeInTheDocument();
    expect(screen.getByText(/부가 항목 무관/)).toBeInTheDocument();
  });

  it("사업자 셀러의 기준 매출액은 총거래액이다", () => {
    renderCard({ sellerTaxType: "BUSINESS", sellerCompanyBusinessNumber: "123-45-67890" });
    const baseRow = screen.getByText("정산 기준액").closest("div.grid");
    expect(baseRow!.textContent).toContain("38,900,000원");
    // 기준의 이름(총거래액/공급가액)은 설명 팝업 안에 있고 줄에는 금액만 남는다.
    expect(baseRow!.textContent).not.toContain("총거래액");
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
    // 브랜드몰은 우리가 브랜드사에 청구서를 발행하고 수수료매출을 받는다.
    renderCard({ salesChannel: "BRAND_MALL", settlementItems: [] });
    expect(screen.getByText("브랜드사에서 받을 총액")).toBeInTheDocument();
    expect(screen.queryByText("브랜드사에 지급할 총액")).not.toBeInTheDocument();
  });

  it("영업이익 라벨 충돌이 해소됐다 — 중간값은 매출총이익이다", () => {
    renderCard();
    expect(screen.getByText("매출총이익")).toBeInTheDocument();
    // 「영업이익」은 상단 타일과 하단 합계 줄 둘뿐이고 같은 숫자다(2026-10-17 타일 이름 「영업이익 (자사 순수익)」
    // → 「영업이익」 통일). 같은 이름의 **다른** 숫자가 생기면 오독하니 개수를 고정한다.
    expect(screen.getAllByText("영업이익")).toHaveLength(2);
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

// 수동 정산 기준액(오너 확정 2026-10-06) — 읽기·편집 두 모드의 「정산 기준액」 줄.
// 오너 확정 2026-10-16: 「공제세액」은 세금 묶음의 이름이다. 자사 손익에서 빠지는 세금은
// 부가세 하나뿐이고(예수금을 걷어내는 줄이라 비용색이 아니다), 개인 셀러 원천세는 셀러 몫이라
// 차감 없이 참고 줄로만 보인다 — 셀러 구간의 원천세 줄과 같은 조건·같은 값.
// 설계 정본: docs/private/specs/2026-10-16-settlement-tax-split-design.md §4·§7 ②
describe("자사 손익 — 공제세액 묶음(부가세 차감 · 원천세 참고)", () => {
  function lineOf(label: string) {
    const row = screen.getByText(label).closest("div.grid");
    expect(row).toBeTruthy();
    return row as HTMLElement;
  }

  it("「공제세액 · 부가세」 줄은 비용색(money-out)이 아니라 회색이다", () => {
    renderCard({ taxExpense: 800_000 });
    const row = lineOf("공제세액 · 부가세");
    expect(row.className).toContain("text-slate-500");
    expect(row.querySelector(".text-money-out")).toBeNull();
    expect(row.textContent).toContain("800,000원");
  });

  it("개인 셀러면 「공제세액 · 원천세」 참고 줄이 뜨고 값은 셀러 구간 원천세와 같다", () => {
    renderCard();
    const row = lineOf("공제세액 · 원천세");
    expect(row.textContent).toContain("참고");
    expect(row.querySelector(".text-money-out")).toBeNull();
    const sellerZoneRow = lineOf("원천세 3.3% (셀러지급액 + 부가 항목 합산)");
    const amount = (el: HTMLElement) => el.textContent!.match(/[\d,]+원/)![0];
    expect(amount(row)).toBe(amount(sellerZoneRow));
  });

  it("사업자 셀러면 원천세 참고 줄이 없다", () => {
    renderCard({ sellerTaxType: "BUSINESS", sellerCompanyBusinessNumber: "123-45-67890" });
    expect(screen.getByText("공제세액 · 부가세")).toBeInTheDocument();
    expect(screen.queryByText("공제세액 · 원천세")).not.toBeInTheDocument();
  });

  it("편집 모드 라벨도 「공제세액 · 부가세」 다 — 옛 「제세공과금 (부가세 + 원천세)」은 없다", async () => {
    renderCard();
    fireEvent.click(await enabledEditButton());
    expect(screen.getByLabelText("공제세액 · 부가세")).toBeInTheDocument();
    expect(screen.queryByText(/제세공과금/)).not.toBeInTheDocument();
    expect(screen.queryByText(/부가세 \+ 원천세/)).not.toBeInTheDocument();
  });
});

describe("정산 기준액 — 자동/수동", () => {
  const MIXED_DEALS: CampaignRow["campaignDeals"] = [
    { id: "cd-1", campaignId: "camp-1", dealId: "d-1", dealName: "품목 A", quantity: 1, actualSales: 20_000_000, sellerMarginRate: 10 },
    { id: "cd-2", campaignId: "camp-1", dealId: "d-2", dealName: "품목 B", quantity: 1, actualSales: 18_900_000, sellerMarginRate: 15 },
  ];

  function modeButton(label: string, mode: "자동" | "수동") {
    const row = (screen.getByLabelText(label) as HTMLInputElement).closest("div.grid") as HTMLElement;
    return Array.from(row.querySelectorAll("button")).find((b) => b.textContent === mode)!;
  }

  it("읽기: 수동 기준액이면 그 값에 「수동」 태그, 설명은 직접 입력 문구다", async () => {
    renderCard({ sellerFeeBasisOverride: 30_000_000 });
    const baseRow = screen.getByText("정산 기준액").closest("div.grid");
    expect(baseRow!.textContent).toContain("30,000,000원");
    expect(screen.getByText("수동")).toBeInTheDocument();
    expect(screen.queryByText("고정")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "정산 기준액 설명" }));
    expect(
      await screen.findByText("직접 입력한 금액입니다. 셀러지급액은 이 금액 × 셀러수수료율로 계산됩니다."),
    ).toBeInTheDocument();
  });

  it("읽기: 저장된 기준액이 요율 혼합으로 적용되지 않으면 자동 기준 + 「고정」 + 안내 한 줄", () => {
    renderCard({ sellerFeeBasisOverride: 30_000_000, campaignDeals: MIXED_DEALS });
    const baseRow = screen.getByText("정산 기준액").closest("div.grid");
    expect(baseRow!.textContent).not.toContain("30,000,000원");
    expect(screen.getByText("고정")).toBeInTheDocument();
    expect(
      screen.getByText("품목별 수수료율이 달라져 이 기준액은 적용되지 않습니다. 자동으로 돌리거나 셀러지급액을 수동 입력하세요."),
    ).toBeInTheDocument();
  });

  it("편집: 자동이면 자동 기준액을 읽기 전용으로 보이고, 모드 버튼은 aria-pressed 로 상태를 말한다", async () => {
    renderCard();
    fireEvent.click(await enabledEditButton());
    const input = screen.getByLabelText("정산 기준액") as HTMLInputElement;
    // 개인 셀러 자동 기준 = 공급가액 round(38,900,000 / 1.1)
    expect(input.value).toBe(String(Math.round(38_900_000 / 1.1)));
    expect(input.readOnly).toBe(true);
    expect(modeButton("정산 기준액", "자동").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton("정산 기준액", "수동").getAttribute("aria-pressed")).toBe("false");
  });

  it("편집: 수동 기준액을 입력하면 셀러지급액·지급 총액·매출총이익·상단 타일이 바로 따라오고 곱셈 한 줄이 보인다", async () => {
    renderCard();
    fireEvent.click(await enabledEditButton());
    fireEvent.click(modeButton("정산 기준액", "수동"));
    fireEvent.change(screen.getByLabelText("정산 기준액"), { target: { value: "30000000" } });

    // 셀러지급액 = round(30,000,000 × 12%) = 3,600,000
    expect((screen.getByLabelText("셀러지급액") as HTMLInputElement).value).toBe("3600000");
    expect(screen.getByText(/셀러지급액 = 기준액 × 12% =\s*3,600,000원/)).toBeInTheDocument();
    // 매출총이익 = 수수료매출 8,947,000 − 3,600,000
    expect((screen.getByLabelText("매출총이익") as HTMLInputElement).value).toBe(String(8_947_000 - 3_600_000));
    // 셀러 지급 총액은 lib SSOT 계산 — 셀러지급액이 바뀌면 같이 바뀐다(원천세 합산 공제 후).
    const payout = Number((screen.getByLabelText("셀러 지급 총액") as HTMLInputElement).value);
    expect(payout).toBeLessThan(3_600_000 + 550_000);
    expect(payout).toBeGreaterThan(3_000_000);
    // 상단 타일
    expect(screen.getAllByText("3,600,000원").length).toBeGreaterThanOrEqual(1);
  });

  it("편집: 수동 칸을 비워도 수동·편집 가능이 유지되고, 무효 값이면 오류 문구로 저장을 막는다(F1·F3)", async () => {
    global.fetch = vi.fn();
    renderCard();
    // renderCard 가 fetch 를 덮으므로 렌더 뒤 감시용 목을 다시 건다.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    global.fetch = fetchSpy;
    fireEvent.click(await enabledEditButton());
    fireEvent.click(modeButton("정산 기준액", "수동"));
    const input = () => screen.getByLabelText("정산 기준액") as HTMLInputElement;
    fireEvent.change(input(), { target: { value: "" } });
    expect(modeButton("정산 기준액", "수동").getAttribute("aria-pressed")).toBe("true");
    expect(input().readOnly).toBe(false);
    expect(input().getAttribute("aria-invalid")).toBe("true");
    const error = screen.getByText("0 이상의 금액을 입력하세요");
    expect(input().getAttribute("aria-describedby")).toBe(error.id);

    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(fetchSpy).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: "-5" } });
    expect(screen.getByText("0 이상의 금액을 입력하세요")).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: "0" } });
    expect(screen.queryByText("0 이상의 금액을 입력하세요")).toBeNull();
    // 양성 대조: 유효해지면 저장이 실제로 요청된다(위 「미호출」이 목 고장이 아님을 확인).
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body ?? "{}"));
    expect(body.sellerFeeBasisOverride).toBe(0);
  });

  it("편집: 적용 중이던 기준액을 자동으로 되돌리면 셀러지급액 미리보기가 자동 기준액으로 바로 바뀐다(F2)", async () => {
    // 저장 셀러지급액 4,668,000 은 기준액 기반 값이라 자동으로 되돌리면 낡은 값이다.
    renderCard({ sellerFeeBasisOverride: 30_000_000 });
    fireEvent.click(await enabledEditButton());
    fireEvent.click(modeButton("정산 기준액", "자동"));
    // 자동 기준(개인 공급가액) round(38,900,000/1.1) × 12%
    expect((screen.getByLabelText("셀러지급액") as HTMLInputElement).value).toBe(
      String(Math.round((Math.round(38_900_000 / 1.1) * 12) / 100)),
    );
  });

  it("편집: 품목별 셀러수수료율이 다르면 「수동」은 aria-disabled + 이유 문단을 가리키고 클릭이 막힌다", async () => {
    renderCard({ campaignDeals: MIXED_DEALS });
    fireEvent.click(await enabledEditButton());
    const manual = modeButton("정산 기준액", "수동");
    expect(manual.getAttribute("aria-disabled")).toBe("true");
    expect(manual.hasAttribute("disabled")).toBe(false);
    const reason = document.getElementById(manual.getAttribute("aria-describedby")!);
    expect(reason?.textContent).toMatch(/품목마다 셀러수수료율이 달라 정산 기준액을 직접 입력할 수 없습니다/);
    fireEvent.click(manual);
    expect((screen.getByLabelText("정산 기준액") as HTMLInputElement).readOnly).toBe(true);
  });
});

// 열 때 재조회·낙관적 동시성(2026-10-13) — 부모가 넘긴 행은 페이지 캐시에서 와 옛 값일 수 있다. 패널은 열 때 한 건을
// 다시 읽고 그 전엔 재무 편집을 잠그며, 저장이 「값이 바뀜」 409 로 버려지면 최신 행으로 바꾼다.
describe("최신 값 확인 — 옛 화면이 편집 기준선이 되지 않는다", () => {
  type Handler = (url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
  function respond(status: number, body: unknown) {
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  }
  function renderWith(onCampaignUpdated = vi.fn()) {
    render(
      <CampaignSidePanel
        campaign={campaign}
        logs={[] as ApiCallLogRow[]}
        assets={[] as AssetRow[]}
        storage={storage}
        open
        settlementWorkspace
        onOpenChange={vi.fn()}
        onCampaignUpdated={onCampaignUpdated}
      />,
    );
    return onCampaignUpdated;
  }
  function installFetch(handler: Handler) {
    const spy = vi.fn((url: string, init?: RequestInit) => handler(String(url), init));
    global.fetch = spy as unknown as typeof fetch;
    return spy;
  }
  const isRowGet = (url: string, init?: RequestInit) =>
    url === `/api/campaigns/${campaign.id}` && (init?.method ?? "GET") === "GET";

  it("확인이 끝나기 전엔 편집이 잠기고, 서버 행이 다르면 그 행으로 바꾼 뒤 연다", async () => {
    let release!: () => void;
    const fresh = { ...campaign, updatedAt: "2026-08-02T00:00:00Z", miscExpense: 7_000 };
    installFetch((url, init) =>
      isRowGet(url, init)
        ? new Promise((resolve) => {
            release = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(fresh) });
          })
        : respond(200, { items: [] }),
    );
    renderWith();

    const pending = screen.getByRole("button", { name: "편집" });
    expect(pending).toBeDisabled();
    expect(pending.getAttribute("aria-busy")).toBe("true");
    release();
    expect(await enabledEditButton()).toBeEnabled();
  });

  it("서버 행이 화면과 같으면 갱신 통지를 보내지 않는다(열 때마다 리포트를 다시 읽지 않게)", async () => {
    installFetch((url, init) => (isRowGet(url, init) ? respond(200, { ...campaign, salesTask: null }) : respond(200, { items: [] })));
    const onCampaignUpdated = vi.fn();
    renderWith(onCampaignUpdated);
    await enabledEditButton();
    expect(onCampaignUpdated).not.toHaveBeenCalled();
  });

  it("서버 행이 다르면 갱신 통지로 흘려보낸다", async () => {
    const fresh = { ...campaign, updatedAt: "2026-08-02T00:00:00Z" };
    installFetch((url, init) => (isRowGet(url, init) ? respond(200, fresh) : respond(200, { items: [] })));
    const onCampaignUpdated = vi.fn();
    renderWith(onCampaignUpdated);
    await waitFor(() => expect(onCampaignUpdated).toHaveBeenCalledWith(fresh));
  });

  it("편집 도중 패널 행이 바뀌어도 기대값은 편집을 연 시점 값이다 — 그사이 바뀐 칸이 옛 초안으로 덮이지 않게", async () => {
    const spy = installFetch((url, init) =>
      isRowGet(url, init) ? respond(200, campaign) : init?.method === "PATCH" ? respond(200, campaign) : respond(200, { items: [] }),
    );
    const props = {
      logs: [] as ApiCallLogRow[],
      assets: [] as AssetRow[],
      storage,
      open: true,
      settlementWorkspace: true,
      onOpenChange: vi.fn(),
      onCampaignUpdated: vi.fn(),
    };
    const { rerender } = render(<CampaignSidePanel campaign={campaign} {...props} />);
    fireEvent.click(await enabledEditButton());
    // 편집 중 다른 섹션 저장 등으로 행이 갱신됐다(운영비가 바뀜).
    const before = Number(campaign.operatingExpense ?? 0);
    rerender(<CampaignSidePanel campaign={{ ...campaign, operatingExpense: before + 99_000 }} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(spy.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patchCall = spy.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const body = JSON.parse(String(patchCall[1]?.body));
    // 초안(편집 시작 값)이 새 행과 달라 운영비가 실린다 — 그 기대값은 편집 시작 값이라 서버가 409 로 막는다.
    expect(body.operatingExpense).toBe(before);
    expect(body.expectedFinancials.fields.operatingExpense).toBe(before);
  });

  it("저장이 「값이 바뀜」 409 면 기대값을 보냈고, 최신 행을 다시 읽어 바꾸고 편집을 닫는다", async () => {
    const fresh = { ...campaign, updatedAt: "2026-08-03T00:00:00Z", sellerFeeBasisOverride: 1_000 };
    let rowGets = 0;
    const spy = installFetch((url, init) => {
      if (isRowGet(url, init)) {
        rowGets += 1;
        return respond(200, rowGets === 1 ? campaign : fresh);
      }
      if (init?.method === "PATCH") return respond(409, { code: "CAMPAIGN_FINANCIAL_STALE", fields: ["sellerFeeBasisOverride"] });
      return respond(200, { items: [] });
    });
    const onCampaignUpdated = vi.fn();
    renderWith(onCampaignUpdated);

    fireEvent.click(await enabledEditButton());
    const row = (screen.getByLabelText("정산 기준액") as HTMLInputElement).closest("div.grid") as HTMLElement;
    fireEvent.click(Array.from(row.querySelectorAll("button")).find((b) => b.textContent === "수동")!);
    fireEvent.change(screen.getByLabelText("정산 기준액"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => expect(onCampaignUpdated).toHaveBeenCalledWith(fresh));
    const patchCall = spy.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const body = JSON.parse(String(patchCall[1]?.body));
    expect(body.expectedFinancials).toEqual({ fields: { sellerFeeBasisOverride: null } });
    expect(vi.mocked(toast.error).mock.calls.at(-1)?.[0]).toBe(CAMPAIGN_FINANCIAL_STALE_MESSAGE);
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
  });
});

describe("순수수료율 풀이", () => {
  it("title 속성이 아니라 키보드로도 열리는 설명 버튼으로 푼다", async () => {
    // 수수료율 칸은 정산 작업면이 아닌 일반 상세에서 그린다.
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ items: [] }) });
    render(
      <CampaignSidePanel
        campaign={campaign}
        logs={[] as ApiCallLogRow[]}
        assets={[] as AssetRow[]}
        storage={storage}
        open
        onOpenChange={vi.fn()}
        onCampaignUpdated={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button", { name: "순수수료율 풀이" });
    expect(screen.getByText("순수수료율 (%)").closest("[title]")).toBeNull();
    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("총수수료율 − 셀러수수료율. 셀러 몫을 뺀 우리 몫");
  });
});
