import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CampaignEditModal from "../shipping/modals/CampaignEditModal";

const fetchMock = vi.fn();

function jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: async () => payload,
  };
}

function campaign(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    name: "테스트 주문 캠페인",
    template: "brand",
    sellerName: "테스트 셀러",
    toEmail: "ops@example.com",
    ccEmail: "",
    tasks: [],
    mappings: [
      {
        id: "mapping-1",
        productName: "상품",
        optionName: "옵션",
        brandCode: "A1",
        price: 12000,
        campaignDealId: "deal-1",
      },
    ],
    salesCampaigns: [
      {
        id: "sales-1",
        campaignName: "판매 캠페인",
        campaignDeals: [{ id: "deal-1", deal: { dealName: "테스트 딜" } }],
      },
    ],
    ...overrides,
  } as any;
}

beforeEach(() => {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/order-converter/api/brands")) return jsonResponse({ brands: [] });
    if (url.includes("/recommended-deals")) return jsonResponse({ recommendations: {} });
    if (url.includes("/push-sales")) return jsonResponse({ success: true, pushedCampaigns: 1, pushedDeals: 1 });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CampaignEditModal sales push", () => {
  it("연결 매핑이 있으면 매출전송 버튼으로 API를 호출하고 결과를 표시한다", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CampaignEditModal campaign={campaign()} onClose={vi.fn()} onSubmit={onSubmit} />);

    const button = await screen.findByRole("button", { name: "매출전송" });
    const syncButton = await screen.findByRole("button", { name: "N스토어 동기화" });
    expect(button).toBeEnabled();
    expect(button.compareDocumentPosition(syncButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(button);

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith("order-1", expect.objectContaining({
        mappings: [expect.objectContaining({ campaignDealId: "deal-1", price: 12000 })],
      }));
      expect(fetchMock).toHaveBeenCalledWith("/order-converter/api/campaigns/order-1/push-sales", { method: "POST" });
    });
    expect(await screen.findByText("판매관리 1개 캠페인, 1개 딜에 반영했습니다.")).toBeInTheDocument();
  });

  it("매칭 0건 딜이 있으면 경고와 함께 제외 안내를 표시한다", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/order-converter/api/brands")) return jsonResponse({ brands: [] });
      if (url.includes("/recommended-deals")) return jsonResponse({ recommendations: {} });
      if (url.includes("/push-sales")) return jsonResponse({ success: true, pushedCampaigns: 1, pushedDeals: 0, unmatchedDeals: 1 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CampaignEditModal campaign={campaign()} onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.click(await screen.findByRole("button", { name: "매출전송" }));

    expect(await screen.findByText(/1개 딜은 매칭된 주문이 없어 제외/)).toBeInTheDocument();
  });

  it("현재 편집값 저장에 실패하면 판매관리 푸시 API를 호출하지 않는다", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error("저장 실패"));
    render(<CampaignEditModal campaign={campaign()} onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.click(await screen.findByRole("button", { name: "매출전송" }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock).not.toHaveBeenCalledWith("/order-converter/api/campaigns/order-1/push-sales", { method: "POST" });
    expect(await screen.findByText("저장 실패")).toBeInTheDocument();
  });

  it("연결 매핑이 없으면 매출전송 버튼을 비활성화한다", async () => {
    render(
      <CampaignEditModal
        campaign={campaign({
          mappings: [{ id: "mapping-1", productName: "상품", optionName: "옵션", price: 12000, campaignDealId: null }],
          salesCampaigns: [],
        })}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "매출전송" })).toBeDisabled();
  });
});

// 실사고 회귀(2026-07-19): 옵션가는 할인율 따라 스토어 실판매가로 저장되는데 딜 등록가와 다르면
// 가격일치(+50)를 못 받아 100점 자동채움 문턱에 미달 → 기간(3개월분)이 정확히 일치하는 유일한
// 딜인데도 "미지정"으로 남았다. 자동채움 ② 규칙(기간 정확일치 유일 후보)과 가격 확인 배지를 잠근다.
describe("CampaignEditModal 자동채움·가격 확인 배지", () => {
  function withRecs(recs: Record<string, unknown[]>) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/order-converter/api/brands")) return jsonResponse({ brands: [] });
      if (url.includes("/recommended-deals")) return jsonResponse({ recommendations: recs });
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  it("100점 미만이어도 기간 정확일치 후보가 유일하면 자동 선택하고, 가격 불일치 배지를 띄운다", async () => {
    withRecs({
      "mapping-1": [
        { id: "deal-3m", name: "딜 3개월분", score: 50, periodExact: true, dealPrice: 228800 },
      ],
    });
    render(
      <CampaignEditModal
        campaign={campaign({
          mappings: [{ id: "mapping-1", productName: "상품", optionName: "옵션 (3개월분)", price: 212200, campaignDealId: null }],
          salesCampaigns: [],
        })}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    // 자동채움 → 연결 매핑이 생겨 매출전송 버튼이 활성화된다
    await waitFor(async () => {
      expect(await screen.findByRole("button", { name: "매출전송" })).toBeEnabled();
    });
    // 가격 확인 배지 — 옵션가(스토어 실판매가) 212,200 vs 딜 등록가 228,800
    const badge = await screen.findByText(/가격 확인: 옵션 212,200 · 딜 228,800/);
    expect(badge).toBeInTheDocument();
    // ss-ux P1: 스크린리더가 select 포커스 시 경고를 듣도록 aria-describedby로 연결한다.
    const dealSelect = screen.getByDisplayValue(/딜 3개월분/);
    expect(dealSelect).toHaveAttribute("aria-describedby", badge.closest("p")!.id);
  });

  it("기간 정확일치 후보가 둘이면 자동 선택하지 않는다(오채움 방지)", async () => {
    withRecs({
      "mapping-1": [
        { id: "deal-3m-a", name: "딜 3개월분 1차", score: 50, periodExact: true, dealPrice: 228800 },
        { id: "deal-3m-b", name: "딜 3개월분 2차", score: 50, periodExact: true, dealPrice: 228800 },
      ],
    });
    render(
      <CampaignEditModal
        campaign={campaign({
          mappings: [{ id: "mapping-1", productName: "상품", optionName: "옵션 (3개월분)", price: 212200, campaignDealId: null }],
          salesCampaigns: [],
        })}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    // 자동채움이 일어나지 않아 연결 매핑 없음 → 매출전송 비활성 유지
    expect(await screen.findByRole("button", { name: "매출전송" })).toBeDisabled();
  });

  it("옵션가와 딜 등록가가 같으면 배지를 띄우지 않는다", async () => {
    withRecs({
      "mapping-1": [
        { id: "deal-1", name: "테스트 딜", score: 120, periodExact: false, dealPrice: 12000 },
      ],
    });
    render(
      <CampaignEditModal
        campaign={campaign({
          mappings: [{ id: "mapping-1", productName: "상품", optionName: "옵션", price: 12000, campaignDealId: "deal-1" }],
          salesCampaigns: [],
        })}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "매출전송" })).toBeEnabled();
    expect(screen.queryByText(/가격 확인/)).not.toBeInTheDocument();
  });
});
