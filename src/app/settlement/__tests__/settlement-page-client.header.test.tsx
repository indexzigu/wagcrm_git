// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

/**
 * 정산 머리는 판매 관리와 같은 형태다(애플 UI 리뉴얼 묶음 2):
 * 부제 = 건수 요약 · 가운데 = 월별/연도별 분할 버튼 · 오른쪽 = 세무 처리·새로고침.
 * 카드 툴바에는 기간 이동(‹ ›)과 검색만 남는다.
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

function header(): HTMLElement {
  const el = document.querySelector("header");
  if (!el) throw new Error("CrmShell 머리가 없다");
  return el as HTMLElement;
}

describe("정산 머리 — 판매 관리와 같은 형태", () => {
  it("월별/연도별은 머리 분할 버튼이고 카드 툴바에는 없다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    const group = within(header()).getByRole("radiogroup");
    expect(within(group).getByRole("radio", { name: "월별" })).toHaveAttribute("aria-checked", "true");
    expect(within(group).getByRole("radio", { name: "연도별" })).toBeInTheDocument();
    // 머리 밖(본문)에는 같은 이름의 조작이 없다.
    expect(screen.getAllByText("월별")).toHaveLength(1);
    expect(screen.getAllByText("연도별")).toHaveLength(1);
  });

  it("연도별을 누르면 기간 라벨이 YYYY년 으로 바뀐다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    fireEvent.click(within(header()).getByRole("radio", { name: "연도별" }));
    await waitFor(() =>
      expect(within(header()).getByRole("radio", { name: "연도별" })).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByText(/^\d{4}년$/)).toBeInTheDocument();
    // 기간 이동은 본문 툴바에 남는다.
    expect(header()).not.toContainElement(screen.getByRole("button", { name: "이전 기간" }));
  });

  it("세무 처리·새로고침은 머리 오른쪽에 있고 미처리 배지를 유지한다", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    const tax = within(header()).getByRole("button", { name: /세무 처리/ });
    await waitFor(() => expect(tax).toHaveTextContent("3"));
    expect(within(header()).getByRole("button", { name: /새로고침/ })).toBeInTheDocument();
  });

  it("부제는 두 섹션 배지와 같은 건수로 「정산중 N건 · 정산완료 N건」", async () => {
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    await waitFor(() => expect(within(header()).getByText("정산중 2건 · 정산완료 1건")).toBeInTheDocument());
    expect(screen.getByText("2건")).toBeInTheDocument();
    expect(screen.getByText("1건")).toBeInTheDocument();
  });

  it("정산 목록을 받기 전에는 부제를 비운다 — 「0건」(할 일 없음)으로 읽히지 않게", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).startsWith("/api/reports/settlement")) await gate;
        return base(input, init);
      }),
    );
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    expect(within(header()).queryByText(/건 · /)).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(within(header()).getByText("정산중 2건 · 정산완료 1건")).toBeInTheDocument());
  });
});
