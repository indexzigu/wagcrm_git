// @vitest-environment jsdom
// 정산 정보 섹션 — 셀러/공급사 탭 계약 (2026-08-27, 오너 승인 설계).
//
// 종전 「셀러 정산 정보」 섹션에는 셀러 쪽 정산 신원만 있었고, 공급사(거래처)의
// 계좌·사업자 정보는 정산 화면 어디에도 없었다. 그래서 공급사 계좌가 미입력인 채로
// 남아 구글 캘린더 대금 이벤트에 "미등록"으로 나가고 있었다(입력 경로 부재).
// 이 테스트는 섹션이 「정산 정보」로 개편되어 [셀러]/[공급사] 탭을 갖고,
// 공급사 탭에서 계좌번호를 그 자리에서 입력(거래처 PATCH)할 수 있음을 고정한다.
//
// 방향 문구(발행/수취·지급/입금)는 `resolveCampaignInvoiceSlots`·
// `resolveCampaignMoneySlots`(tax-filing-board.ts, 오너 확정 의무표 파생)에서 온다 —
// 채널 분기를 화면이 다시 손으로 쓰면 의무표 정정 때 갈라진다(2026-08-07 선례).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CampaignSidePanel } from "../campaign-side-panel";
import type {
  ApiCallLogRow,
  AssetRow,
  CampaignRow,
  StorageSummary,
  SalesChannel,
} from "@/lib/crm-types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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

function makeCampaign(
  salesChannel: SalesChannel,
  overrides: Partial<CampaignRow> = {},
): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-1",
    sellerId: "seller-1",
    campaignName: "테스트 딜 테스트 셀러",
    salesCode: null,
    dealName: "테스트 딜",
    partnerName: "테스트 공급사",
    partnerId: "partner-1",
    partnerBusinessNumber: "555-66-77777",
    partnerCeoName: "공급대표",
    partnerEmail: "supplier@example.com",
    partnerBankAccount: "국민 110-123-456789",
    sellerName: "테스트 셀러",
    snsType: "INSTAGRAM",
    snsHandle: "@test_seller",
    startDate: "2026-01-01",
    endDate: "2026-06-30",
    salesChannel,
    baseNaverLink: "https://smartstore.naver.com/test",
    generatedTrackingLink: "https://link.test/abc",
    actualSales: 13_200_000,
    sellerExpense: 2_200_000,
    settlementSales: 6_600_000,
    totalMarginRate: 30,
    sellerMarginRate: 10,
    netMarginRate: 20,
    status: "SETTLEMENT_IN_PROGRESS",
    isManualMargin: false,
    assignedTo: null,
    updatedAt: "2026-05-01T00:00:00Z",
    followerHistory: [],
    activityHistory: [],
    notes: [],
    sellerTaxType: "BUSINESS",
    sellerCompanyName: "○○커머스",
    sellerCompanyCeoName: "대표A",
    sellerCompanyBusinessNumber: "123-45-67890",
    sellerCompanyBankAccount: "신한 987-654-321",
    ...overrides,
  } as CampaignRow;
}

const logs: ApiCallLogRow[] = [];
const assets: AssetRow[] = [];
const storage: StorageSummary = {
  supabaseLimitBytes: 1073741824,
  supabaseWarningBytes: 858993459,
  supabaseEstimatedBytes: 0,
  googleDriveConnected: false,
  recentAssets: [],
};

function renderPanel(campaign: CampaignRow, onCampaignUpdated = vi.fn()) {
  render(
    <CampaignSidePanel
      campaign={campaign}
      logs={logs}
      assets={assets}
      storage={storage}
      open
      onOpenChange={vi.fn()}
      onActualSalesSaved={vi.fn()}
      onCampaignUpdated={onCampaignUpdated}
      settlementWorkspace
    />,
  );
  return onCampaignUpdated;
}

/**
 * 「정산 정보」 섹션 스코프 — 방향 문구(예: "공급사 계산서 수취")는 아래
 * `SettlementSection` 회계 일정 카드에도 같은 SSOT 로 렌더되므로, 문서 전역
 * 매칭은 탭이 안 열려도 통과하는 거짓 초록이 된다. 반드시 이 섹션 안에서 찾는다.
 */
async function settlementInfoSection() {
  const heading = await screen.findByText("정산 정보");
  const section = heading.closest("section");
  if (!section) throw new Error("정산 정보 섹션을 찾지 못했습니다");
  return within(section as HTMLElement);
}

async function openSupplierTab() {
  const section = await settlementInfoSection();
  const tab = section.getByRole("tab", { name: "공급사" });
  // radix Tabs 트리거는 click 이 아니라 pointer/mouse down 으로 활성화된다.
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
  return section;
}

describe("정산 정보 섹션 — 셀러/공급사 탭", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/checklist")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }) as typeof fetch;
  });

  it("섹션 제목이 「정산 정보」이고 셀러/공급사 탭이 있으며 기본은 셀러 탭이다", async () => {
    renderPanel(makeCampaign("SELLER_MALL"));

    expect(await screen.findByText("정산 정보")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "셀러" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "공급사" })).toBeInTheDocument();
    // 기존 셀러 필드는 기본 탭에서 그대로 보인다
    expect(screen.getByText("정산 계좌")).toBeInTheDocument();
    expect(screen.getByText("신한 987-654-321")).toBeInTheDocument();
  });

  // 오너 지시 2026-08-27: 세무 유형을 「개인 원천징수」로 바꾸면 헤더에 「신고자료출력」
  // 버튼이 나타나는데, 그 등장·퇴장이 헤더 줄 높이를 바꿔 카드 전체가 출렁였다.
  // 처방은 조건부 렌더를 없애는 게 아니라 **자리를 예약**하는 것이다(P8 Layout Stability).
  it("헤더는 「신고자료출력」 버튼 유무와 무관하게 같은 높이를 예약한다", async () => {
    // 개인 원천징수 = 버튼 있음
    const { unmount } = render(
      <CampaignSidePanel
        campaign={makeCampaign("OWN_MALL", { sellerTaxType: "INDIVIDUAL", sellerCompanyBusinessNumber: null })}
        logs={logs}
        assets={assets}
        storage={storage}
        open
        onOpenChange={vi.fn()}
        onActualSalesSaved={vi.fn()}
        onCampaignUpdated={vi.fn()}
        settlementWorkspace
      />,
    );
    const withSection = await settlementInfoSection();
    expect(withSection.getByRole("button", { name: /신고자료출력/ })).toBeInTheDocument();
    const slotWith = document.querySelector('[data-slot="settlement-info-header-action"]')!;
    // 버튼 높이(h-8)를 슬롯이 그대로 예약한다. ⛔ 헤더의 `min-h-*` 로 대체하지 말 것 —
    // min-height 는 패딩·테두리를 포함해 버튼 높이를 예약하지 못한다(실측 12px 잔차).
    expect(slotWith.className).toContain("h-8");
    const slotClass = slotWith.className;
    unmount();

    // 사업자 + 우리몰 = 버튼 없음. 슬롯은 **빈 채로 남아** 같은 높이를 유지한다.
    renderPanel(makeCampaign("OWN_MALL", { sellerTaxType: "BUSINESS" }));
    const section = await settlementInfoSection();
    expect(section.queryByRole("button", { name: /신고자료출력/ })).not.toBeInTheDocument();
    const slotWithout = document.querySelector('[data-slot="settlement-info-header-action"]')!;
    expect(slotWithout).toBeTruthy();
    expect(slotWithout.className).toBe(slotClass);
  });

  it("공급사 탭에서 거래처 신원과 계좌번호를 보여준다", async () => {
    renderPanel(makeCampaign("SELLER_MALL"));
    const section = await openSupplierTab();

    await waitFor(() => {
      // 공급사명·대표자명은 셀러 탭의 「대행사명 / 대표자명」과 같은 결합 칸이다.
      expect(section.getByText("테스트 공급사 / 공급대표")).toBeInTheDocument();
    });
    expect(section.getByText("555-66-77777")).toBeInTheDocument();
    expect(section.getByText("supplier@example.com")).toBeInTheDocument();
    expect(section.getByText("국민 110-123-456789")).toBeInTheDocument();
  });

  // 오너 지시(2026-08-27): 방향 서브텍스트 제거. 같은 사실은 바로 아래 「정산 및 회계
  // 일정」 카드가 체크박스·날짜 칸으로 이미 말하고 있어(공급사 계산서 수취 / 지급 예정)
  // 이 자리의 한 줄은 중복이었다. ⚠️ 그래서 이 단언은 반드시 섹션 스코프여야 한다 —
  // 문서 전역으로 찾으면 아래 카드의 라벨에 걸려 영원히 실패한다.
  it("탭 안에 방향 서브텍스트를 넣지 않는다", async () => {
    renderPanel(makeCampaign("SELLER_MALL"));
    const section = await openSupplierTab();

    await waitFor(() => {
      expect(section.getByText("555-66-77777")).toBeInTheDocument();
    });
    expect(section.queryByText(/공급사 계산서 수취/)).not.toBeInTheDocument();
    expect(section.queryByText(/공급사 지급/)).not.toBeInTheDocument();

    fireEvent.mouseDown(section.getByRole("tab", { name: "셀러" }));
    await waitFor(() => {
      expect(section.getByText("세무 유형")).toBeInTheDocument();
    });
    expect(section.queryByText(/셀러 계산서/)).not.toBeInTheDocument();
  });

  // 탭을 오갈 때 섹션 높이가 흔들리지 않게 하는 **구조적** 장치를 고정한다: 두 탭이
  // 같은 그리드(2열 + 행 높이 명시)에 같은 개수(4)의 같은 모양 칸을 놓는다.
  // ⚠️ 이 단언은 "같은 골격"까지만 본다 — 실제 픽셀 일치는 jsdom 이 레이아웃을 계산하지
  // 않으므로 여기서 증명되지 않는다. 실렌더 계측이 짝 검증이다(PR 본문에 수치 기록).
  it("두 탭이 같은 2열 그리드에 같은 개수의 칸을 놓는다(높이 고정)", async () => {
    renderPanel(makeCampaign("SELLER_MALL"));
    const section = await settlementInfoSection();

    const sellerPanel = section.getByRole("tabpanel");
    expect(sellerPanel.className).toContain("grid-cols-2");
    // 행 높이를 내용에 맡기지 않는다(1fr 로 되돌리면 빈 상태에서 패널이 줄어든다).
    expect(sellerPanel.className).toMatch(/grid-rows-\[/);
    const sellerCells = sellerPanel.querySelectorAll('[data-slot="settlement-info-cell"]');
    expect(sellerCells).toHaveLength(4);

    await openSupplierTab();
    const supplierPanel = section.getByRole("tabpanel");
    // 두 패널의 클래스가 **문자열까지 같아야** 골격이 갈리지 않는다.
    expect(supplierPanel.className).toBe(sellerPanel.className);
    expect(supplierPanel.querySelectorAll('[data-slot="settlement-info-cell"]')).toHaveLength(
      sellerCells.length,
    );
  });

  it("공급사 계좌번호를 그 자리에서 저장하면 거래처 PATCH 로 가고 화면 상태도 갱신된다", async () => {
    const onCampaignUpdated = renderPanel(makeCampaign("SELLER_MALL"));
    const section = await openSupplierTab();

    const editButton = await section.findByRole("button", { name: "정산 계좌 수정" });
    fireEvent.click(editButton);

    const input = section.getByDisplayValue("국민 110-123-456789");
    fireEvent.change(input, { target: { value: "국민 220-987-654321" } });
    fireEvent.blur(input);

    await waitFor(() => {
      const patchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url, init]) =>
          String(url).includes("/api/partners/partner-1") &&
          (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(String((patchCall![1] as RequestInit).body));
      expect(body.bankAccount).toBe("국민 220-987-654321");
    });

    // 화면 상태(캠페인 행)도 새 계좌로 갱신돼 다른 소비처(캘린더 동기화 근거)와 어긋나지 않는다
    await waitFor(() => {
      expect(onCampaignUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ partnerBankAccount: "국민 220-987-654321" }),
      );
    });
  });

  it("연결된 거래처가 없으면 공급사 탭은 안내만 보여주고 편집 UI 를 그리지 않는다", async () => {
    renderPanel(
      makeCampaign("SELLER_MALL", {
        partnerId: null,
        partnerName: "거래처 없음",
        partnerBusinessNumber: null,
        partnerCeoName: null,
        partnerEmail: null,
        partnerBankAccount: null,
      }),
    );
    const section = await openSupplierTab();

    await waitFor(() => {
      expect(section.getByText(/연결된 거래처가 없습니다/)).toBeInTheDocument();
    });
    expect(section.queryByRole("button", { name: "정산 계좌 수정" })).not.toBeInTheDocument();
    // 빈 상태도 예약된 2행을 그대로 채운다 — 안 그러면 이 캠페인에서만 탭 전환 시 높이가 준다.
    const message = section.getByText(/연결된 거래처가 없습니다/);
    expect(message.className).toContain("col-span-2");
    expect(message.className).toContain("row-span-2");
  });
});
