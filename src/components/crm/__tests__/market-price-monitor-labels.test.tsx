// @vitest-environment jsdom
// Owner "same product / different product" labels in the price modal (2026-11-13 three-axis split).
// The modal keeps raw candidates and re-derives the verdict at render, so a label must change the
// verdict immediately and the POST must carry the system judgment made *before* the label.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MarketPriceMonitor } from "../market-price-monitor";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const CANDIDATES = [
  // cheaper, same brand, weak product match -> REVIEW until the owner rules on it
  { channel: "naver", mall: "어떤몰", productName: "비비랩 레몬 듀얼 스틱 2박스", price: 35000, shippingFee: 0, totalPrice: 35000, url: "https://example.com/b" },
  // another company's product sharing product words -> excluded by the brand axis
  { channel: "naver", mall: "메디트리", productName: "순 유기농 올레샷 올리브 오일 레몬즙 2박스", price: 25900, shippingFee: 0, totalPrice: 25900, url: "https://example.com/a" },
  // same product words but no brand/company name anywhere -> excluded, flagged as a possible missing company name
  { channel: "naver", mall: "정체몰", productName: "유기농 올리브레몬 듀얼 올레샷 2박스", price: 30000, shippingFee: 0, totalPrice: 30000, url: "https://example.com/n" },
  // same product, priced above ours
  { channel: "naver", mall: "비비랩공식", productName: "비비랩 유기농 올리브 엔 레몬 듀얼샷 올레샷 2박스", price: 41000, shippingFee: 0, totalPrice: 41000, url: "https://example.com/d" },
];

function mockFetch(companies: Record<string, string | null> = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
    if (url.startsWith("/api/price-monitoring/labels") && method === "GET") {
      return json({
        roots: { opt: "root" },
        labels: { root: [] },
        aliases: { root: [] },
        companies,
        accuracy: {
          total: 4,
          agreed: 3,
          causes: [{ cause: "SHARED_WORDS", label: "같은 회사의 다른 상품(검색어 낱말 공유)", count: 1, examples: ["비비랩 레몬 듀얼 스틱"] }],
          differentWords: [{ word: "스틱", count: 1 }],
        },
      });
    }
    if (url === "/api/price-monitoring/labels" && method === "POST") {
      return json({ rootDealId: "root", nameKey: "어떤몰|비비랩레몬듀얼스틱2박스", reevaluateError: null, accuracy: { total: 5, agreed: 3 } });
    }
    if (url === "/api/price-monitoring/brand-aliases" && method === "PUT") {
      return json({ rootDealId: "root", aliases: (body as { aliases: string[] }).aliases, reevaluateError: null });
    }
    if (url === "/api/price-monitoring/labels" && method === "DELETE") {
      return json({ rootDealId: "root", removed: 1, reevaluateError: null, accuracy: { total: 4, agreed: 3 } });
    }
    return json({ allItems: CANDIDATES, errors: {} });
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function openAndExpand() {
  render(
    <MarketPriceMonitor
      items={[{ id: "opt", name: "올리브레몬 듀얼 올레샷", searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스", sellingPrice: 39800, unit: "박스", expectedQuantity: 2, brandName: "비비랩" }]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /가격조회/ }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByText("검토");
  fireEvent.click(within(dialog).getByRole("button", { name: "올리브레몬 듀얼 올레샷" }));
  return dialog;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MarketPriceMonitor — owner match labels", () => {
  it("shows the three axes separately and the accuracy line", async () => {
    mockFetch();
    const dialog = await openAndExpand();
    expect(within(dialog).getByText(/내가 표시한 4건 중 3건이 자동 판정과 같음/)).toBeInTheDocument();
    const otherCompany = within(dialog).getByText(/순 유기농 올레샷/).closest("tr")!;
    expect(within(otherCompany).getByText("브랜드 없음")).toBeInTheDocument();
    // one state, one name: the axis cell and the exclusion reason use the same words
    expect(within(otherCompany).getByText(/배제: 브랜드 없음/)).toBeInTheDocument();
    // one state, one name: the cell shows only the exclusion reason; how to fix it lives in the help text
    const noCompany = within(dialog).getByText("유기농 올리브레몬 듀얼 올레샷 2박스").closest("tr")!;
    expect(within(noCompany).getByText(/배제: 브랜드 없음/)).toBeInTheDocument();
    expect(within(dialog).getByText(/「브랜드 없음」으로 빠진 후보가 같은 회사 제품이면/)).toBeInTheDocument();
    // cause examples open in a hint reachable by mouse, keyboard focus and touch (a button trigger, not a title attribute)
    const cause = within(dialog).getByRole("button", { name: /같은 회사의 다른 상품\(검색어 낱말 공유\) 1건/ });
    expect(cause).not.toHaveAttribute("title");
  });

  it("marking the cheapest weak match as a different product re-judges immediately, and undo restores it", async () => {
    const calls = mockFetch();
    const dialog = await openAndExpand();
    // Rows are re-rendered after re-judging, so look the row up again after every action.
    const row = () => within(dialog).getByText("비비랩 레몬 듀얼 스틱 2박스").closest("tr")!;

    fireEvent.click(within(row()).getByRole("button", { name: /다른 상품으로 표시/ }));
    await waitFor(() => expect(within(dialog).queryByText("검토")).not.toBeInTheDocument());
    expect(within(row()).getByText(/다른 상품으로 표시함/)).toBeInTheDocument();

    const post = calls.find((c) => c.url === "/api/price-monitoring/labels" && c.method === "POST");
    expect(post?.body).toMatchObject({
      dealId: "opt",
      label: "DIFFERENT",
      candidate: { mall: "어떤몰", productName: "비비랩 레몬 듀얼 스틱 2박스" },
      searchQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
      defaultQuery: "비비랩 올리브레몬 듀얼 올레샷 2박스",
    });

    fireEvent.click(within(row()).getByRole("button", { name: "표시 취소" }));
    await within(dialog).findByText("검토");
    expect(calls.find((c) => c.method === "DELETE")?.body).toEqual({ dealId: "opt", nameKey: "어떤몰|비비랩레몬듀얼스틱2박스" });
  });
  it("suggests the deal's company name found in a 「브랜드 없음」 candidate, and saving it brings that candidate back", async () => {
    const calls = mockFetch({ root: "(주)정체몰" });
    const dialog = await openAndExpand();

    expect(within(dialog).getByText(/거래처 이름과 같음 · 「브랜드 없음」으로 빠진 후보 1건에 있음 · 예: 유기농 올리브레몬 듀얼 올레샷 2박스/)).toBeTruthy();
    const accept = await within(dialog).findByRole("button", { name: "같은 회사로 볼 이름에 「정체몰」 추가" });
    const row = () => within(dialog).getByText("유기농 올리브레몬 듀얼 올레샷 2박스", { selector: "td *, td" }).closest("tr") as HTMLElement;
    expect(within(row()).queryByText("배제: 브랜드 없음")).toBeTruthy();

    fireEvent.click(accept);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/price-monitoring/brand-aliases")).toBe(true));
    const put = calls.find((c) => c.url === "/api/price-monitoring/brand-aliases");
    expect(put?.method).toBe("PUT");
    expect(put?.body).toEqual({ dealId: "opt", aliases: ["정체몰"] });

    // accepted name is now an identity: the suggestion disappears and the input shows the saved name
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "같은 회사로 볼 이름에 「정체몰」 추가" })).toBeNull());
    expect((within(dialog).getByLabelText("같은 회사로 볼 이름") as HTMLInputElement).value).toBe("정체몰");
    // the candidate is no longer excluded by the brand axis
    expect(within(row()).queryByText("배제: 브랜드 없음")).toBeNull();
  });

  it("accepting a suggestion keeps a name the owner typed but has not saved yet", async () => {
    const calls = mockFetch({ root: "(주)정체몰" });
    const dialog = await openAndExpand();
    fireEvent.change(within(dialog).getByLabelText("같은 회사로 볼 이름"), { target: { value: "제조사X" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: "같은 회사로 볼 이름에 「정체몰」 추가" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/price-monitoring/brand-aliases")).toBe(true));
    expect(calls.find((c) => c.url === "/api/price-monitoring/brand-aliases")?.body).toEqual({ dealId: "opt", aliases: ["제조사X", "정체몰"] });
  });
});
