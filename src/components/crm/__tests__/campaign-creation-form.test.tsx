// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CampaignCreationForm } from "../campaign-creation-form";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
  },
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

describe("CampaignCreationForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith("/api/search/deals?")) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              results: [
                {
                  id: "deal-1",
                  dealName: "테스트 딜",
                  brandName: "브랜드A",
                  partnerName: "벤더A",
                  status: "NEGOTIATING",
                  partnerId: "partner-1",
                },
              ],
            }),
        });
      }

      if (url === "/api/deals/deal-1") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "deal-1",
              dealName: "테스트 딜",
              brandName: "브랜드A",
              partnerName: "벤더A",
              costPrice: 1000,
              sellingPrice: 2000,
              totalCommissionRate: 10,
              options: [],
            }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sellers: [] }),
      });
    }) as typeof fetch;
  });

  it("shows normalized deal context in search results and after selection", async () => {
    render(<CampaignCreationForm />);

    const input = screen.getByPlaceholderText("딜명 또는 브랜드명으로 검색 (2자 이상)");
    fireEvent.change(input, { target: { value: "테스트" } });

    await waitFor(() => {
      expect(screen.getByText("브랜드A")).toBeInTheDocument();
      expect(screen.getByText("벤더A")).toBeInTheDocument();
      expect(screen.getByText("협의")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("테스트 딜"));

    await waitFor(() => {
      expect(screen.getByText("브랜드A")).toBeInTheDocument();
      expect(screen.getByText("벤더A")).toBeInTheDocument();
    });
  });
});
