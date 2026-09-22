// @vitest-environment jsdom
/**
 * approval-cards — 결재함 카드 4종 (Plan 2 Task 3).
 *
 * Task 2까지의 `ApprovalInbox`(탭 포함 패널)에서 카드만 떼어낸 것이다 — 탭·빈
 * 상태·로딩 표시는 결재함 허브(Task 4, /approvals)가 소유하므로 여기서는 각 카드를
 * 직접 렌더해 검증한다. M1 Promise 계약(await + finally + mountedRef)은 그대로다.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PendingCard,
  ExecutedCard,
  FailedCard,
  RejectedCard,
} from "../approval-cards";
import type { ApprovalInboxItem } from "../approval-cards";
import { SourceBadge } from "../source-badge";

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

describe("SourceBadge", () => {
  it.each([
    ["AGENT_WORKER", "슬랙봇"],
    ["AGENT", "어시스턴트"],
    ["3f2a-uuid", "직접"],
  ])("%s → %s", (createdBy, label) => {
    render(<SourceBadge createdBy={createdBy} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe("PendingCard", () => {
  const approveMock = vi.fn();
  const rejectMock = vi.fn();

  beforeEach(() => {
    approveMock.mockReset();
    rejectMock.mockReset();
  });

  it("항목의 대상 엔티티명·출처 배지·payload 요약을 보여준다", () => {
    render(
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
    );

    expect(screen.getByText(/락토핏 골드/)).toBeInTheDocument();
    expect(screen.getByText(/재입고 확인/)).toBeInTheDocument();
    // 기안자 원문(user-1) 대신 SourceBadge 출처 라벨을 보여준다.
    expect(screen.getByText("직접")).toBeInTheDocument();
    expect(screen.queryByText(/기안자:/)).not.toBeInTheDocument();
  });

  it("대기 카드 버튼 라벨은 승인·반려다", () => {
    render(
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
    );
    expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "반려" })).toBeInTheDocument();
  });

  it("[승인] 클릭 시 approve(id)를 호출한다", async () => {
    approveMock.mockResolvedValue({ ok: true });
    render(
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
    );

    fireEvent.click(screen.getByRole("button", { name: "승인" }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledWith("proposal-1");
    });
  });

  it("[반려] 클릭 시 reject(id)를 호출한다", async () => {
    rejectMock.mockResolvedValue({ ok: true });
    render(
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
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
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
    );

    const approveButton = screen.getByRole("button", { name: "승인" });
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);
    fireEvent.click(approveButton);

    expect(approveMock).toHaveBeenCalledTimes(1);
    resolveApprove?.();
  });

  it("M1: 승인 실패(409/500/502 등) 시 pending이 해제되어 버튼이 재활성화되고 에러 문구가 뜬다", async () => {
    approveMock.mockRejectedValue(new Error("이미 처리된 기안입니다 (동시 요청)."));

    render(
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
    );

    const approveButton = screen.getByRole("button", { name: "승인" });
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
      <ul>
        <PendingCard item={makeItem()} onApprove={approveMock} onReject={rejectMock} />
      </ul>
    );

    const rejectButton = screen.getByRole("button", { name: "반려" });
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(rejectButton).not.toBeDisabled();
    });

    expect(screen.getByText(/반려 처리 중 서버 오류가 발생했습니다/)).toBeInTheDocument();
  });
});

describe("ExecutedCard", () => {
  it("완료 카드의 자동승인 표기는 이모지 없이 아이콘+글자다", () => {
    render(
      <ul>
        <ExecutedCard item={makeItem({ status: "EXECUTED", executedBy: "AGENT" })} />
      </ul>
    );
    expect(screen.getByText("자동승인")).toBeInTheDocument();
    expect(screen.queryByText(/⚡/)).toBeNull();
    // 완료 hue 계약(P8 §4) — ⛔ status-active(네이비)로 되돌리면 여기서 빨강.
    expect(screen.getByText("자동승인")).toHaveAttribute("data-variant", "status-success");
  });

  it("executedBy가 사람이면 '실행 완료'를 보여준다 (자동승인 아님)", () => {
    render(
      <ul>
        <ExecutedCard item={makeItem({ status: "EXECUTED", executedBy: "user-2" })} />
      </ul>
    );
    expect(screen.getByText("실행 완료")).toBeInTheDocument();
    expect(screen.getByText("실행 완료")).toHaveAttribute("data-variant", "status-success");
    expect(screen.queryByText("자동승인")).not.toBeInTheDocument();
  });
});

describe("FailedCard", () => {
  const approveMock = vi.fn();

  beforeEach(() => {
    approveMock.mockReset();
  });

  it("errorMessage와 [재시도] 버튼을 보여준다", () => {
    render(
      <ul>
        <FailedCard
          item={makeItem({ status: "FAILED", errorMessage: "대상 딜을 찾을 수 없습니다" })}
          onApprove={approveMock}
        />
      </ul>
    );
    expect(screen.getByText(/대상 딜을 찾을 수 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "재시도" })).toBeInTheDocument();
  });

  it("[재시도] 클릭(메모 액션) 시 다이얼로그 없이 approve(id)를 호출한다", async () => {
    approveMock.mockResolvedValue({ ok: true });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ul>
        <FailedCard
          item={makeItem({
            status: "FAILED",
            errorMessage: "실행 오류",
            payload: { action: "add_entity_memo", args: {} },
          })}
          onApprove={approveMock}
        />
      </ul>
    );
    fireEvent.click(screen.getByRole("button", { name: "재시도" }));

    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledWith("proposal-1");
    });
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("confirm_settlement 재시도는 확인 다이얼로그를 거치고, 확인하면 approve(id)를 호출한다", async () => {
    approveMock.mockResolvedValue({ ok: true });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <ul>
        <FailedCard
          item={makeItem({
            status: "FAILED",
            errorMessage: "정산 확정 실행 오류",
            payload: { action: "confirm_settlement", args: {} },
          })}
          onApprove={approveMock}
        />
      </ul>
    );
    fireEvent.click(screen.getByRole("button", { name: "재시도" }));

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("정산 확정은 되돌릴 수 없습니다"));
    await waitFor(() => {
      expect(approveMock).toHaveBeenCalledWith("proposal-1");
    });
    confirmSpy.mockRestore();
  });

  it("confirm_settlement 재시도 다이얼로그를 취소하면 approve가 호출되지 않는다", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(
      <ul>
        <FailedCard
          item={makeItem({
            status: "FAILED",
            errorMessage: "정산 확정 실행 오류",
            payload: { action: "confirm_settlement", args: {} },
          })}
          onApprove={approveMock}
        />
      </ul>
    );
    fireEvent.click(screen.getByRole("button", { name: "재시도" }));

    expect(confirmSpy).toHaveBeenCalled();
    expect(approveMock).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe("RejectedCard", () => {
  it("읽기 전용이다 — 승인/반려/재시도 버튼이 없다", () => {
    render(
      <ul>
        <RejectedCard item={makeItem({ status: "REJECTED" })} />
      </ul>
    );
    expect(screen.getByText(/반려됨/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /승인/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "반려" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /재시도/ })).not.toBeInTheDocument();
  });
});
