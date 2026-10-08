// @vitest-environment jsdom
/**
 * 결재함 대기 탭 일괄 승인 (`pending-bulk-list.tsx`) — 허브에 스텁 훅을 주입해 검증한다
 * (`approval-hub.test.tsx` 와 같은 관례, 네트워크 없음).
 *
 * ① 대기 카드마다 이름 있는 체크박스가 있고, 「현재 페이지 전체 선택」이 전부 고르고 푼다
 * ② 0건이면 승인 버튼이 꺼져 있고, 고르면 「선택한 N건 승인」이 된다
 * ③ 확인 창: 종류별 건수 · CRM 데이터 변경 경고 · (정산 확정이면) 되돌릴 수 없음 경고
 * ④ 취소하면 아무것도 보내지 않는다
 * ⑤ 승인하면 화면 순서대로 id 를 넘기고, 진행률을 보이고, 끝나면 결과 요약(실행·실패·건너뜀)
 * ⑥ 일괄 승인 훅이 없는 스텁(종전)은 체크박스 없이 종전 화면을 그린다
 */
import { render, screen, fireEvent, within, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ApprovalHub } from "../approval-hub";
import type { ApprovalHubHooks } from "../approval-hub";
import type { ApprovalInboxItem } from "../approval-cards";
import type { BulkApproveFn } from "../approval-hub-types";
import type { BulkApproveResponse } from "@/lib/action-proposal-bulk";
import { summarizeByAction } from "../pending-bulk-list";

function makeProposal(overrides: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    id: "p1",
    title: "딜에 메모 추가",
    status: "PENDING_APPROVAL",
    kind: "WRITE",
    targetEntityType: "DEAL",
    targetEntityId: "deal-1",
    targetEntityName: "테스트 딜",
    payload: { action: "add_entity_memo", args: { content: "재입고 확인" } },
    createdBy: "AGENT_WORKER",
    createdAt: "2026-10-08T05:30:00Z",
    errorMessage: null,
    ...overrides,
  };
}

const ITEMS: ApprovalInboxItem[] = [
  makeProposal({ id: "m1", title: "메모 1", payload: { action: "add_entity_memo", args: { content: "메모 하나" } } }),
  makeProposal({ id: "p1", title: "거래처 등록: 새 브랜드", payload: { action: "create_partner", args: { name: "새 브랜드" } } }),
  makeProposal({ id: "m2", title: "메모 2", payload: { action: "add_entity_memo", args: { content: "메모 둘" } } }),
  makeProposal({ id: "m3", title: "메모 3", payload: { action: "add_entity_memo", args: { content: "메모 셋" } } }),
];

function makeHooks(items: ApprovalInboxItem[], approveMany?: BulkApproveFn): ApprovalHubHooks {
  const base = { isLoading: false, isError: false, refetch: vi.fn() };
  return {
    useTab: () => "pending",
    useApprovalInbox: () => ({
      ...base,
      items,
      count: items.length,
      approve: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
      ...(approveMany ? { approveMany } : {}),
      loadMore: vi.fn(),
      isLoadingMore: false,
      hasMore: false,
    }),
    useReadRecords: () => ({ ...base, items: [], count: 0, loadMore: vi.fn(), isLoadingMore: false, hasMore: false }),
    useAgentJobs: () => ({ ...base, items: [], loadMore: vi.fn(), isLoadingMore: false, hasMore: false }),
  };
}

function rowCheckbox(title: string): HTMLInputElement {
  return screen.getByRole("checkbox", { name: `${title} 선택` }) as HTMLInputElement;
}

describe("결재함 대기 탭 — 일괄 승인", () => {
  it("① 카드마다 이름 있는 체크박스가 있고 전체 선택이 고르고 푼다", () => {
    render(<ApprovalHub hooks={makeHooks(ITEMS, vi.fn())} />);

    for (const item of ITEMS) expect(rowCheckbox(item.title)).not.toBeChecked();

    const selectAll = screen.getByRole("checkbox", { name: /현재 페이지 전체 선택/ });
    fireEvent.click(selectAll);
    for (const item of ITEMS) expect(rowCheckbox(item.title)).toBeChecked();
    expect(screen.getByRole("button", { name: "선택한 4건 승인" })).toBeEnabled();

    fireEvent.click(selectAll);
    for (const item of ITEMS) expect(rowCheckbox(item.title)).not.toBeChecked();
  });

  it("② 0건이면 승인 버튼이 꺼져 있고, 일부만 고르면 전체 선택이 반쯤 찬 상태가 된다", () => {
    render(<ApprovalHub hooks={makeHooks(ITEMS, vi.fn())} />);

    expect(screen.getByRole("button", { name: "선택한 0건 승인" })).toBeDisabled();
    fireEvent.click(rowCheckbox("메모 2"));
    expect(screen.getByRole("button", { name: "선택한 1건 승인" })).toBeEnabled();
    const selectAll = screen.getByRole("checkbox", { name: /현재 페이지 전체 선택/ }) as HTMLInputElement;
    expect(selectAll.indeterminate).toBe(true);
    expect(selectAll).not.toBeChecked();
  });

  it("③ 확인 창은 종류별 건수와 CRM 데이터 변경 경고를 보여 준다 · ④ 취소하면 보내지 않는다", async () => {
    const approveMany = vi.fn();
    render(<ApprovalHub hooks={makeHooks(ITEMS, approveMany)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /현재 페이지 전체 선택/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택한 4건 승인" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("선택한 기안 4건 승인")).toBeInTheDocument();
    expect(within(dialog).getByText(/CRM 데이터가 바뀝니다/)).toBeInTheDocument();
    const kinds = within(dialog).getByRole("list", { name: "승인할 기안 종류" });
    const rows = within(kinds).getAllByRole("listitem").map((row) => row.textContent);
    expect(rows).toEqual(["메모 추가3건", "거래처 등록1건"]);
    expect(within(dialog).queryByText(/정산 확정/)).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(approveMany).not.toHaveBeenCalled();
  });

  it("③-b 정산 확정이 섞이면 되돌릴 수 없다는 경고를 건수와 함께 보여 준다", async () => {
    const items = [
      ...ITEMS.slice(0, 1),
      makeProposal({ id: "s1", title: "정산 확정: 캠페인", payload: { action: "confirm_settlement", args: {} } }),
    ];
    render(<ApprovalHub hooks={makeHooks(items, vi.fn())} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /현재 페이지 전체 선택/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택한 2건 승인" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/정산 확정 1건이 포함돼 있습니다/)).toBeInTheDocument();
  });

  it("⑤ 승인하면 화면 순서대로 id 를 넘기고, 진행률을 보이고, 끝나면 결과 요약을 보여 준다", async () => {
    let resolveRun: (value: BulkApproveResponse) => void = () => {};
    let reportProgress: ((done: number, total: number) => void) | undefined;
    const approveMany = vi.fn<BulkApproveFn>((_ids, options) => {
      reportProgress = options?.onProgress;
      return new Promise<BulkApproveResponse>((resolve) => {
        resolveRun = resolve;
      });
    });
    render(<ApprovalHub hooks={makeHooks(ITEMS, approveMany)} />);

    // 화면 순서와 다르게 고른다 — 넘기는 순서는 고른 순서가 아니라 화면 순서다.
    fireEvent.click(rowCheckbox("메모 3"));
    fireEvent.click(rowCheckbox("메모 1"));
    fireEvent.click(rowCheckbox("거래처 등록: 새 브랜드"));
    fireEvent.click(screen.getByRole("button", { name: "선택한 3건 승인" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "3건 승인" }));

    await waitFor(() => expect(approveMany).toHaveBeenCalledTimes(1));
    expect(approveMany.mock.calls[0][0]).toEqual(["m1", "p1", "m3"]);

    const progress = await screen.findByRole("progressbar", { name: "일괄 승인 진행" });
    expect(progress).toHaveAttribute("aria-valuenow", "0");
    expect(progress.parentElement).toBe(document.activeElement);
    act(() => reportProgress?.(2, 3));
    expect(progress).toHaveAttribute("aria-valuenow", "2");
    expect(screen.getByText("3건 중 2건 처리")).toBeInTheDocument();

    await act(async () => {
      resolveRun({
        results: [
          { id: "m1", ok: true, outcome: "executed", status: "EXECUTED" },
          { id: "p1", ok: false, outcome: "failed", status: "FAILED", error: "실행 실패: 중복 거래처" },
          { id: "m3", ok: false, outcome: "skipped", status: "EXECUTED", error: "다른 요청이 먼저 처리했습니다." },
        ],
        counts: { total: 3, executed: 1, failed: 1, skipped: 1 },
      });
    });

    const resultDialog = await screen.findByRole("alertdialog");
    await within(resultDialog).findByText("일괄 승인 결과");
    expect(within(resultDialog).getByRole("status").textContent).toBe("승인·실행 1건 · 실패 1건 · 건너뜀 1건");
    // 실패·건너뜀은 기안 제목과 사유를 함께 보여 준다(id 가 아니라).
    expect(within(resultDialog).getByText("거래처 등록: 새 브랜드")).toBeInTheDocument();
    expect(within(resultDialog).getByText(/실행 실패: 중복 거래처/)).toBeInTheDocument();
    expect(within(resultDialog).getByText(/다른 요청이 먼저 처리했습니다/)).toBeInTheDocument();
    expect(within(resultDialog).getByRole("link", { name: "실패 탭" })).toHaveAttribute(
      "href",
      "/approvals?tab=failed"
    );

    // 누른 버튼이 사라진 뒤에도 초점이 창 안에 남는다(결과 단계 = 닫기 버튼).
    expect(document.activeElement).toBe(within(resultDialog).getByRole("button", { name: "닫기" }));

    fireEvent.click(within(resultDialog).getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    // 닫으면 선택을 비운다.
    expect(screen.getByRole("button", { name: "선택한 0건 승인" })).toBeDisabled();
  });

  it("⑤-b 승인 뒤 목록이 비어도(전부 대기에서 빠짐) 결과 창이 남는다", async () => {
    const approveMany = vi.fn<BulkApproveFn>(async () => ({
      results: ITEMS.map((item) => ({ id: item.id, ok: true, outcome: "executed" as const, status: "EXECUTED" })),
      counts: { total: ITEMS.length, executed: ITEMS.length, failed: 0, skipped: 0 },
    }));
    const { rerender } = render(<ApprovalHub hooks={makeHooks(ITEMS, approveMany)} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /현재 페이지 전체 선택/ }));
    fireEvent.click(screen.getByRole("button", { name: "선택한 4건 승인" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "4건 승인" }));
    await screen.findByText("일괄 승인 결과");

    // 무효화 뒤 다시 받은 대기 목록이 비었다.
    rerender(<ApprovalHub hooks={makeHooks([], approveMany)} />);

    expect(screen.getByText("일괄 승인 결과")).toBeInTheDocument();
    expect(within(screen.getByRole("alertdialog")).getByRole("status").textContent).toBe(
      "승인·실행 4건 · 실패 0건 · 건너뜀 0건"
    );
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(screen.getByText("승인할 기안이 없습니다.")).toBeInTheDocument();
  });

  it("⑥ 일괄 승인 훅이 없는 스텁은 체크박스 없이 종전 대기 카드를 그린다", () => {
    render(<ApprovalHub hooks={makeHooks(ITEMS)} />);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("button", { name: "승인" })).toHaveLength(ITEMS.length);
  });
});

describe("summarizeByAction", () => {
  it("많은 순(같으면 라벨 가나다순)으로, 모르는 액션은 원문으로, payload 없으면 「알 수 없는 액션」으로 센다", () => {
    expect(
      summarizeByAction([
        makeProposal({ id: "1", payload: { action: "create_deal" } }),
        makeProposal({ id: "2", payload: { action: "brand_new_action" } }),
        makeProposal({ id: "3", payload: { action: "create_deal" } }),
        makeProposal({ id: "4", payload: null }),
      ])
    ).toEqual([
      { label: "딜 등록", count: 2 },
      { label: "알 수 없는 액션", count: 1 },
      { label: "brand_new_action", count: 1 },
    ]);
  });
});
