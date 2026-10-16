// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkSearchDialog, normalizeSearchResults } from "../link-search-dialog";
import { formatDealContextLabel } from "@/lib/deal-display";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ results: [] }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("link-search-dialog deal labels", () => {
  it("shows both brand and partner when they differ", () => {
    expect(
      formatDealContextLabel({
        brandName: "브랜드A",
        partnerName: "벤더A",
      }),
    ).toBe("브랜드A - 벤더A");
  });

  it("avoids duplicate labels when brand and partner names match", () => {
    expect(
      formatDealContextLabel({
        brandName: "CORINGCO",
        partnerName: "CORINGCO",
      }),
    ).toBe("CORINGCO");
  });

  it("falls back to partner label when brand is missing", () => {
    expect(
      formatDealContextLabel({
        brandName: null,
        partnerName: "거래처A",
      }),
    ).toBe("거래처A");
  });

  it("normalizes deal search results with the formatted sublabel", () => {
    const results = normalizeSearchResults("deal", [
      {
        id: "deal-1",
        dealName: "테스트 딜",
        brandName: "브랜드A",
        partnerName: "벤더A",
        status: "NEGOTIATING",
      },
    ]);

    expect(results).toEqual([
      {
        id: "deal-1",
        label: "테스트 딜",
        sublabel: "브랜드A - 벤더A",
        identityParts: [
          { label: "딜", value: "테스트 딜" },
          { label: "브랜드", value: "브랜드A" },
          { label: "거래처", value: "벤더A" },
        ],
        metadata: {
          status: "협의",
          createdAt: "",
        },
      },
    ]);
  });

  it("표에 없는 상태 코드는 영문 대신 「알 수 없음」, 상태가 없으면 칸을 비운다(P2 ③ 상태 칸)", () => {
    const [unknown, empty] = normalizeSearchResults("campaign", [
      { id: "c-1", sellerName: "셀러A", dealName: "딜A", status: "FUTURE_STATUS" },
      { id: "c-2", sellerName: "셀러B", dealName: "딜B" },
    ]);
    expect(unknown.metadata?.status).toBe("알 수 없음");
    expect(empty.metadata?.status).toBe("");
    const [partner] = normalizeSearchResults("partner", [{ id: "p-1", name: "거래처A", type: "AGENT" }]);
    expect(partner.sublabel).toBe("에이전트");
  });

  it("제목·검색 안내·확인 버튼은 mode 와 대상에서 만든다(선택 = 칸 채우기·바꾸기)", async () => {
    render(
      <LinkSearchDialog
        open
        onOpenChange={() => {}}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("셀러 선택")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("셀러 이름으로 검색")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "선택" })).toBeDisabled();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/search/sellers?",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it("목록에 하나 더 잇는 창은 「○○ 연결」 / 「연결」 이다", () => {
    render(
      <LinkSearchDialog
        open
        mode="link"
        onOpenChange={() => {}}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        onSelect={() => {}}
      />,
    );

    expect(screen.getByText("딜 연결")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("딜 또는 브랜드 이름으로 검색")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "연결" })).toBeDisabled();
  });

  it("지금 연결된 항목은 「현재」로 표시하고, 그것을 골라도 확인할 수 없다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { id: "s-cur", name: "지금 셀러", snsType: "INSTAGRAM", snsHandle: "cur" },
          { id: "s-new", name: "다른 셀러", snsType: "INSTAGRAM", snsHandle: "new" },
        ],
      }),
    });
    const onSelect = vi.fn();
    render(
      <LinkSearchDialog
        open
        currentId="s-cur"
        onOpenChange={() => {}}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={onSelect}
      />,
    );

    const currentRow = await screen.findByRole("button", { name: /지금 셀러/ });
    expect(currentRow).toHaveTextContent("현재");
    fireEvent.click(currentRow);
    expect(currentRow).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "선택" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /다른 셀러/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택" }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "s-new" }));
  });

  it("고른 행을 더블클릭해도 바로 확정하지 않는다(연결·변경은 즉시 저장이라 확인 버튼으로만)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ id: "d1", dealName: "딜 하나", status: "CONFIRMED" }] }),
    });
    const onSelect = vi.fn();
    render(
      <LinkSearchDialog
        open
        mode="link"
        onOpenChange={() => {}}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        onSelect={onSelect}
      />,
    );

    fireEvent.doubleClick(await screen.findByRole("button", { name: /딜 하나/ }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("딜·거래처는 최근 등록순을 요청하고, 행에 상태 대신 등록일을 한 줄로 보인다", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ id: "d1", dealName: "딜 하나", status: "CONFIRMED", createdAt: "2026-10-16T03:00:00.000Z" }],
      }),
    });
    render(
      <LinkSearchDialog
        open
        onOpenChange={() => {}}
        entityType="deal"
        searchEndpoint="/api/search/deals"
        onSelect={() => {}}
      />,
    );

    const row = await screen.findByRole("button", { name: /딜 하나/ });
    expect(row).toHaveTextContent("26-10-16");
    expect(row).not.toHaveTextContent("확정");
    expect(screen.getByText(/최근 등록 20건/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/search/deals?sort=created",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});
