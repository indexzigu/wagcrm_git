// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import type { CampaignRow } from "@/lib/crm-types";

// MarketPriceMonitor는 내부에서 fetch로 외부 마켓 가격을 조회하는 무거운 컴포넌트라
// props만 캡처하는 얕은 mock으로 대체한다 (C1-2 검증 대상은 searchQuery 파생 로직).
const marketPriceMonitorPropsSpy = vi.fn();
vi.mock("../market-price-monitor", () => ({
  MarketPriceMonitor: (props: unknown) => {
    marketPriceMonitorPropsSpy(props);
    return null;
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { CampaignDealsTable } from "../campaign-deals-table";

function buildCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
  return {
    id: "camp-1",
    dealId: "deal-main",
    sellerId: "seller-1",
    campaignName: "테스트 캠페인",
    dealName: "부모딜",
    partnerName: "파트너",
    sellerName: "셀러",
    snsType: "INSTAGRAM",
    snsHandle: "@seller",
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    salesChannel: "SMARTSTORE",
    baseNaverLink: "",
    generatedTrackingLink: "",
    actualSales: 0,
    totalMarginRate: 10,
    sellerMarginRate: 10,
    netMarginRate: 10,
    status: "ACTIVE",
    isManualMargin: false,
    assignedTo: null,
    followerHistory: [],
    activityHistory: [],
    notes: [],
    campaignDeals: [
      { id: "cd-1", campaignId: "camp-1", dealId: "deal-child-1", dealName: "부모딜 - 화이트", quantity: 1, actualSales: 0 },
    ],
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as CampaignRow;
}

describe("CampaignDealsTable — 자식 옵션 쿼리 파생 (C1-2)", () => {
  beforeEach(() => {
    marketPriceMonitorPropsSpy.mockReset();
  });

  it("자식 옵션의 searchQuery에 부모 접두어 제거 후 옵션토큰(화이트)이 포함된다", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/deals/deal-main") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "deal-main",
              dealName: "부모딜",
              brandName: "브랜드",
              unit: null,
              unitQuantity: null,
              supplementaryInfo: JSON.stringify({ searchKeyword: "브랜드 부모딜" }),
              sellingPrice: 10000,
              costPrice: 5000,
              totalCommissionRate: 10,
              options: [
                {
                  id: "deal-child-1",
                  dealName: "부모딜 - 화이트",
                  unit: "박스",
                  unitQuantity: 2,
                  supplementaryInfo: null,
                  costPrice: 5000,
                  sellingPrice: 10000,
                  totalCommissionRate: 10,
                },
              ],
            }),
        }) as unknown as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as unknown as Promise<Response>;
    });

    render(
      <CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={() => {}} />
    );

    await waitFor(() => {
      expect(marketPriceMonitorPropsSpy).toHaveBeenCalled();
    });

    const lastCall = marketPriceMonitorPropsSpy.mock.calls.at(-1)?.[0] as {
      items: Array<{ id: string; searchQuery: string }>;
    };
    const childItem = lastCall.items.find((item) => item.id === "deal-child-1");
    expect(childItem?.searchQuery).toBe("브랜드 부모딜 화이트 2박스");
  });

  it("자식 옵션 unit이 null이면 부모 unit으로 폴백해 수량토큰을 만든다", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/deals/deal-main") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "deal-main",
              dealName: "부모딜",
              brandName: "브랜드",
              unit: "박스",
              unitQuantity: null,
              supplementaryInfo: JSON.stringify({ searchKeyword: "브랜드 부모딜" }),
              sellingPrice: 10000,
              costPrice: 5000,
              totalCommissionRate: 10,
              options: [
                {
                  id: "deal-child-1",
                  dealName: "부모딜 - 3박스",
                  unit: null,
                  unitQuantity: null,
                  supplementaryInfo: null,
                  costPrice: 5000,
                  sellingPrice: 10000,
                  totalCommissionRate: 10,
                },
              ],
            }),
        }) as unknown as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as unknown as Promise<Response>;
    });

    render(
      <CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={() => {}} />
    );

    await waitFor(() => {
      expect(marketPriceMonitorPropsSpy).toHaveBeenCalled();
    });

    const lastCall = marketPriceMonitorPropsSpy.mock.calls.at(-1)?.[0] as {
      items: Array<{ id: string; searchQuery: string; unit?: string | null }>;
    };
    const childItem = lastCall.items.find((item) => item.id === "deal-child-1");
    // opt.unit이 null이므로 부모(data.unit="박스")로 폴백 → dealName에서 "3박스" 역추출 가능
    expect(childItem?.searchQuery).toBe("브랜드 부모딜 3박스");
  });

  it("[Major 4 회귀] unit에 정규식 특수문자가 섞여도 크래시 없이 처리된다 (inferQuantityFromName 재사용)", async () => {
    // 리뷰어 지적 케이스: campaign-deals-table.tsx:161의 `new RegExp(...${resolvedUnit})`은
    // resolvedUnit을 이스케이프하지 않아, unit="개[" 같은 값이 들어오면 정규식 파싱 자체가
    // 던진다("Unterminated character class"). query-builder의 inferQuantityFromName은 이미
    // escapeRegExp 처리가 되어 있으므로 이를 재사용하면 크래시 없이 안전하게 동작해야 한다.
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/deals/deal-main") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "deal-main",
              dealName: "부모딜",
              brandName: "브랜드",
              unit: null,
              unitQuantity: null,
              supplementaryInfo: JSON.stringify({ searchKeyword: "브랜드 부모딜" }),
              sellingPrice: 10000,
              costPrice: 5000,
              totalCommissionRate: 10,
              options: [
                {
                  id: "deal-child-1",
                  dealName: "부모딜 - 4개[",
                  unit: "개[",
                  unitQuantity: null,
                  supplementaryInfo: null,
                  costPrice: 5000,
                  sellingPrice: 10000,
                  totalCommissionRate: 10,
                },
              ],
            }),
        }) as unknown as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as unknown as Promise<Response>;
    });

    expect(() => {
      render(<CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={() => {}} />);
    }).not.toThrow();

    await waitFor(() => {
      expect(marketPriceMonitorPropsSpy).toHaveBeenCalled();
    });

    const lastCall = marketPriceMonitorPropsSpy.mock.calls.at(-1)?.[0] as {
      items: Array<{ id: string; searchQuery: string; expectedQuantity?: number | null }>;
    };
    const childItem = lastCall.items.find((item) => item.id === "deal-child-1");
    // 정규식 이스케이프가 정상 동작하면 "4개[" 리터럴에서 수량 4를 안전하게 역추출한다.
    expect(childItem?.expectedQuantity).toBe(4);
  });
});

describe("CampaignDealsTable — 하위 옵션 모델명 자식 우선 해소 (UX1-B)", () => {
  beforeEach(() => {
    marketPriceMonitorPropsSpy.mockReset();
  });

  it("자식 딜 자신의 modelName(JSON supplementaryInfo)이 있으면 부모 modelName보다 우선한다", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/deals/deal-main") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "deal-main",
              dealName: "부모딜",
              brandName: "브랜드",
              unit: null,
              unitQuantity: null,
              supplementaryInfo: JSON.stringify({
                searchKeyword: "브랜드 부모딜",
                modelName: "PARENT-MODEL",
              }),
              sellingPrice: 10000,
              costPrice: 5000,
              totalCommissionRate: 10,
              options: [
                {
                  id: "deal-child-1",
                  dealName: "부모딜 - 화이트",
                  unit: "박스",
                  unitQuantity: 2,
                  supplementaryInfo: JSON.stringify({
                    supplementaryInfo: "",
                    modelName: "CHILD-MODEL",
                  }),
                  costPrice: 5000,
                  sellingPrice: 10000,
                  totalCommissionRate: 10,
                },
              ],
            }),
        }) as unknown as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as unknown as Promise<Response>;
    });

    render(
      <CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={() => {}} />
    );

    await waitFor(() => {
      expect(marketPriceMonitorPropsSpy).toHaveBeenCalled();
    });

    const lastCall = marketPriceMonitorPropsSpy.mock.calls.at(-1)?.[0] as {
      items: Array<{ id: string; modelName?: string | null }>;
    };
    const childItem = lastCall.items.find((item) => item.id === "deal-child-1");
    expect(childItem?.modelName).toBe("CHILD-MODEL");
  });

  it("자식 딜에 modelName이 없으면 부모 modelName으로 폴백한다 (회귀 금지)", async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/deals/deal-main") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "deal-main",
              dealName: "부모딜",
              brandName: "브랜드",
              unit: null,
              unitQuantity: null,
              supplementaryInfo: JSON.stringify({
                searchKeyword: "브랜드 부모딜",
                modelName: "PARENT-MODEL",
              }),
              sellingPrice: 10000,
              costPrice: 5000,
              totalCommissionRate: 10,
              options: [
                {
                  id: "deal-child-1",
                  dealName: "부모딜 - 화이트",
                  unit: "박스",
                  unitQuantity: 2,
                  supplementaryInfo: null,
                  costPrice: 5000,
                  sellingPrice: 10000,
                  totalCommissionRate: 10,
                },
              ],
            }),
        }) as unknown as Promise<Response>;
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) }) as unknown as Promise<Response>;
    });

    render(
      <CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={() => {}} />
    );

    await waitFor(() => {
      expect(marketPriceMonitorPropsSpy).toHaveBeenCalled();
    });

    const lastCall = marketPriceMonitorPropsSpy.mock.calls.at(-1)?.[0] as {
      items: Array<{ id: string; modelName?: string | null }>;
    };
    const childItem = lastCall.items.find((item) => item.id === "deal-child-1");
    expect(childItem?.modelName).toBe("PARENT-MODEL");
  });
});

// 오너 지시 2026-08-28: ①헤더 제목이 좁은 폭에서 「매출 상 / 세 내역」으로 줄바꿈됐다
// ②「최종 정산 기준 데이터」 안내가 상시 표시라 자리를 계속 차지했다 → 눌러서 보는
// 방식으로 옮긴다(내용은 그대로 유지 — 정산 단계에서만 뜨는 안내라는 조건도 유지).
describe("CampaignDealsTable — 헤더 표기·안내 노출 방식", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
  });

  it("제목은 줄바꿈하지 않고, 품목 수 배지는 없다", async () => {
    // 오너 지시 2026-08-28(2차): 헤더가 한 줄에 들어가도록 「N개 품목」 배지를 뺀다 —
    // 품목 수는 바로 아래 표를 보면 알 수 있어 헤더 폭을 쓸 값이 아니다.
    const { getByText, queryByText } = render(
      <CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={vi.fn()} />,
    );
    const title = getByText("매출 상세 내역");
    expect(title.className).toContain("whitespace-nowrap");
    expect(queryByText(/개 품목/)).not.toBeInTheDocument();
  });

  it("옵션 품목 추가 셀렉트가 헤더 폭을 독차지하지 않는다", async () => {
    const { findByRole } = render(
      <CampaignDealsTable campaign={buildCampaign()} onCampaignUpdated={vi.fn()} />,
    );
    // 셀렉트는 가장 긴 옵션 이름만큼 늘어나 헤더를 밀어냈다 — 상한을 둔다.
    const select = await findByRole("combobox");
    expect(select.className).toMatch(/max-w-/);
  });

  it("정산 단계 안내는 상시 표시가 아니라 눌러서 본다", async () => {
    const { queryByText, getByRole } = render(
      <CampaignDealsTable
        campaign={buildCampaign({ status: "SETTLEMENT_IN_PROGRESS" })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    // 본문이 처음부터 깔려 있지 않다
    expect(queryByText(/스토어 자동 집계가 더 이상 반영되지 않습니다/)).not.toBeInTheDocument();
    // 대신 여는 장치가 있다
    expect(getByRole("button", { name: "최종 정산 기준 데이터 안내" })).toBeInTheDocument();
  });

  it("설명을 누르면 안내 본문이 나온다 — 내용이 사라진 게 아니라 자리를 옮긴 것", async () => {
    const { getByRole, findByText } = render(
      <CampaignDealsTable
        campaign={buildCampaign({ status: "SETTLEMENT_IN_PROGRESS" })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    fireEvent.click(getByRole("button", { name: "최종 정산 기준 데이터 안내" }));
    expect(await findByText(/스토어 자동 집계가 더 이상 반영되지 않습니다/)).toBeInTheDocument();
  });

  it("정산 단계가 아니면 안내 자체를 노출하지 않는다(기존 조건 유지)", async () => {
    const { queryByRole } = render(
      <CampaignDealsTable campaign={buildCampaign({ status: "ACTIVE" })} onCampaignUpdated={vi.fn()} />,
    );
    expect(queryByRole("button", { name: "최종 정산 기준 데이터 안내" })).not.toBeInTheDocument();
  });

  it("품목명 숫자를 자연 숫자순으로 표시한다", async () => {
    const { container, findByText } = render(
      <CampaignDealsTable
        campaign={buildCampaign({
          campaignDeals: [
            { id: "cd-10", campaignId: "camp-1", dealId: "deal-10", dealName: "토탈케어 - 10박스", quantity: 0, actualSales: 0 },
            { id: "cd-1", campaignId: "camp-1", dealId: "deal-1", dealName: "토탈케어 - 1박스", quantity: 0, actualSales: 0 },
            { id: "cd-2", campaignId: "camp-1", dealId: "deal-2", dealName: "토탈케어 - 2박스", quantity: 0, actualSales: 0 },
          ],
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );

    await findByText("토탈케어 - 1박스");

    const dealNames = Array.from(container.querySelectorAll("tbody tr"))
      .slice(0, 3)
      .map((row) => row.querySelector("td")?.textContent?.trim());
    expect(dealNames).toEqual([
      expect.stringContaining("토탈케어 - 1박스"),
      expect.stringContaining("토탈케어 - 2박스"),
      expect.stringContaining("토탈케어 - 10박스"),
    ]);
  });
});

// 영업이익(= 영업 수익 − 판매대행비)은 상쇄된 **판정값**이다. 종전엔 부호와 무관하게 무조건
// 초록이라 적자 품목도 초록으로 보였다. 품목 행마다 되풀이되는 표 열이라 profit-tone 의
// **밀집** 강도를 탄다 — 흑자·0 은 무색, 적자만 경고색. 합계 행은 표당 1개뿐인 결론 값이라
// **초점** 강도다 — 흑자 초록, 적자 경고색.
describe("CampaignDealsTable — 영업이익 판정색(밀집 강도)", () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
  });

  // 영업이익 열은 행의 6번째 칸이다(품목·수량·판매액·영업 수익·판매대행비·영업이익·관리).
  const GROSS_PROFIT_COL = 5;

  async function renderRows(
    deals: Array<{ id: string; name: string; sales: number; feeRate: number; sellerMarginRate: number }>,
  ) {
    const utils = render(
      <CampaignDealsTable
        campaign={buildCampaign({
          campaignDeals: deals.map((d) => ({
            id: d.id,
            campaignId: "camp-1",
            dealId: d.id,
            dealName: d.name,
            quantity: 1,
            actualSales: d.sales,
            feeRate: d.feeRate,
            sellerMarginRate: d.sellerMarginRate,
          })),
        })}
        onCampaignUpdated={vi.fn()}
      />,
    );
    await utils.findByText(deals[0].name);
    const rows = Array.from(utils.container.querySelectorAll("tbody tr"));
    return {
      cellOf: (name: string) => {
        const tr = rows.find((r) => r.querySelector("td")?.textContent?.includes(name));
        return tr?.querySelectorAll("td")[GROSS_PROFIT_COL] as HTMLElement;
      },
      totalsCell: () => rows.at(-1)?.querySelectorAll("td")[GROSS_PROFIT_COL] as HTMLElement,
    };
  }

  it("흑자 품목은 초록을 받지 않는다", async () => {
    // 10,000 × (20% − 10%) = +1,000
    const { cellOf } = await renderRows([{ id: "p", name: "흑자품목", sales: 10000, feeRate: 20, sellerMarginRate: 10 }]);
    const cell = cellOf("흑자품목");
    expect(cell.textContent).toBe("1,000");
    expect(cell.className).toContain("text-slate-700"); // 옆 칸(판매액·영업 수익)과 같은 본문색
    expect(cell.className).not.toContain("text-money-in-text");
    expect(cell.className).not.toContain("text-status-urgent-text");
  });

  it("0 은 손실이 아니므로 경고색을 띄우지 않는다", async () => {
    const { cellOf } = await renderRows([{ id: "z", name: "본전품목", sales: 10000, feeRate: 10, sellerMarginRate: 10 }]);
    const cell = cellOf("본전품목");
    expect(cell.textContent).toBe("0");
    expect(cell.className).not.toContain("text-status-urgent-text");
    expect(cell.className).not.toContain("text-money-in-text");
  });

  it("적자 품목은 경고색(status-urgent-text)을 받는다", async () => {
    // 10,000 × (5% − 10%) = −500
    const { cellOf } = await renderRows([{ id: "n", name: "적자품목", sales: 10000, feeRate: 5, sellerMarginRate: 10 }]);
    const cell = cellOf("적자품목");
    expect(cell.textContent).toBe("-500");
    expect(cell.className).toContain("text-status-urgent-text");
    expect(cell.className).not.toContain("text-slate-700"); // 본문색은 적자 톤에 밀려난다
  });

  it("합계 행은 합산 부호로 판정한다 — 흑자 합계는 초점 강도라 초록이다", async () => {
    // +1,000 + (−500) = +500 → 흑자(초점: money-in-text)
    const mixed = await renderRows([
      { id: "p", name: "흑자품목", sales: 10000, feeRate: 20, sellerMarginRate: 10 },
      { id: "n", name: "적자품목", sales: 10000, feeRate: 5, sellerMarginRate: 10 },
    ]);
    expect(mixed.totalsCell().textContent).toBe("500");
    expect(mixed.totalsCell().className).toContain("text-money-in-text");
    expect(mixed.totalsCell().className).not.toContain("text-status-urgent-text");
    // 품목 행은 여전히 밀집 — 흑자 품목은 무색
    expect(mixed.cellOf("흑자품목").className).not.toContain("text-money-in-text");
  });

  it("합계가 적자면 합계 칸도 경고색이다", async () => {
    const { totalsCell } = await renderRows([
      { id: "n", name: "적자품목", sales: 10000, feeRate: 5, sellerMarginRate: 10 },
    ]);
    expect(totalsCell().textContent).toBe("-500");
    expect(totalsCell().className).toContain("text-status-urgent-text");
    expect(totalsCell().className).not.toContain("text-money-in-text");
  });
});
