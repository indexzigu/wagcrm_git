// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CampaignRow, DashboardData } from "@/lib/crm-types";

/**
 * 정산 두 표는 리포트로 걸러진다(`filteredCampaigns`) — 리포트가 없으면 전부 0건이 된다.
 * 종전에는 리포트 조회가 실패해도, 아직 오지 않았어도 「정산 진행 중인 캠페인이 없습니다」가
 * 떠서 **이번 달 정산이 비었다고 오판**하게 했다(interfaces 점검 #9, 2026-09-24).
 * 세 상태(대기·실패·진짜 0건)가 서로 다른 얼굴인지를 고정한다.
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/settlement",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/crm/campaign-side-panel", () => ({ CampaignSidePanel: () => null }));

import { SettlementPageClient } from "../settlement-page-client";

const EMPTY_TEXT = "정산 진행 중인 캠페인이 없습니다.";
const ERROR_TEXT = "정산 목록을 불러오지 못했습니다.";

const REPORT = {
  campaigns: [],
  summary: { totalRevenue: 0, totalMargin: 0, totalSellerPayouts: 0 },
};

const INITIAL_DATA = {
  campaigns: [{ id: "c1", status: "SETTLEMENT_IN_PROGRESS" } as unknown as CampaignRow],
  apiCallLogs: [],
  assets: [],
  storage: null,
} as unknown as DashboardData;

type ReportReply = () => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;
let replyToReport: ReportReply;
let reportRequestCount = 0;

beforeEach(() => {
  reportRequestCount = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/reports/settlement")) {
        reportRequestCount += 1;
        return replyToReport();
      }
      if (String(input).startsWith("/api/campaigns")) {
        return { ok: true, json: async () => ({ campaigns: INITIAL_DATA.campaigns }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("정산 페이지 — 조회 실패는 빈 목록이 아니다", () => {
  it("리포트 조회가 실패하면 복구 안내를 보이고 「없습니다」를 그리지 않는다", async () => {
    replyToReport = async () => ({ ok: false, status: 500, json: async () => ({}) });
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(ERROR_TEXT);
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
    // 요약 줄의 대기 금액도 리포트로 걸러진 목록에서 나온다 — 모르는 값을 0원으로 말하지 않는다.
    expect(screen.getByText("입금 대기:").nextElementSibling?.textContent).toBe("-");
    expect(screen.getByText("지급 대기:").nextElementSibling?.textContent).toBe("-");
  });

  it("「다시 불러오기」는 제자리에서 다시 조회하고, 성공하면 진짜 0건을 보인다", async () => {
    replyToReport = async () => ({ ok: false, status: 500, json: async () => ({}) });
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    await screen.findByRole("alert");
    const before = reportRequestCount;

    replyToReport = async () => ({ ok: true, json: async () => REPORT });
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));

    await waitFor(() => expect(screen.getByText(EMPTY_TEXT)).toBeTruthy());
    expect(reportRequestCount).toBe(before + 1);
    expect(screen.queryByText(ERROR_TEXT)).toBeNull();
  });

  it("늦게 도착한 옛 요청의 실패는 새 결과를 덮지 않는다(마지막 요청만 반영)", async () => {
    let failFirst: (() => void) | null = null;
    replyToReport = () =>
      new Promise((resolve) => {
        failFirst = () => resolve({ ok: false, status: 500, json: async () => ({}) });
      });
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);
    await waitFor(() => expect(reportRequestCount).toBe(1));

    // 첫 요청이 아직 매달린 사이 새로고침 — 두 번째 요청은 곧바로 성공한다.
    replyToReport = async () => ({ ok: true, json: async () => REPORT });
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await waitFor(() => expect(screen.getByText(EMPTY_TEXT)).toBeTruthy());

    // 이제 첫 요청이 실패로 늦게 도착한다.
    await act(async () => {
      failFirst!();
    });

    expect(screen.queryByText(ERROR_TEXT)).toBeNull();
    expect(screen.getByText(EMPTY_TEXT)).toBeTruthy();
  });

  it("첫 리포트가 오기 전에는 로딩으로 그린다 — 「없습니다」가 먼저 번쩍이지 않는다", async () => {
    replyToReport = () => new Promise(() => {});
    render(<SettlementPageClient initialData={INITIAL_DATA} defaultMonth="2026-08" />);

    await waitFor(() => expect(reportRequestCount).toBe(1));
    expect(screen.getByText("정산 목록 로딩 중...")).toBeTruthy();
    expect(screen.queryByText(EMPTY_TEXT)).toBeNull();
  });
});
