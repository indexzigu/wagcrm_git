// @vitest-environment jsdom
/**
 * ApprovalDetail — 결재함 상세 `/approvals/[id]` (Plan 2 Task 5).
 *
 * 한 화면이 두 종류를 받는다: 결재할 기안(WRITE)과 봇의 조회 결과(READ).
 * WRITE 는 기존 기안 카드를 그대로 얹고(승인·반려·재시도는 한 곳에만 있어야 한다),
 * READ 는 이 화면이 직접 그린다.
 *
 * 훅은 주입한다 — 실제 훅은 fetch 를 타고, 여기서 검증할 것은 **받은 데이터로
 * 무엇을 그리는가**이지 네트워크가 아니다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: { children: React.ReactNode; href: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// 기안 카드는 자기 fetch 를 갖는다 — 여기서는 「마운트되는가」만 본다.
vi.mock("../proposal-card", () => ({
  ProposalCard: ({ id }: { id: string }) => <div data-testid="proposal-card-mock">{id}</div>,
}));

import { ApprovalDetail } from "../approval-detail";
import type { ApprovalDetailData, ApprovalDetailHook } from "../approval-detail";

function hookOf(
  data: ApprovalDetailData | null,
  overrides: Partial<ReturnType<ApprovalDetailHook>> = {}
): ApprovalDetailHook {
  return () => ({ data, isLoading: false, isError: false, refetch: vi.fn(), ...overrides });
}

function readProposal(overrides: Partial<ApprovalDetailData> = {}): ApprovalDetailData {
  return {
    id: "proposal-read-1",
    title: "판매 조건 검색 1건",
    kind: "READ",
    status: "EXECUTED",
    createdBy: "AGENT_WORKER",
    createdAt: "2026-09-22T05:30:00Z",
    resultSummary: "search_deals: 1 deal(s)",
    structuredResult: {
      operation: "search_deals",
      jobId: "job-abc",
      query: { query: "A", status: "" },
      truncated: false,
      data: {
        items: [{ id: "d1", dealName: "판매 조건 A", status: "CONFIRMED" }],
        rowLimitReached: true,
      },
    },
    ...overrides,
  };
}

describe("ApprovalDetail — READ", () => {
  it("헤더에 작업 라벨·출처 배지·시각·jobId 를 보여준다", () => {
    render(<ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(readProposal())} />);
    expect(screen.getByText("판매 조건 검색")).toBeInTheDocument();
    expect(screen.getByText("슬랙봇")).toBeInTheDocument();
    // 2026-09-22T05:30:00Z = KST 14:30
    expect(screen.getByText("09-22 14:30")).toBeInTheDocument();
    expect(screen.getByText("job-abc")).toBeInTheDocument();
  });

  it("조회 조건 칩은 값이 있는 항목만 그린다", () => {
    render(<ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(readProposal())} />);
    expect(screen.getByText("query: A")).toBeInTheDocument();
    expect(screen.queryByText(/^status:/)).not.toBeInTheDocument();
  });

  it("중첩된 조건 값은 JSON 으로 적는다 — [object Object] 는 조건을 감춘다", () => {
    const proposal = readProposal({
      structuredResult: {
        operation: "get_order_snapshot",
        jobId: null,
        query: { window: { startKey: "2026-09-01" }, campaignId: null },
        truncated: false,
        data: { items: [], rowLimitReached: false },
      },
    });
    render(<ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(proposal)} />);
    expect(screen.getByText('window: {"startKey":"2026-09-01"}')).toBeInTheDocument();
    expect(screen.queryByText(/campaignId/)).not.toBeInTheDocument();
  });

  it("행 상한에 걸린 기록은 그 사실을 고지한다", () => {
    render(<ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(readProposal())} />);
    expect(screen.getByText("상위 20건만 표시합니다.")).toBeInTheDocument();
  });

  it("결과가 상한을 넘어 잘린 기록은 표 대신 고지 문구를 보여준다", () => {
    const proposal = readProposal({
      structuredResult: {
        operation: "search_deals",
        jobId: null,
        query: {},
        truncated: true,
        data: { truncated: true, bytes: 120000 },
      },
    });
    render(<ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(proposal)} />);
    expect(
      screen.getByText("결과가 커서 표는 저장하지 않았습니다. 요약만 확인할 수 있습니다.")
    ).toBeInTheDocument();
  });

  it("봇 요약은 접어 둔다 — 화면의 주인공은 표다", () => {
    const { container } = render(
      <ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(readProposal())} />
    );
    expect(screen.getByText("봇 요약")).toBeInTheDocument();
    expect(container.querySelector("details")?.hasAttribute("open")).toBe(false);
  });

  it("결재함으로 돌아가는 링크가 있다", () => {
    render(<ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(readProposal())} />);
    const link = screen.getByRole("link", { name: "결재함" });
    expect(link).toHaveAttribute("href", "/approvals");
    expect(link.className).toContain("focus-visible:ring-focus-ring");
  });
});

describe("ApprovalDetail — 머리 없음(오너 디자인 방침 2026-10-21)", () => {
  it("기안 제목은 카드 안 첫 줄(h2)이고 되돌아가기 링크가 같은 줄 오른쪽에 있다", () => {
    const { container } = render(
      <ApprovalDetail id="proposal-read-1" useDetailHook={hookOf(readProposal())} />
    );
    const toolbar = screen.getByTestId("approval-detail-toolbar");
    const subject = screen.getByRole("heading", { level: 2, name: "판매 조건 검색 1건" });
    const link = screen.getByRole("link", { name: "결재함" });
    expect(toolbar.contains(subject)).toBe(true);
    expect(toolbar.lastElementChild).toBe(link);
    // 카드(ambient 컨테이너)의 첫 자식이 이 줄이다 — 카드 바깥 머리가 아니다.
    expect(container.querySelector(".shadow-ambient")?.firstElementChild).toBe(toolbar);
    expect(container.querySelector("header, h1")).toBeNull();
  });

  it("제목을 모르는 상태(없음)에서는 페이지 제목을 채우지 않고 링크만 둔다", () => {
    render(<ApprovalDetail id="gone" useDetailHook={hookOf(null)} />);
    const toolbar = screen.getByTestId("approval-detail-toolbar");
    expect(toolbar.querySelector("h1, h2")).toBeNull();
    expect(toolbar.contains(screen.getByRole("link", { name: "결재함" }))).toBe(true);
  });
});

describe("ApprovalDetail — WRITE", () => {
  it("기안 카드를 그대로 얹는다", () => {
    const proposal = readProposal({
      id: "proposal-write-1",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      structuredResult: null,
      resultSummary: null,
      title: "판매 조건 상태 변경",
    });
    render(<ApprovalDetail id="proposal-write-1" useDetailHook={hookOf(proposal)} />);
    expect(screen.getByTestId("proposal-card-mock")).toHaveTextContent("proposal-write-1");
    // 조회 결과 표면(조건 칩·봇 요약)은 WRITE 에 없다.
    expect(screen.queryByText("봇 요약")).not.toBeInTheDocument();
  });

  it("도구줄에 제목을 또 두지 않고(기안 카드가 그린다) 출처 배지·시각을 왼쪽에 둔다", () => {
    const proposal = readProposal({
      id: "proposal-write-1",
      kind: "WRITE",
      status: "PENDING_APPROVAL",
      structuredResult: null,
      resultSummary: null,
      title: "판매 조건 상태 변경",
      createdBy: "AGENT",
    });
    render(<ApprovalDetail id="proposal-write-1" useDetailHook={hookOf(proposal)} />);
    const toolbar = screen.getByTestId("approval-detail-toolbar");
    expect(toolbar.querySelector("h1, h2")).toBeNull();
    expect(screen.queryByText("판매 조건 상태 변경")).not.toBeInTheDocument();
    expect(toolbar).toHaveTextContent("어시스턴트");
    expect(toolbar.textContent).toMatch(/\d/);
    expect(toolbar.lastElementChild).toBe(screen.getByRole("link", { name: "결재함" }));
  });
});

describe("ApprovalDetail — 없음·로딩·실패", () => {
  it("없는 기안은 찾을 수 없다고 말하고 결재함으로 돌려보낸다", () => {
    render(<ApprovalDetail id="gone" useDetailHook={hookOf(null)} />);
    expect(screen.getByText("기안을 찾을 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "결재함" })).toHaveAttribute("href", "/approvals");
  });

  it("로딩 중에는 스켈레톤을 자리에 둔다(화면낭독기에는 말로 알린다)", () => {
    render(
      <ApprovalDetail
        id="loading"
        useDetailHook={hookOf(undefined as unknown as ApprovalDetailData, { isLoading: true })}
      />
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("불러오는 중")).toBeInTheDocument();
  });

  it("실패는 빈 결과와 다른 얼굴이다 — 경고 역할 + 다시 불러오기", () => {
    const refetch = vi.fn();
    render(
      <ApprovalDetail
        id="broken"
        useDetailHook={hookOf(undefined as unknown as ApprovalDetailData, {
          isError: true,
          refetch,
        })}
      />
    );
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeInTheDocument();
  });
});
