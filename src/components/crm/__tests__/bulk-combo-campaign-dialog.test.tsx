// @vitest-environment jsdom
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardData } from "@/lib/crm-types";

// LinkSearchDialog는 실검색 fetch에 의존하므로, 열렸을 때 셀러 1명을 즉시 선택하는 목으로 대체.
vi.mock("../link-search-dialog", () => ({
  LinkSearchDialog: ({
    open,
    onSelect,
  }: {
    open: boolean;
    onSelect: (entity: {
      id: string;
      label: string;
      metadata?: Record<string, string>;
    }) => void;
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSelect({
            id: "seller-1",
            label: "가온",
            metadata: { alias: "가온", snsType: "INSTAGRAM", snsHandle: "gaon" },
          })
        }
      >
        MOCK_PICK_SELLER
      </button>
    ) : null,
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  }),
}));

import { BulkComboCampaignDialog } from "../bulk-combo-campaign-dialog";

function makeData(): DashboardData {
  return {
    deals: [
      { id: "deal-1", dealName: "비타민", costPrice: 0, sellingPrice: 0, status: "CONFIRMED", brandName: "뉴트리원", partner: null, baseMarginPolicy: { byChannel: {} } },
      { id: "deal-2", dealName: "콜라겐", costPrice: 0, sellingPrice: 0, status: "CONFIRMED", brandName: "뉴트리원", partner: null, baseMarginPolicy: { byChannel: {} } },
      { id: "deal-3", dealName: "프로바이오틱스", costPrice: 0, sellingPrice: 0, status: "CONFIRMED", brandName: "뉴트리원", partner: null, baseMarginPolicy: { byChannel: {} } },
    ],
    sellers: [
      { id: "seller-1", name: "김본명", alias: "가온", snsType: "INSTAGRAM", snsHandle: "gaon", currentFollowers: 0 },
    ],
    campaigns: [],
    apiCallLogs: [],
    assets: [],
    storage: {
      supabaseLimitBytes: 0,
      supabaseWarningBytes: 0,
      supabaseEstimatedBytes: 0,
      googleDriveConnected: false,
      recentAssets: [],
    },
  };
}

const noop = () => {};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toastSuccess.mockReset();
});

describe("BulkComboCampaignDialog — 검증 게이트", () => {
  it("초기(셀러 미선택)에는 제출이 비활성이고 딜 목록은 안내로 잠긴다", () => {
    render(
      <BulkComboCampaignDialog data={makeData()} open onOpenChange={noop} onCreated={noop} />,
    );
    expect(screen.getByText("조합 캠페인 만들기")).toBeInTheDocument();
    expect(screen.getByText("먼저 셀러를 선택하세요")).toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "0개 캠페인 만들기" });
    expect(submit).toBeDisabled();
  });

  it("셀러 선택 후 딜 2개 미만이면 제출 비활성 + '딜 2개 이상' 힌트를 노출한다", () => {
    render(
      <BulkComboCampaignDialog data={makeData()} open onOpenChange={noop} onCreated={noop} />,
    );
    fireEvent.click(screen.getByText("셀러 검색 선택"));
    fireEvent.click(screen.getByText("MOCK_PICK_SELLER"));

    // 셀러 선택 → 딜 체크박스 노출
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(3);
    expect(screen.getByText("조합은 딜 2개 이상이 필요합니다")).toBeInTheDocument();

    // 딜 1개만 선택 → 여전히 비활성
    fireEvent.click(checkboxes[0]);
    expect(screen.getByRole("button", { name: "1개 캠페인 만들기" })).toBeDisabled();
  });

  it("딜 2개 이상 선택 시 제출이 활성화되고 bulk-combo로 원자 제출한다", async () => {
    const onCreated = vi.fn();
    const onOpenChange = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        created: [{ id: "c1" }, { id: "c2" }],
        group: { id: "g1", memberCount: 2 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <BulkComboCampaignDialog
        data={makeData()}
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
      />,
    );
    fireEvent.click(screen.getByText("셀러 검색 선택"));
    fireEvent.click(screen.getByText("MOCK_PICK_SELLER"));

    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);

    const submit = screen.getByRole("button", { name: "2개 캠페인 만들기" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/campaigns/bulk-combo");
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.sellerId).toBe("seller-1");
    expect(payload.dealIds).toHaveLength(2);

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(onCreated.mock.calls[0][0]).toHaveLength(2);
    expect(toastSuccess).toHaveBeenCalledWith(
      "조합 캠페인 2건을 그룹으로 만들었습니다.",
      expect.anything(),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
