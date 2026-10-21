// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

/**
 * 정산 화면은 페이지 머리(제목·부제)를 두지 않는다(오너 방침 2026-10-21). 조작은 리뉴얼 전처럼 카드 도구줄에:
 * 왼쪽 = 월별/연도별 분할 버튼 · 기간 이동(‹ ›) / 오른쪽 = 검색 · 세무 처리 · 새로고침.
 * 분할 버튼은 종전 토글과 같은 경로(`viewType` 주소 값)를 쓴다 — 기간 라벨이 그 단위로 바뀌어야 한다.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

// 주소 값이 바뀌면 다시 그리도록 작은 저장소로 흉내 낸다(분할 버튼 → 주소 → 기간 라벨).
const nav = vi.hoisted(() => {
  let qs = "";
  const listeners = new Set<() => void>();
  return {
    get: () => qs,
    set: (next: string) => {
      qs = next;
      listeners.forEach((listener) => listener());
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    useRouter: () => ({
      push: vi.fn(),
      replace: (url: string) => nav.set(url.split("?")[1] ?? ""),
      refresh: vi.fn(),
    }),
    usePathname: () => "/settlement",
    useSearchParams: () => {
      const qs = React.useSyncExternalStore(nav.subscribe, nav.get, nav.get);
      return React.useMemo(() => new URLSearchParams(qs), [qs]);
    },
  };
});

vi.mock("@/components/crm/campaign-side-panel", () => ({
  CampaignSidePanel: () => null,
}));
vi.mock("@/components/crm/settlement-table", () => ({
  SettlementTable: () => null,
}));
vi.mock("@/components/crm/settlement-completed-table", () => ({
  SettlementCompletedTable: () => null,
}));

import { SettlementPageClient } from "../settlement-page-client";

function row(id: string, status: CampaignRow["status"]): CampaignRow {
  return {
    id,
    status,
    dealName: `딜-${id}`,
    sellerName: "셀러",
    salesChannel: "SELLER_MALL",
    startDate: "2026-08-01",
    endDate: "2026-08-07",
    groupId: null,
    isDepositReceived: false,
    isPayoutCompleted: false,
    isSupplierPayoutCompleted: false,
  } as unknown as CampaignRow;
}

const ROWS = [
  row("a1", "SETTLEMENT_IN_PROGRESS"),
  row("a2", "SETTLEMENT_WAIT"),
  row("c1", "COMPLETED"),
];

const INITIAL_DATA = {
  campaigns: ROWS,
  apiCallLogs: [],
  assets: [],
  storage: null,
} as unknown as DashboardData;

beforeEach(() => {
  nav.set("");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/reports/settlement")) {
        return {
          ok: true,
          json: async () => ({
            campaigns: ROWS.map((r) => ({ id: r.id })),
            summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0, totalCommissionRevenue: 0 },
          }),
        };
      }
      if (url.startsWith("/api/settlement/tax-filing-board")) {
        return { ok: true, json: async () => ({ pendingCount: 2, withholdingPendingCount: 1 }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 카드 도구줄 — 기간 이동 버튼이 들어 있는 줄(왼쪽 묶음 + 오른쪽 묶음의 부모). */
function toolbar(): HTMLElement {
  const prev = screen.getByRole("button", { name: "이전 기간" });
  const row = prev.parentElement?.parentElement?.parentElement;
  if (!row) throw new Error("카드 도구줄이 없다");
  return row as HTMLElement;
}

describe("정산 카드 도구줄 — 페이지 머리 없음", () => {
  it("페이지 머리(<header>·h1 제목·건수 부제)를 그리지 않는다", async () => {
    const { container } = render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    await waitFor(() => expect(screen.getByText("2건")).toBeInTheDocument());
    expect(container.querySelector("header")).toBeNull();
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.queryByText(/정산중 \d+건 · 정산완료 \d+건/)).not.toBeInTheDocument();
  });

  it("월별/연도별은 카드 도구줄의 분할 버튼이고, 기간 이동(‹ ›) 왼쪽에 한 벌만 있다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    const group = within(toolbar()).getByRole("radiogroup", { name: "기간 단위" });
    expect(within(group).getByRole("radio", { name: "월별" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: "연도별" })).toBeInTheDocument();
    expect(screen.getAllByText("월별")).toHaveLength(1);
    expect(screen.getAllByText("연도별")).toHaveLength(1);
    const prev = screen.getByRole("button", { name: "이전 기간" });
    expect(group.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("연도별을 누르면 기간 라벨이 YYYY년 으로 바뀐다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    fireEvent.click(within(toolbar()).getByRole("radio", { name: "연도별" }));
    await waitFor(() =>
      expect(within(toolbar()).getByRole("radio", { name: "연도별" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByText(/^\d{4}년$/)).toBeInTheDocument();
  });

  it("세무 처리·새로고침은 도구줄 오른쪽 검색칸 옆에 있고 미처리 배지를 유지한다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    const tax = within(toolbar()).getByRole("button", { name: /세무 처리/ });
    await waitFor(() => expect(tax).toHaveTextContent("3"));
    const refresh = within(toolbar()).getByRole("button", { name: /새로고침/ });
    const search = within(toolbar()).getByPlaceholderText("검색 (2글자 이상)");
    // 오른쪽 묶음: 검색 → 세무 처리 → 새로고침
    const right = tax.parentElement as HTMLElement;
    expect(right).toContainElement(search);
    expect(right).toContainElement(refresh);
    expect(search.compareDocumentPosition(tax) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tax.compareDocumentPosition(refresh) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("두 섹션 배지 건수는 그대로다(정산중 2 · 정산완료 1)", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    await waitFor(() => expect(screen.getByText("2건")).toBeInTheDocument());
    expect(screen.getByText("1건")).toBeInTheDocument();
  });
});
