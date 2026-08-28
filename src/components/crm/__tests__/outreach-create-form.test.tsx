import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { OutreachCreateForm } from "../outreach-create-form";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/crm/link-search-dialog", async () => {
  const actual = await vi.importActual<typeof import("../link-search-dialog")>("../link-search-dialog");
  return {
    ...actual,
    LinkSearchDialog: () => null,
  };
});

describe("OutreachCreateForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === "/api/deals/deal-1") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              dealName: "테스트 딜",
              brandName: "브랜드A",
              partnerName: "벤더A",
            }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as typeof fetch;
  });

  it("shows normalized deal context instead of re-prefixing partner text", async () => {
    render(
      <OutreachCreateForm
        dealId="deal-1"
        onSuccess={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("브랜드A")).toBeInTheDocument();
      expect(screen.getByText("벤더A")).toBeInTheDocument();
    });

    expect(screen.getByText("브랜드")).toBeInTheDocument();
    expect(screen.getByText("거래처")).toBeInTheDocument();
  });
});
