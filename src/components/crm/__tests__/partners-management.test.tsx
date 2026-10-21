// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PartnersManagement } from "../partners-management";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

const mockUseFilterParams = vi.fn();
const mockUseSearchParams = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => mockUseSearchParams(),
}));

vi.mock("@/hooks/use-filter-params", () => ({
  useFilterParams: () => mockUseFilterParams(),
}));

vi.mock("../crm-shell", () => ({
  CrmShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../data-source-banner", () => ({
  DataSourceBanner: ({ message }: { message: string }) => <div>{message}</div>,
}));

vi.mock("../inline-data-grid", () => ({
  InlineDataGrid: () => <div>grid</div>,
}));

vi.mock("../partners-panel", () => ({
  PartnersPanel: ({
    partner,
    open,
  }: {
    partner: { name?: string } | null;
    open: boolean;
  }) => (
    <div>
      <div>panel-open:{String(open)}</div>
      <div>panel-partner:{partner?.name ?? "none"}</div>
    </div>
  ),
}));

const initialPartners = [
  {
    id: "partner-nutrione",
    name: "Nutrione",
    type: "VENDOR" as const,
    dealCount: 1,
    contacts: [],
  },
  {
    id: "partner-coringco",
    name: "CORINGCO",
    type: "BRAND" as const,
    dealCount: 1,
    contacts: [],
  },
];

describe("PartnersManagement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFilterParams.mockReturnValue({
      filters: {},
      setFilter: vi.fn(),
    });
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
  });

  it("opens partner detail panel from selectedPartner deep link", () => {
    mockUseFilterParams.mockReturnValue({
      filters: { selectedPartner: "partner-nutrione" },
      setFilter: vi.fn(),
    });

    renderWithQueryClient(<PartnersManagement initialPartners={initialPartners} />);

    expect(screen.getByText("panel-open:true")).toBeInTheDocument();
    expect(screen.getByText("panel-partner:Nutrione")).toBeInTheDocument();
  });

  // 페이지 머리 없음(2026-10-21 오너 방침) — 신규 거래처 버튼은 검색과 같은 카드 도구줄에 산다.
  it("신규 거래처 버튼이 검색창과 같은 카드 도구줄에 있고, 페이지 제목(h1·header)은 없다", () => {
    const { container } = renderWithQueryClient(<PartnersManagement initialPartners={initialPartners} />);

    const toolbar = screen.getByRole("textbox", { name: "거래처 검색" }).closest("section");
    expect(toolbar).not.toBeNull();
    expect(toolbar).toContainElement(screen.getByRole("button", { name: "신규 거래처" }));
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("header")).toBeNull();
  });
});
