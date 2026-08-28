// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockToast = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => mockToast.success(...args),
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
    info: (...args: unknown[]) => mockToast.info(...args),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => "/outreach",
  useSearchParams: () => ({
    get: () => null,
  }),
}));

vi.mock("../crm-shell", () => ({
  CrmShell: ({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) => (
    <div data-testid="crm-shell">
      {actions ? <div data-testid="crm-shell-actions">{actions}</div> : null}
      {children}
    </div>
  ),
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

import OutreachPage from "@/app/outreach/page";

function renderWithQueryClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe("Integration: Sales task workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn().mockImplementation((url: string, options?: RequestInit) => {
      if (url === "/api/outreach") {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              outreaches: [
                {
                  id: "task-1",
                  dealId: "deal-1",
                  dealName: "글로우 앰플 4차",
                  brandName: "코링코 브랜드",
                  partnerName: "코링코",
                  sellerId: "seller-1",
                  sellerName: "미나",
                  sellerFollowers: 120000,
                  sellerCategory: "뷰티",
                  status: "PROPOSED",
                  contactChannel: "DM",
                  proposalMessage: "제안 메시지",
                  negotiationMemo: "러프 조건 메모",
                  testingMemo: null,
                  proposedAt: "2026-05-01T00:00:00.000Z",
                  acceptedAt: null,
                  respondedAt: null,
                  lastReminderAt: null,
                  nextReminderAt: "2026-05-02T00:00:00.000Z",
                  droppedAt: null,
                  dropReason: null,
                  linkedCampaignId: null,
                  linkedCampaignName: null,
                },
                {
                  id: "task-2",
                  dealId: "deal-1",
                  dealName: "글로우 앰플 4차",
                  brandName: "코링코 브랜드",
                  partnerName: "코링코",
                  sellerId: "seller-2",
                  sellerName: "하니",
                  sellerFollowers: 80000,
                  sellerCategory: "패션",
                  status: "DROPPED",
                  contactChannel: "EMAIL",
                  proposalMessage: "제안 메시지2",
                  negotiationMemo: null,
                  testingMemo: null,
                  proposedAt: "2026-05-01T00:00:00.000Z",
                  acceptedAt: null,
                  respondedAt: null,
                  lastReminderAt: null,
                  nextReminderAt: null,
                  droppedAt: "2026-05-02T10:00:00.000Z",
                  dropReason: "조건 불일치",
                  linkedCampaignId: null,
                  linkedCampaignName: null,
                },
                {
                  id: "task-3",
                  dealId: "deal-1",
                  dealName: "글로우 앰플 4차",
                  brandName: "코링코 브랜드",
                  partnerName: "코링코",
                  sellerId: "seller-3",
                  sellerName: "지수",
                  sellerFollowers: 50000,
                  sellerCategory: "뷰티",
                  status: "PENDING_APPROVAL",
                  contactChannel: "DM",
                  proposalMessage: "제안 메시지3",
                  negotiationMemo: "협의 메모3",
                  testingMemo: null,
                  proposedAt: "2026-05-01T00:00:00.000Z",
                  acceptedAt: null,
                  respondedAt: null,
                  lastReminderAt: null,
                  nextReminderAt: null,
                  droppedAt: null,
                  dropReason: null,
                  linkedCampaignId: null,
                  linkedCampaignName: null,
                },
              ],
            }),
        });
      }

      if (url.match(/\/api\/outreach\/[\w-]+$/) && options?.method === "PATCH") {
        const body = options.body ? JSON.parse(options.body as string) : {};
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              id: "task-1",
              status: body.status ?? "PROPOSED",
              proposedAt: "2026-05-01T00:00:00.000Z",
              acceptedAt: body.status === "CONFIRMED" ? "2026-05-03T00:00:00.000Z" : null,
              respondedAt: null,
              lastReminderAt: body.lastReminderAt ?? null,
              nextReminderAt: body.nextReminderAt ?? null,
              dropReason: body.dropReason ?? null,
              linkedCampaignId: body.autoCreateCampaign ? "camp-1" : null,
              linkedCampaignName: body.autoCreateCampaign ? "글로우 앰플 4차 - 미나" : null,
            }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      });
    }) as typeof fetch;
  });

  it("renders sales-task sections and task actions instead of a PROPOSAL campaign table", async () => {
    renderWithQueryClient(<OutreachPage />);

    await waitFor(() => {
      expect(screen.getAllByText("미나").length).toBeGreaterThan(0);
    });

    expect(screen.getByText("제안중 / 리마인드 큐")).toBeInTheDocument();
    expect(screen.getAllByText("협의중").length).toBeGreaterThan(0);
    expect(screen.getAllByText("테스트중").length).toBeGreaterThan(0);
    expect(screen.getAllByText("승인대기").length).toBeGreaterThan(0);
    // "드랍 이력"(전환완료·드랍 = CLOSED 그룹)은 stageFilter 기본값 "IN_PROGRESS"에서
    // 의도적으로 숨겨진다(CLOSED/ALL 필터에서만 노출) — 기본 보드 뷰 검증에서는 제외.
    expect(screen.getAllByText(/리마인드/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/제안 메시지/).length).toBeGreaterThan(0);
  });

  it("opens the sales task detail panel when a task card is clicked", async () => {
    renderWithQueryClient(<OutreachPage />);

    await waitFor(() => {
      expect(screen.getAllByText("미나").length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText("글로우 앰플 4차", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("코링코 브랜드", { exact: false }).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText("미나")[0]);

    await waitFor(() => {
      expect(screen.getByText("영업 테스크 상세 페이지")).toBeInTheDocument();
    });

    expect(screen.getByText("리마인드 이력")).toBeInTheDocument();
    expect(screen.getByText("메모")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "제안 메시지" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "협의 메모" })).toBeInTheDocument();
    expect(screen.getByDisplayValue("제안 메시지")).toBeInTheDocument();
    expect(screen.getAllByText("딜").length).toBeGreaterThan(0);
    expect(screen.getAllByText("브랜드").length).toBeGreaterThan(0);
  });

  it("routes direct converted selection through campaign auto-create when no linked campaign exists", async () => {
    renderWithQueryClient(<OutreachPage />);

    // Wait for tasks to load
    await waitFor(() => {
      expect(screen.getByText("지수")).toBeInTheDocument();
    });

    // Open detail panel for task-3 (지수) which is PENDING_APPROVAL
    fireEvent.click(screen.getAllByText("지수")[0]);
    await waitFor(() => {
      expect(screen.getByText("영업 테스크 상세 페이지")).toBeInTheDocument();
    });

    const detailDialog = screen.getByRole("dialog");
    const createCampaignButton = within(detailDialog).getByRole("button", { name: "캠페인 생성 (승인)" });
    fireEvent.click(createCampaignButton);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        "/api/outreach/task-3",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            status: "CONFIRMED",
            autoCreateCampaign: true,
          }),
        }),
      );
    });
  });
});
