// @vitest-environment jsdom
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

// 실사고 회귀: 주문관리 목록 응답(campaigns-handler)은 egress 절감으로 campaignDeals 를
// 요율 스칼라만 싣는다(`{ sellerMarginRate }` — `deal`·`id` 없음). 모달이 그 항목마다 딜 이름을
// 만들다 `undefined.parentDealId` 로 죽어 수정 창이 열리지 않았다. 딜 정보가 없는 항목은 건너뛴다.
describe("CampaignEditModal 연결 딜 정보가 없는 목록 응답", () => {
  it("campaignDeals 에 deal 이 없어도 수정 창이 열리고, 연결 딜 묶음은 만들지 않는다", async () => {
    render(
      <CampaignEditModal
        campaign={campaign({
          salesCampaigns: [{ id: "sales-1", campaignDeals: [{ sellerMarginRate: 0.1 }] }],
        })}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "매출전송" })).toBeInTheDocument();
    expect(document.querySelector('optgroup[label="연결된 캠페인"]')).toBeNull();
  });

  it("딜 정보가 있는 항목은 그대로 연결 딜 묶음에 이름으로 남는다", async () => {
    render(
      <CampaignEditModal
        campaign={campaign({
          salesCampaigns: [
            { id: "sales-1", campaignDeals: [{ sellerMarginRate: 0.1 }, { id: "deal-1", deal: { dealName: "테스트 딜" } }] },
          ],
        })}
        onClose={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const group = await waitFor(() => {
      const el = document.querySelector('optgroup[label="연결된 캠페인"]');
      expect(el).not.toBeNull();
      return el!;
    });
    const options = [...group.querySelectorAll("option")].map((o) => [o.getAttribute("value"), o.textContent]);
    expect(options).toEqual([["deal-1", "테스트 딜"]]);
  });
});

// 회귀(2026-10-16): 「N스토어 동기화」가 스토어 응답 행(상품코드 빈 값)으로 표를 통째로 바꿔
// 기존 매핑의 상품코드·단가가 지워졌다. 발주서 양식은 스토어 옵션 글자로 상품코드를 찾으므로
// 코드가 지워지면 발주서가 깨진다. 옵션명이 같은 줄은 상품코드·단가·딜 연결을 이어받고,
// 스토어에서 사라진 옵션은 지우지 않고 표에 남겨 표시한다(삭제는 운영자 판단).
describe("CampaignEditModal 스토어 옵션 다시 불러오기", () => {
  function storeFetch(rows: unknown[]) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/order-converter/api/brands")) return jsonResponse({ brands: [] });
      if (url.includes("/recommended-deals")) return jsonResponse({ recommendations: {} });
      if (url.endsWith("/order-converter/api/naver/products")) {
        return jsonResponse({
          success: true,
          products: [{ originProductNo: 900, channelProducts: [{ channelProductNo: 901, name: "테스트 주문 캠페인" }] }],
        });
      }
      if (url.includes("/naver/products/901/options")) return jsonResponse({ success: true, rows });
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  const existing = [
    { id: "m-a", productName: "상품", optionName: "구성: 1개월분", brandCode: "CODE-A", price: 12000, campaignDealId: "deal-1" },
    { id: "m-b", productName: "상품", optionName: "구성: 단종 옵션", brandCode: "CODE-B", price: 9000, campaignDealId: null },
  ];

  it("옵션명이 같은 줄은 상품코드·단가·딜 연결을 이어받고, 새 옵션만 빈 상품코드로 더한다", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    storeFetch([
      // 표기 흔들림(공백)이 있어도 같은 옵션으로 본다.
      { productName: "상품", optionName: "구성 : 1개월분", brandCode: "", price: 13000 },
      { productName: "상품", optionName: "구성: 3개월분", brandCode: "", price: 30000 },
    ]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CampaignEditModal campaign={campaign({ mappings: existing })} onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.click(await screen.findByRole("button", { name: "N스토어 동기화" }));

    await screen.findByDisplayValue("구성: 3개월분");
    expect(screen.getByDisplayValue("CODE-A")).toBeInTheDocument();
    expect(screen.getByDisplayValue("12000")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("13000")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "수정하기" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const mappings = onSubmit.mock.calls[0][1].mappings;
    expect(mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ optionName: "구성 : 1개월분", brandCode: "CODE-A", price: 12000, campaignDealId: "deal-1" }),
      expect.objectContaining({ optionName: "구성: 3개월분", brandCode: "", price: 30000, campaignDealId: null }),
    ]));
  });

  it("스토어에서 사라진 옵션은 지우지 않고 표에 남겨 표시한다", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    storeFetch([{ productName: "상품", optionName: "구성: 1개월분", brandCode: "", price: 12000 }]);
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<CampaignEditModal campaign={campaign({ mappings: existing })} onClose={vi.fn()} onSubmit={onSubmit} />);

    await user.click(await screen.findByRole("button", { name: "N스토어 동기화" }));

    expect(await screen.findByText("스토어에 없는 옵션")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CODE-B")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "수정하기" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][1].mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ optionName: "구성: 단종 옵션", brandCode: "CODE-B", price: 9000 }),
    ]));
    // 화면 표시용 값은 저장 데이터에 싣지 않는다.
    for (const m of onSubmit.mock.calls[0][1].mappings) expect(m).not.toHaveProperty("storeSyncNote");
  });

  it("같은 옵션 줄이 둘이면 첫 줄만 이어받고, 나머지는 지우지 않고 중복으로 표시한다", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    storeFetch([{ productName: "상품", optionName: "구성: 1개월분", brandCode: "", price: 12000 }]);
    const dup = [existing[0], { ...existing[0], id: "m-a2", brandCode: "CODE-A2" }];
    render(<CampaignEditModal campaign={campaign({ mappings: dup })} onClose={vi.fn()} onSubmit={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "N스토어 동기화" }));

    expect(await screen.findByText("중복 옵션")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CODE-A")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CODE-A2")).toBeInTheDocument();
    expect(screen.queryByText("스토어에 없는 옵션")).not.toBeInTheDocument();
  });
});
