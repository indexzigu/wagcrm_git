// @vitest-environment jsdom
import { render, screen, waitFor } from "@testing-library/react";
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
        },
      },
    ]);
  });

  it("renders an entity-specific dialog description", async () => {
    render(
      <LinkSearchDialog
        open
        onOpenChange={() => {}}
        entityType="seller"
        searchEndpoint="/api/search/sellers"
        onSelect={() => {}}
        title="셀러 검색 선택"
      />,
    );

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByText("연결할 셀러를 검색하고 선택합니다."),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/search/sellers?",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });
});
