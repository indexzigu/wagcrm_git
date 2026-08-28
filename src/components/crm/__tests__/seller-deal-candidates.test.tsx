// @vitest-environment jsdom
// D2② 셀러 상세 「제안 후보 딜」 섹션 계약.
// 쌍 매출 미입력을 0 으로 그리지 않는다는 규약은 딜 쪽 섹션과 같다.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SellerDealCandidates } from "../seller-deal-candidates";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const DAY_MS = 86_400_000;

const candidate = (over: Record<string, unknown> = {}) => ({
  dealId: "d1",
  dealName: "딜 이름",
  brandName: "브랜드",
  reason: "SAME_DEAL_RERUN",
  priority: true,
  pairRunCount: 2,
  pairLastRunStartAt: new Date(Date.now() - 200 * DAY_MS).toISOString(),
  pairSalesTotal: 12_000_000,
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

describe("SellerDealCandidates", () => {
  it("딜명·브랜드·사유·우선순위를 보여준다", async () => {
    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText("딜 이름")).toBeInTheDocument());
    expect(screen.getByText("브랜드")).toBeInTheDocument();
    expect(screen.getByText("재진행")).toBeInTheDocument();
    expect(screen.getByText("적극 검토")).toBeInTheDocument();
  });

  it("매출 미입력이면 금액을 그리지 않는다", async () => {
    mockCandidates([candidate({ pairSalesTotal: null, priority: false })]);
    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText("딜 이름")).toBeInTheDocument());
    expect(screen.queryByText(/만원/)).not.toBeInTheDocument();
  });

  it("진행 이력이 없는 신규 딜은 경과·횟수를 그리지 않는다", async () => {
    mockCandidates([
      candidate({
        reason: "NEW_MATCH",
        priority: false,
        pairRunCount: null,
        pairLastRunStartAt: null,
        pairSalesTotal: null,
      }),
    ]);
    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText("딜 이름")).toBeInTheDocument());
    expect(screen.getByText("신규")).toBeInTheDocument();
    expect(screen.queryByText(/마지막 진행/)).not.toBeInTheDocument();
    expect(screen.queryByText(/진행 .*회/)).not.toBeInTheDocument();
  });

  it("후보가 없으면 비어 있음을 알린다", async () => {
    mockCandidates([]);
    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText("제안 후보 딜이 없습니다")).toBeInTheDocument());
  });

  // --- 기안 승격 (2단계) — 딜 상세 쪽 섹션과 같은 엔드포인트를 쓴다 ---

  it("기안 요청은 (셀러, 딜)만 보낸다 — 사유는 서버가 정한다", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      void init;
      return url === "/api/recampaign-proposals"
        ? new Response(JSON.stringify({ created: true, proposalId: "p1" }), { status: 201 })
        : new Response(JSON.stringify({ candidates: [candidate()] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText("딜 이름")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "기안" }));

    await waitFor(() => expect(screen.getByText(/기안됨/)).toBeInTheDocument());
    const call = fetchMock.mock.calls.find((c) => c[0] === "/api/recampaign-proposals");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ sellerId: "s1", dealId: "d1" });
  });

  it("서버가 이미 열린 기안을 알려주면 버튼 대신 '기안됨'을 그린다", async () => {
    mockCandidates([candidate({ proposed: true })]);
    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText(/기안됨/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "기안" })).not.toBeInTheDocument();
  });

  it("조회 실패는 삼키지 않고 표면에 남긴다", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "터졌다" }), { status: 500 })),
    );
    render(<SellerDealCandidates sellerId="s1" />);
    await waitFor(() => expect(screen.getByText(/터졌다/)).toBeInTheDocument());
  });
});
