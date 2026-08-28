// @vitest-environment jsdom
/**
 * ApprovalInbox — 승인 대기함 UI (청사진 §2, G3).
 *
 * 훅 주입 패턴(useApprovalInboxHook)으로
 * 실제 fetch/react-query 의존 없이 렌더링/상호작용을 테스트한다.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalInbox } from "../approval-inbox";
import type { ApprovalInboxItem } from "../approval-inbox";

function makeItem(overrides: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    id: "proposal-1",
    title: "딜(deal-1)에 메모 추가",
    status: "PENDING_APPROVAL",
    kind: "WRITE",
    targetEntityType: "DEAL",
    targetEntityId: "deal-1",
    targetEntityName: "락토핏 골드",
    payload: { action: "add_entity_memo", args: { entityType: "DEAL", entityId: "deal-1", content: "재입고 확인" } },
    createdBy: "user-1",
    createdAt: "2026-07-06T00:00:00Z",
    errorMessage: null,
    ...overrides,
  };
}

describe("ApprovalInbox", () => {
  const approveMock = vi.fn();
  const rejectMock = vi.fn();
  const refetchMock = vi.fn();

  beforeEach(() => {
    approveMock.mockReset();
    rejectMock.mockReset();
    refetchMock.mockReset();
  });

  function useApprovalInboxHookStub(items: ApprovalInboxItem[], isLoading = false) {
    return () => ({
      items,
      count: items.length,
      isLoading,
      approve: approveMock,
      reject: rejectMock,
      refetch: refetchMock,
    });
  }

  it("승인 대기 항목이 없으면 빈 상태 문구를 보여준다", () => {
    render(<ApprovalInbox useApprovalInboxHook={useApprovalInboxHookStub([])} />);
    expect(screen.getByText(/승인 대기 중인 요청이 없습니다/)).toBeInTheDocument();
  });

  it("항목의 대상 엔티티명·기안자·payload 요약을 보여준다", () => {
    render(
      <ApprovalInbox
        useApprovalInboxHook={useApprovalInboxHookStub([makeItem()])}
      />
    );

    expect(screen.getByText(/락토핏 골드/)).toBeInTheDocument();
    expect(screen.getByText(/재입고 확인/)).toBeInTheDocument();
  });

  it("[승인 및 실행] 클릭 시 approve(id)를 호출한다", async () => {
    approveMock.mockResolvedValue({ ok: true });
    render(
      <ApprovalInbox
        useApprovalInboxHook={useApprovalInboxHookStub([makeItem()])}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /승인 및 실행/ }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledWith("proposal-1");
    });
  });

  it("[반려] 클릭 시 reject(id)를 호출한다", async () => {
    rejectMock.mockResolvedValue({ ok: true });
    render(
      <ApprovalInbox
        useApprovalInboxHook={useApprovalInboxHookStub([makeItem()])}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "반려" }));

    await waitFor(() => {
      expect(rejectMock).toHaveBeenCalledWith("proposal-1");
    });
  });

  it("버튼 중복 클릭을 방지한다 (로컬 pending 상태로 두 번째 클릭 무시)", async () => {
    let resolveApprove: (() => void) | undefined;
    approveMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveApprove = resolve;
      })
    );

    render(
      <ApprovalInbox
        useApprovalInboxHook={useApprovalInboxHookStub([makeItem()])}
      />
    );

    const approveButton = screen.getByRole("button", { name: /승인 및 실행/ });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    expect(approveMock).toHaveBeenCalledTimes(1);
    resolveApprove?.();
  });

  it("M1: 승인 실패(409/500/502 등) 시 pending이 해제되어 버튼이 재활성화되고 에러 문구가 뜬다", async () => {
    approveMock.mockRejectedValue(new Error("이미 처리된 기안입니다 (동시 요청)."));

    render(
      <ApprovalInbox useApprovalInboxHook={useApprovalInboxHookStub([makeItem()])} />
    );

    const approveButton = screen.getByRole("button", { name: /승인 및 실행/ });
    fireEvent.click(approveButton);

    // 실패 후 버튼이 다시 활성화되어야 한다 (영구 고착 금지).
    await waitFor(() => {
      expect(approveButton).not.toBeDisabled();
    });

    expect(screen.getByText(/이미 처리된 기안입니다/)).toBeInTheDocument();

    // 재클릭이 다시 가능해야 한다 — 두 번째 클릭이 approve를 또 호출한다.
    approveMock.mockResolvedValueOnce({ ok: true });
    fireEvent.click(approveButton);
    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledTimes(2);
    });
  });

  it("M1: 반려 실패 시에도 pending이 해제되어 버튼이 재활성화되고 에러 문구가 뜬다", async () => {
    rejectMock.mockRejectedValue(new Error("반려 처리 중 서버 오류가 발생했습니다."));

    render(
      <ApprovalInbox useApprovalInboxHook={useApprovalInboxHookStub([makeItem()])} />
    );

    const rejectButton = screen.getByRole("button", { name: "반려" });
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(rejectButton).not.toBeDisabled();
    });

    expect(screen.getByText(/반려 처리 중 서버 오류가 발생했습니다/)).toBeInTheDocument();
  });

  it("실행 실패(errorMessage 있음) 항목은 에러 메시지를 인라인으로 보여준다", () => {
    render(
      <ApprovalInbox
        useApprovalInboxHook={useApprovalInboxHookStub([
          makeItem({ status: "FAILED", errorMessage: "대상 딜을 찾을 수 없습니다" }),
        ])}
      />
    );

    expect(screen.getByText(/대상 딜을 찾을 수 없습니다/)).toBeInTheDocument();
  });

  it("로딩 중에는 로딩 표시를 보여준다", () => {
    render(
      <ApprovalInbox useApprovalInboxHook={useApprovalInboxHookStub([], true)} />
    );
    expect(screen.getByText(/불러오는 중/)).toBeInTheDocument();
  });

  // §6-1/§6-3 v1.2 추가: 상태 탭 4개(대기/완료/실패/반려).
  describe("상태 탭 (§6-1)", () => {
    // status별 items를 반환하는 스텁 — 탭 전환 시 useApprovalInboxHook(status)가 호출되어
    // 해당 status의 데이터를 돌려준다(실제 훅의 react-query 캐시 전환을 시뮬레이션).
    function useApprovalInboxHookStubByStatus(
      itemsByStatus: Partial<Record<string, ApprovalInboxItem[]>>
    ) {
      return (status: string = "PENDING_APPROVAL") => {
        const items = itemsByStatus[status] ?? [];
        return {
          items,
          count: items.length,
          isLoading: false,
          approve: approveMock,
          reject: rejectMock,
          refetch: refetchMock,
        };
      };
    }

    it("탭 4개(대기/완료/실패/반려)가 렌더된다", () => {
      render(<ApprovalInbox useApprovalInboxHook={useApprovalInboxHookStubByStatus({})} />);
      expect(screen.getByRole("tab", { name: "대기" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "완료" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "실패" })).toBeInTheDocument();
      expect(screen.getByRole("tab", { name: "반려" })).toBeInTheDocument();
    });

    it("기본 활성 탭은 대기(PENDING_APPROVAL)이다", () => {
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            PENDING_APPROVAL: [makeItem()],
          })}
        />
      );
      expect(screen.getByRole("tab", { name: "대기" })).toHaveAttribute("aria-selected", "true");
      expect(screen.getByText(/재입고 확인/)).toBeInTheDocument();
    });

    it("완료 탭 클릭 시 EXECUTED 항목으로 전환된다", () => {
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            EXECUTED: [
              makeItem({
                status: "EXECUTED",
                title: "완료된 메모 추가",
                payload: { action: "add_entity_memo", args: {} },
              }),
            ],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "완료" }));
      expect(screen.getByText("완료된 메모 추가")).toBeInTheDocument();
    });

    it("완료 탭에서 executedBy==='AGENT'면 ⚡자동승인 표기를 보여준다", () => {
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            EXECUTED: [makeItem({ status: "EXECUTED", executedBy: "AGENT" })],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "완료" }));
      expect(screen.getByText(/⚡자동승인/)).toBeInTheDocument();
      // 완료 hue 계약(P8 §4) — ⛔ status-active(네이비)로 되돌리면 여기서 빨강.
      expect(screen.getByText(/⚡자동승인/)).toHaveAttribute("data-variant", "status-success");
    });

    it("완료 탭에서 executedBy가 사람이면 '실행 완료'를 보여준다 (⚡ 아님)", () => {
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            EXECUTED: [makeItem({ status: "EXECUTED", executedBy: "user-2" })],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "완료" }));
      expect(screen.getByText("실행 완료")).toBeInTheDocument();
      expect(screen.getByText("실행 완료")).toHaveAttribute("data-variant", "status-success");
      expect(screen.queryByText(/⚡자동승인/)).not.toBeInTheDocument();
    });

    it("실패 탭 클릭 시 errorMessage와 [재시도(승인)] 버튼을 보여준다", () => {
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            FAILED: [makeItem({ status: "FAILED", errorMessage: "대상 딜을 찾을 수 없습니다" })],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "실패" }));
      expect(screen.getByText(/대상 딜을 찾을 수 없습니다/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /재시도/ })).toBeInTheDocument();
    });

    it("실패 탭 [재시도(승인)] 클릭(메모 액션) 시 다이얼로그 없이 approve(id)를 호출한다", async () => {
      approveMock.mockResolvedValue({ ok: true });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            FAILED: [
              makeItem({
                status: "FAILED",
                errorMessage: "실행 오류",
                payload: { action: "add_entity_memo", args: {} },
              }),
            ],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "실패" }));
      fireEvent.click(screen.getByRole("button", { name: /재시도/ }));

      await waitFor(() => {
        expect(approveMock).toHaveBeenCalledWith("proposal-1");
      });
      expect(confirmSpy).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("실패 탭에서 confirm_settlement 재시도는 확인 다이얼로그를 거치고, 확인하면 approve(id)를 호출한다", async () => {
      approveMock.mockResolvedValue({ ok: true });
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            FAILED: [
              makeItem({
                status: "FAILED",
                errorMessage: "정산 확정 실행 오류",
                payload: { action: "confirm_settlement", args: {} },
              }),
            ],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "실패" }));
      fireEvent.click(screen.getByRole("button", { name: /재시도/ }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("정산 확정은 되돌릴 수 없습니다"));
      await waitFor(() => {
        expect(approveMock).toHaveBeenCalledWith("proposal-1");
      });
      confirmSpy.mockRestore();
    });

    it("실패 탭에서 confirm_settlement 재시도 다이얼로그를 취소하면 approve가 호출되지 않는다", async () => {
      const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            FAILED: [
              makeItem({
                status: "FAILED",
                errorMessage: "정산 확정 실행 오류",
                payload: { action: "confirm_settlement", args: {} },
              }),
            ],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "실패" }));
      fireEvent.click(screen.getByRole("button", { name: /재시도/ }));

      expect(confirmSpy).toHaveBeenCalled();
      expect(approveMock).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it("반려 탭은 읽기 전용이다 — 승인/반려/재시도 버튼이 없다", () => {
      render(
        <ApprovalInbox
          useApprovalInboxHook={useApprovalInboxHookStubByStatus({
            REJECTED: [makeItem({ status: "REJECTED" })],
          })}
        />
      );
      fireEvent.click(screen.getByRole("tab", { name: "반려" }));
      expect(screen.getByText(/반려됨/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /승인/ })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "반려" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /재시도/ })).not.toBeInTheDocument();
    });

    it("각 탭이 비어있으면 탭별 빈 상태 문구를 보여준다", () => {
      render(<ApprovalInbox useApprovalInboxHook={useApprovalInboxHookStubByStatus({})} />);
      fireEvent.click(screen.getByRole("tab", { name: "완료" }));
      expect(screen.getByText(/완료된 요청이 없습니다/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "실패" }));
      expect(screen.getByText(/실패한 요청이 없습니다/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole("tab", { name: "반려" }));
      expect(screen.getByText(/반려된 요청이 없습니다/)).toBeInTheDocument();
    });
  });
});
