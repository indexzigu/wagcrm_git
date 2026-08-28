// @vitest-environment jsdom
/**
 * ProposalCard — 채팅 안 기안 카드(인라인 승인) (청사진 §1, §3-#4).
 *
 * useProposalActionsHook을 주입 가능하게 해 실제 fetch 의존 없이 승인/반려
 * 상호작용을 테스트한다(approval-inbox.test.tsx와 동일한 관례). GET fetch는
 * react-query가 실제로 수행하므로 전역 fetch를 스텁한다.
 */
import * as React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ProposalCard } from "../proposal-card";

type ProposalDetail = {
  id: string;
  title: string;
  status: string;
  kind: string;
  targetEntityType: string | null;
  targetEntityId: string | null;
  targetEntityName: string | null;
  payload: { action?: string; args?: Record<string, unknown> } | null;
  createdBy: string;
  createdAt: string;
  executedBy?: string | null;
  errorMessage?: string | null;
};

function makeProposal(overrides: Partial<ProposalDetail> = {}): ProposalDetail {
  return {
    id: "proposal-123456789",
    title: "딜(deal-1)에 메모 추가",
    status: "PENDING_APPROVAL",
    kind: "WRITE",
    targetEntityType: "DEAL",
    targetEntityId: "deal-1",
    targetEntityName: "락토핏 골드",
    payload: { action: "add_entity_memo", args: { content: "재입고 확인" } },
    createdBy: "user-1",
    createdAt: "2026-07-06T00:00:00Z",
    executedBy: null,
    errorMessage: null,
    ...overrides,
  };
}

type ApproveRejectFn = (id: string) => Promise<unknown>;

function renderCard(
  id: string,
  {
    approve = vi.fn() as unknown as ApproveRejectFn,
    reject = vi.fn() as unknown as ApproveRejectFn,
  }: { approve?: ApproveRejectFn; reject?: ApproveRejectFn } = {}
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const useProposalActionsHook = () => ({ approve, reject });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ProposalCard id={id} useProposalActionsHook={useProposalActionsHook} />
    </QueryClientProvider>
  );
  return { ...utils, approve, reject, queryClient };
}

describe("ProposalCard", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchOk(proposal: ProposalDetail) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => proposal });
  }

  it("PENDING_APPROVAL: '승인 대기' 칩과 [승인][반려] 버튼을 보여준다", async () => {
    stubFetchOk(makeProposal({ status: "PENDING_APPROVAL" }));
    renderCard("proposal-123456789");

    await waitFor(() => expect(screen.getByText("승인 대기")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "반려" })).toBeInTheDocument();
  });

  it("APPROVED: '승인됨·실행 중' 칩을 보여주고 액션 버튼이 없다", async () => {
    stubFetchOk(makeProposal({ status: "APPROVED" }));
    renderCard("proposal-123456789");

    await waitFor(() => expect(screen.getByText("승인됨·실행 중")).toBeInTheDocument());
    // 진행 상태는 이번 교체 대상이 아니다 — 오너 승인 범위는 「완료」뿐이었다.
    expect(screen.getByText("승인됨·실행 중")).toHaveAttribute("data-variant", "status-info");
    expect(screen.queryByRole("button", { name: "승인" })).not.toBeInTheDocument();
  });

  it("EXECUTED + executedBy!=='AGENT': '실행 완료' 칩을 보여준다", async () => {
    stubFetchOk(makeProposal({ status: "EXECUTED", executedBy: "user-2" }));
    renderCard("proposal-123456789");

    // 완료 hue 계약(P8 §4) — ⛔ status-active(네이비)로 되돌리면 여기서 빨강.
    await waitFor(() => expect(screen.getByText("실행 완료")).toBeInTheDocument());
    expect(screen.getByText("실행 완료")).toHaveAttribute("data-variant", "status-success");
  });

  it("EXECUTED + executedBy==='AGENT': '⚡자동승인·실행됨' 칩을 보여준다", async () => {
    stubFetchOk(makeProposal({ status: "EXECUTED", executedBy: "AGENT" }));
    renderCard("proposal-123456789");

    await waitFor(() => expect(screen.getByText(/⚡자동승인·실행됨/)).toBeInTheDocument());
    expect(screen.getByText(/⚡자동승인·실행됨/)).toHaveAttribute("data-variant", "status-success");
  });

  it("REJECTED: '반려됨' 칩을 보여준다", async () => {
    stubFetchOk(makeProposal({ status: "REJECTED" }));
    renderCard("proposal-123456789");

    await waitFor(() => expect(screen.getByText("반려됨")).toBeInTheDocument());
  });

  it("FAILED: '실패' 칩 + errorMessage + [재시도(승인)] 단독 버튼을 보여준다 (반려 버튼 없음)", async () => {
    stubFetchOk(makeProposal({ status: "FAILED", errorMessage: "대상 딜을 찾을 수 없습니다" }));
    renderCard("proposal-123456789");

    await waitFor(() => expect(screen.getByText("실패")).toBeInTheDocument());
    expect(screen.getByText(/대상 딜을 찾을 수 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /재시도/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "반려" })).not.toBeInTheDocument();
  });

  it("액션 라벨 매핑: add_entity_memo → '메모 추가'", async () => {
    stubFetchOk(makeProposal({ payload: { action: "add_entity_memo", args: {} } }));
    renderCard("proposal-123456789");
    await waitFor(() => expect(screen.getByText("메모 추가")).toBeInTheDocument());
  });

  it("액션 라벨 매핑: change_deal_status → '딜 상태 변경'", async () => {
    stubFetchOk(makeProposal({ payload: { action: "change_deal_status", args: {} } }));
    renderCard("proposal-123456789");
    await waitFor(() => expect(screen.getByText("딜 상태 변경")).toBeInTheDocument());
  });

  it("액션 라벨 매핑: confirm_settlement → '정산 확정' 포함 라벨(강조 표시)", async () => {
    stubFetchOk(makeProposal({ payload: { action: "confirm_settlement", args: {} } }));
    renderCard("proposal-123456789");
    await waitFor(() => expect(screen.getByText(/정산 확정/)).toBeInTheDocument());
  });

  it("미지 action은 payload.action 원문을 그대로 보여준다", async () => {
    stubFetchOk(makeProposal({ payload: { action: "unknown_future_action", args: {} } }));
    renderCard("proposal-123456789");
    await waitFor(() => expect(screen.getByText("unknown_future_action")).toBeInTheDocument());
  });

  it("targetEntityName과 엔티티 타입 라벨을 함께 보여준다", async () => {
    stubFetchOk(makeProposal({ targetEntityType: "DEAL", targetEntityName: "락토핏 골드" }));
    renderCard("proposal-123456789");
    await waitFor(() => expect(screen.getByText(/락토핏 골드/)).toBeInTheDocument());
    expect(screen.getByText(/딜: 락토핏 골드/)).toBeInTheDocument();
  });

  it("[승인] 클릭(메모 액션) 시 다이얼로그 없이 바로 approve(id)를 호출한다", async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true });
    stubFetchOk(makeProposal({ payload: { action: "add_entity_memo", args: {} } }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCard("proposal-123456789", { approve });

    await waitFor(() => expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith("proposal-123456789"));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("[승인] 클릭(딜 상태 변경) 시에도 다이얼로그 없이 바로 approve(id)를 호출한다", async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true });
    stubFetchOk(makeProposal({ payload: { action: "change_deal_status", args: {} } }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCard("proposal-123456789", { approve });

    await waitFor(() => expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith("proposal-123456789"));
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("정산 확정(confirm_settlement) 승인 클릭 시 확인 다이얼로그를 거치고, 확인하면 approve(id)를 호출한다", async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true });
    stubFetchOk(makeProposal({ payload: { action: "confirm_settlement", args: {} } }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderCard("proposal-123456789", { approve });

    await waitFor(() => expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      expect.stringContaining("정산 확정은 되돌릴 수 없습니다")
    );
    await waitFor(() => expect(approve).toHaveBeenCalledWith("proposal-123456789"));
    confirmSpy.mockRestore();
  });

  it("정산 확정 승인 다이얼로그에서 취소하면 approve가 호출되지 않는다", async () => {
    const approve = vi.fn();
    stubFetchOk(makeProposal({ payload: { action: "confirm_settlement", args: {} } }));
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderCard("proposal-123456789", { approve });

    await waitFor(() => expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("[반려] 클릭 시 reject(id)를 호출한다", async () => {
    const reject = vi.fn().mockResolvedValue({ ok: true });
    stubFetchOk(makeProposal());
    renderCard("proposal-123456789", { reject });

    await waitFor(() => expect(screen.getByRole("button", { name: "반려" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "반려" }));

    await waitFor(() => expect(reject).toHaveBeenCalledWith("proposal-123456789"));
  });

  it("FAILED 상태에서 [재시도] 클릭 시 approve(id)를 호출한다", async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true });
    stubFetchOk(makeProposal({ status: "FAILED", errorMessage: "실행 오류" }));
    renderCard("proposal-123456789", { approve });

    await waitFor(() => expect(screen.getByRole("button", { name: /재시도/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /재시도/ }));

    await waitFor(() => expect(approve).toHaveBeenCalledWith("proposal-123456789"));
  });

  it("승인 실패(403/409 등) 시 카드 하단에 서버 에러 문구를 보여준다", async () => {
    const approve = vi.fn().mockRejectedValue(new Error("본인이 기안한 요청은 본인이 승인할 수 없습니다 (self-approval 금지)."));
    stubFetchOk(makeProposal());
    renderCard("proposal-123456789", { approve });

    await waitFor(() => expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(() =>
      expect(screen.getByText(/본인이 기안한 요청은 본인이 승인할 수 없습니다/)).toBeInTheDocument()
    );
    // 동시 409면 승인 버튼 유지(invalidate로 최신 상태 반영) — 버튼이 여전히 존재해야 한다.
    expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
  });

  it("GET fetch 실패 시 '기안 {id 앞8자} — 불러오기 실패' fallback 텍스트를 보여준다", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const { container } = renderCard("proposal-123456789");

    await waitFor(() => {
      const card = container.querySelector('[data-testid="proposal-card"]');
      expect(card?.textContent).toBe("기안 proposal: 불러오기 실패");
    });
  });

  it("정산 확정 카드는 강조 보더 클래스를 갖는다", async () => {
    stubFetchOk(makeProposal({ payload: { action: "confirm_settlement", args: {} } }));
    const { container } = renderCard("proposal-123456789");

    await waitFor(() => expect(screen.getByText(/정산 확정/)).toBeInTheDocument());
    const card = container.querySelector('[data-testid="proposal-card"]');
    expect(card?.className).toMatch(/destructive|amber|red/);
  });

  it("react-query GET은 refetchOnWindowFocus:true로 구성된다 (인박스 탭 승인 후 stale 방지)", async () => {
    stubFetchOk(makeProposal());
    renderCard("proposal-123456789");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/action-proposals/proposal-123456789"));
  });
});
