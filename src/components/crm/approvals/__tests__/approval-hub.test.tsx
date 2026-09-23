// @vitest-environment jsdom
/**
 * ApprovalHub — 결재함 허브 화면 (/approvals, Plan 2 Task 4).
 *
 * 탭 6개(기안 4 · 기록 2)와 본문 목록을 한 컨테이너 안에서 보여준다. 데이터 훅은
 * `hooks` prop 으로 주입할 수 있어(기본값 = 실제 훅) 네트워크 없이 검증한다 —
 * `approval-cards.test.tsx` 와 같은 관례다.
 */
import { render, screen, fireEvent, within } from "@testing-library/react";
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
import { APPROVALS_TABS, EMPTY_MESSAGES } from "../approvals-tabs";
import type { ApprovalsTab } from "../approvals-tabs";
import type { ApprovalInboxItem } from "../approval-cards";
import type { ReadRecordItem } from "@/hooks/useReadRecords";
import type { AgentJobListItem } from "@/lib/agent-jobs/list-item";

function makeProposal(overrides: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    id: "proposal-1",
    title: "딜에 메모 추가",
    status: "PENDING_APPROVAL",
    kind: "WRITE",
    targetEntityType: "DEAL",
    targetEntityId: "deal-1",
    targetEntityName: "테스트 딜",
    payload: { action: "add_entity_memo", args: { content: "재입고 확인" } },
    createdBy: "user-1",
    createdAt: "2026-09-22T05:30:00Z",
    errorMessage: null,
    ...overrides,
  };
}

function makeRead(overrides: Partial<ReadRecordItem> = {}): ReadRecordItem {
  return {
    ...makeProposal({ id: "read-1", status: "EXECUTED", kind: "READ", createdBy: "AGENT_WORKER" }),
    title: "딜 검색: 유산균",
    resultSummary: "딜 3건을 찾았습니다.",
    structuredResult: { operation: "search_deals" },
    ...overrides,
  };
}

function makeJob(overrides: Partial<AgentJobListItem> = {}): AgentJobListItem {
  return {
    id: "job-1",
    status: "SUCCEEDED",
    operation: "search_deals",
    taskType: "READ",
    createdAt: "2026-09-22T05:30:00Z",
    updatedAt: "2026-09-22T05:30:10Z",
    attempt: 1,
    failureCode: null,
    resultStatus: "OK",
    resultSummary: "딜 3건을 찾았습니다.",
    actionProposalId: null,
    payloadUnreadable: false,
    ...overrides,
  };
}

type StubOptions = {
  tab?: ApprovalsTab;
  proposals?: ApprovalInboxItem[];
  counts?: Partial<Record<string, number>>;
  reads?: ReadRecordItem[];
  jobs?: AgentJobListItem[];
  isLoading?: boolean;
  isError?: boolean;
  refetch?: () => void;
  useAgentJobs?: ApprovalHubHooks["useAgentJobs"];
  /** 기안 탭(useApprovalInbox) 이어 받기 스텁. */
  hasMore?: boolean;
  loadMore?: () => void;
};

function makeHooks(options: StubOptions = {}): ApprovalHubHooks {
  const refetch = options.refetch ?? vi.fn();
  const base = {
    isLoading: options.isLoading ?? false,
    isError: options.isError ?? false,
    refetch,
  };
  return {
    useTab: () => options.tab,
    useApprovalInbox: (status: string) => ({
      ...base,
      items: options.proposals ?? [],
      count: options.counts?.[status] ?? 0,
      approve: vi.fn().mockResolvedValue({}),
      reject: vi.fn().mockResolvedValue({}),
      loadMore: options.loadMore ?? vi.fn(),
      isLoadingMore: false,
      hasMore: options.hasMore ?? false,
    }),
    useReadRecords: () => ({
      ...base,
      items: options.reads ?? [],
      count: (options.reads ?? []).length,
      loadMore: vi.fn(),
      isLoadingMore: false,
      hasMore: false,
    }),
    useAgentJobs:
      options.useAgentJobs ??
      (() => ({
        ...base,
        items: options.jobs ?? [],
        loadMore: vi.fn(),
        isLoadingMore: false,
        hasMore: false,
      })),
  };
}

function tabLink(container: HTMLElement, tab: ApprovalsTab): HTMLAnchorElement {
  const link = container.querySelector<HTMLAnchorElement>(`a[href="/approvals?tab=${tab}"]`);
  if (!link) throw new Error(`tab link not found: ${tab}`);
  return link;
}

describe("ApprovalHub — 탭", () => {
  it("①-a 탭 파라미터가 없으면 대기 탭이 활성이다", () => {
    const { container } = render(<ApprovalHub hooks={makeHooks()} />);
    expect(tabLink(container, "pending")).toHaveAttribute("aria-current", "page");
    for (const tab of APPROVALS_TABS.filter((t) => t.id !== "pending")) {
      expect(tabLink(container, tab.id)).not.toHaveAttribute("aria-current");
    }
  });

  it("①-b 탭 6개가 기안·기록 두 세그먼트로 나뉘어 한 줄에 있다", () => {
    const { container } = render(<ApprovalHub hooks={makeHooks()} />);
    expect(container.querySelectorAll('a[href^="/approvals?tab="]')).toHaveLength(6);
    expect(screen.getByText("기안")).toBeInTheDocument();
    expect(screen.getByText("기록")).toBeInTheDocument();
  });

  it("② ?tab=reads 면 조회 결과 카드가 렌더되고 카드 링크가 /approvals/<id> 다", () => {
    const { container } = render(
      <ApprovalHub hooks={makeHooks({ tab: "reads", reads: [makeRead({ id: "read-42" })] })} />
    );
    expect(tabLink(container, "reads")).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("딜 검색: 유산균")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /딜 검색/ })).toHaveAttribute(
      "href",
      "/approvals/read-42"
    );
  });

  it("④ 대기 count=3 이면 배지 3, 완료 탭에는 배지가 없다", () => {
    const { container } = render(
      <ApprovalHub hooks={makeHooks({ counts: { PENDING_APPROVAL: 3, FAILED: 0 } })} />
    );
    expect(within(tabLink(container, "pending")).getByText("3")).toBeInTheDocument();
    expect(tabLink(container, "executed").textContent).toBe("완료");
    // 실패 count=0 이면 배지를 숨긴다.
    expect(tabLink(container, "failed").textContent).toBe("실패");
  });

  it("⑥ 배지 색은 대기=status-pending · 실패=destructive 다", () => {
    const { container } = render(
      <ApprovalHub hooks={makeHooks({ counts: { PENDING_APPROVAL: 3, FAILED: 2 } })} />
    );
    // 「손이 필요하다」는 두 탭이 같은 색이면 급한 쪽(실패)이 묻힌다.
    expect(within(tabLink(container, "pending")).getByText("3")).toHaveAttribute(
      "data-variant",
      "status-pending"
    );
    expect(within(tabLink(container, "failed")).getByText("2")).toHaveAttribute(
      "data-variant",
      "destructive"
    );
  });

  // 세그먼트 이름표(기안·기록)는 눈으로만 읽힌다 — 탭을 훑는 화면낭독기 사용자에게도
  // 여섯 개가 두 무리라는 사실이 전해져야 한다.
  it("각 세그먼트의 탭들이 이름 붙은 그룹으로 묶인다", () => {
    render(<ApprovalHub hooks={makeHooks()} />);
    const draft = screen.getByRole("group", { name: "기안" });
    const record = screen.getByRole("group", { name: "기록" });
    expect(within(draft).getAllByRole("link")).toHaveLength(4);
    expect(within(record).getAllByRole("link")).toHaveLength(2);
  });

  it("탭바에 이름표가 있고 탭 링크에 포커스 링 유틸이 붙는다", () => {
    const { container } = render(<ApprovalHub hooks={makeHooks()} />);
    expect(screen.getByRole("navigation", { name: "결재함 탭" })).toBeInTheDocument();
    expect(tabLink(container, "pending").className).toContain("focus-visible:ring-focus-ring");
  });
});

describe("ApprovalHub — 상태", () => {
  it.each(APPROVALS_TABS.map((t) => [t.id, EMPTY_MESSAGES[t.id]] as const))(
    "③ %s 탭의 빈 상태 문구를 보여준다",
    (tab, message) => {
      render(<ApprovalHub hooks={makeHooks({ tab })} />);
      expect(screen.getByText(message)).toBeInTheDocument();
    }
  );

  it("⑤ 로딩이면 스켈레톤을 보여주고 「불러오는 중」은 화면낭독기에만 읽힌다", () => {
    const { container } = render(<ApprovalHub hooks={makeHooks({ isLoading: true })} />);
    expect(container.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
    // 눈으로 읽는 사람에게는 스피너 문구를 보이지 않는다(레이아웃이 뛰지 않는 편이 낫다).
    // 화면낭독기에는 말이 필요하므로 sr-only 로만 둔다 — 스켈레톤은 aria-hidden 이다.
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(within(status).getByText("불러오는 중")).toHaveClass("sr-only");
    // 로딩 중에는 빈 상태 문구를 함께 그리지 않는다.
    expect(screen.queryByText(EMPTY_MESSAGES.pending)).not.toBeInTheDocument();
  });

  // 스켈레톤의 용도는 **자리 예약** 하나뿐이다 — 실제 카드와 높이가 다르면 목록이
  // 뜨는 순간 화면이 뛴다(P8 Layout Stability). 기안 카드(배지+본문+버튼 줄)는
  // 조회 결과 카드(세 줄)보다 높으므로 두 탭의 스켈레톤 높이도 달라야 한다.
  it("⑤-b 스켈레톤 높이가 탭별 카드 높이를 따른다 (기안 h-36 · 기록 h-20)", () => {
    const draft = render(<ApprovalHub hooks={makeHooks({ isLoading: true })} />);
    const draftSkeletons = [...draft.container.querySelectorAll('[data-slot="skeleton"]')];
    expect(draftSkeletons.length).toBeGreaterThan(0);
    expect(draftSkeletons.every((el) => el.className.includes("h-36"))).toBe(true);

    const record = render(<ApprovalHub hooks={makeHooks({ tab: "reads", isLoading: true })} />);
    const recordSkeletons = [...record.container.querySelectorAll('[data-slot="skeleton"]')];
    expect(recordSkeletons.length).toBeGreaterThan(0);
    expect(recordSkeletons.every((el) => el.className.includes("h-20"))).toBe(true);
  });

  it("⑥ 오류면 안내 문구와 다시 불러오기 버튼이 뜨고 버튼이 refetch 를 부른다", () => {
    const refetch = vi.fn();
    render(<ApprovalHub hooks={makeHooks({ isError: true, refetch })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("목록을 불러오지 못했습니다.");
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("ApprovalHub — 봇 활동", () => {
  const STATUS_CASES: Array<[string, string]> = [
    ["SUCCEEDED", "완료"],
    ["RUNNING", "진행 중"],
    ["RESOURCE_DEFERRED", "보류"],
    ["NEEDS_APPROVAL", "승인 대기"],
    ["FAILED_RETRYABLE", "재시도 중"],
    ["FAILED_FINAL", "실패"],
    ["FAILED_SECURITY", "차단됨"],
  ];

  it("⑦ 상태 7종이 표에 매핑 라벨로 뜨고 헤더는 th[scope=col] 5개다", () => {
    const jobs = STATUS_CASES.map(([status], i) => makeJob({ id: `job-${i}`, status }));
    render(<ApprovalHub hooks={makeHooks({ tab: "activity", jobs })} />);

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(5);
    expect(
      within(table)
        .getAllByRole("columnheader")
        .every((h) => h.getAttribute("scope") === "col")
    ).toBe(true);

    const rows = within(table).getAllByRole("row").slice(1);
    STATUS_CASES.forEach(([, label], i) => {
      expect(within(rows[i]).getByText(label)).toBeInTheDocument();
    });
  });

  it("⑧ 「완료 포함」 토글이 useAgentJobs(true) 로 재호출한다", () => {
    const useAgentJobs = vi.fn(() => ({
      items: [makeJob()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      loadMore: vi.fn(),
      isLoadingMore: false,
      hasMore: false,
    }));
    render(<ApprovalHub hooks={makeHooks({ tab: "activity", useAgentJobs })} />);

    expect(useAgentJobs).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "완료 포함" }));
    expect(useAgentJobs).toHaveBeenCalledWith(true);
  });

  it("hasMore 면 「더 보기」가 loadMore 를 부른다", () => {
    const loadMore = vi.fn();
    const useAgentJobs = vi.fn(() => ({
      items: [makeJob()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      loadMore,
      isLoadingMore: false,
      hasMore: true,
    }));
    render(<ApprovalHub hooks={makeHooks({ tab: "activity", useAgentJobs })} />);
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("다음 장을 받아오는 중이면 「더 보기」가 비활성이다", () => {
    const loadMore = vi.fn();
    const useAgentJobs = vi.fn(() => ({
      items: [makeJob()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
      loadMore,
      isLoadingMore: true,
      hasMore: true,
    }));
    render(<ApprovalHub hooks={makeHooks({ tab: "activity", useAgentJobs })} />);

    const button = screen.getByRole("button", { name: "더 보기" });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(loadMore).not.toHaveBeenCalled();
  });
});

describe("ApprovalHub — 기안 탭", () => {
  it("대기 탭은 승인·반려 버튼이 달린 카드를 보여준다", () => {
    render(<ApprovalHub hooks={makeHooks({ proposals: [makeProposal()] })} />);
    expect(screen.getByRole("button", { name: "승인" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "반려" })).toBeInTheDocument();
  });

  it("50건을 넘는 기안이 있으면(hasMore) 「더 보기」가 loadMore 를 부르고, 없으면 버튼이 없다", () => {
    const loadMore = vi.fn();
    const { unmount } = render(
      <ApprovalHub
        hooks={makeHooks({ tab: "executed", proposals: [makeProposal()], hasMore: true, loadMore })}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "더 보기" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    unmount();

    render(<ApprovalHub hooks={makeHooks({ tab: "executed", proposals: [makeProposal()] })} />);
    expect(screen.queryByRole("button", { name: "더 보기" })).not.toBeInTheDocument();
  });

  it("실패 탭은 재시도 버튼이 달린 카드를 보여준다", () => {
    render(
      <ApprovalHub
        hooks={makeHooks({
          tab: "failed",
          proposals: [makeProposal({ status: "FAILED", errorMessage: "실행 중 오류" })],
        })}
      />
    );
    expect(screen.getByRole("button", { name: "재시도" })).toBeInTheDocument();
    expect(screen.getByText("실행 중 오류")).toBeInTheDocument();
  });
});
