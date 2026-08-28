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
});
