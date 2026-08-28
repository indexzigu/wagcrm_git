// D2① 딜 상세 「제안 후보 셀러」 섹션 계약.
//
// 표시 규약의 핵심 2가지를 고정한다:
//   ① 계정 신호(평가)와 거래 실적(거래 리듬)을 **나란히** 보여준다 — 합산 금지(D10)
//   ② 쌍 매출 미입력은 **아예 그리지 않는다** — 0원으로 그리면 "실적 없음"으로 오독된다

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DealSellerCandidates } from "../deal-seller-candidates";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DAY_MS = 86_400_000;

const candidate = (over: Record<string, unknown> = {}) => ({
  sellerId: "s1",
  name: "별칭",
  snsHandle: "handle",
  snsType: "INSTAGRAM",
  fitLevel: "추천",
  currentFollowers: 1234,
  reason: "SAME_DEAL_RERUN",
  priority: true,
  pairRunCount: 2,
  pairLastRunStartAt: new Date(Date.now() - 200 * DAY_MS).toISOString(),
  pairSalesTotal: 12_000_000,
  dormancy: { tier: "EXCLUDED", daysSinceLastRun: 200 },
  runCount: 4,
  proposed: false,
  ...over,
});

const mockCandidates = (candidates: unknown[]) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ candidates }))),
  );
};

beforeEach(() => {
  mockCandidates([candidate()]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DealSellerCandidates", () => {
  it("사유·우선순위·거래 리듬·평가를 함께 보여준다", async () => {
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("별칭")).toBeInTheDocument());
    expect(screen.getByText("재진행")).toBeInTheDocument();
    expect(screen.getByText("적극 검토")).toBeInTheDocument();
    // 두 축이 나란히 — 하나의 종합 점수로 합치지 않는다(D10)
    expect(screen.getByText("제외")).toBeInTheDocument();
    expect(screen.getByText("· 평가 추천")).toBeInTheDocument();
  });

  it("매출 미입력이면 금액을 0 으로 그리지 않는다", async () => {
    mockCandidates([candidate({ pairSalesTotal: null, priority: false })]);
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("별칭")).toBeInTheDocument());
    expect(screen.queryByText(/만원/)).not.toBeInTheDocument();
    expect(screen.queryByText("적극 검토")).not.toBeInTheDocument();
  });

  it("판정 불가 셀러는 티어 자리에 대시를 그린다", async () => {
    mockCandidates([
      candidate({ dormancy: { tier: "UNKNOWN", daysSinceLastRun: null }, reason: "NEW_MATCH" }),
    ]);
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("별칭")).toBeInTheDocument());
    expect(screen.getByTitle("판정에 필요한 과거 진행 기록이 없습니다")).toBeInTheDocument();
  });

  it("후보가 없으면 섹션이 비어 있음을 알린다", async () => {
    mockCandidates([]);
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("제안 후보가 없습니다")).toBeInTheDocument());
  });

  // --- 기안 승격 (2단계) ---

  it("기안 요청은 (셀러, 딜)만 보낸다 — 사유는 서버가 정한다", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      return url === "/api/recampaign-proposals"
        ? new Response(JSON.stringify({ created: true, proposalId: "p1" }), { status: 201 })
        : new Response(JSON.stringify({ candidates: [candidate()] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("별칭")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "기안" }));

    await waitFor(() => expect(screen.getByText(/기안됨/)).toBeInTheDocument());
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/recampaign-proposals");
    const sent = JSON.parse(String(call?.[1]?.body));
    expect(sent).toEqual({ sellerId: "s1", dealId: "d1" });
    expect(sent.reason).toBeUndefined();
  });

  it("서버가 이미 열린 기안을 알려주면 버튼 대신 '기안됨'을 그린다", async () => {
    mockCandidates([candidate({ proposed: true })]);
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/기안됨/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "기안" })).not.toBeInTheDocument();
  });

  it("기안 실패는 삼키지 않고 버튼을 되돌린다", async () => {
    const { toast } = await import("sonner");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/recampaign-proposals"
          ? new Response(JSON.stringify({ error: "후보가 아닙니다" }), { status: 409 })
          : new Response(JSON.stringify({ candidates: [candidate()] })),
      ),
    );
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("별칭")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "기안" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("후보가 아닙니다"));
    expect(screen.getByRole("button", { name: "기안" })).toBeInTheDocument();
    expect(screen.queryByText(/기안됨/)).not.toBeInTheDocument();
  });

  it("조회 실패는 삼키지 않고 표면에 남긴다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "터졌다" }), { status: 500 })),
    );
    render(<DealSellerCandidates dealId="d1" dealName="딜" onPropose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/터졌다/)).toBeInTheDocument());
  });
});
