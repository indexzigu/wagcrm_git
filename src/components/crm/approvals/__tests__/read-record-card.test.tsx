// @vitest-environment jsdom
/**
 * ReadRecordCard — 결재함 「조회 결과」 카드 (Plan 2 Task 4).
 *
 * 봇이 실행한 READ 기안 한 건을 한 줄 카드로 보여준다. 카드 전체가 상세로 가는
 * 링크라 「자세히」 버튼을 따로 두지 않는다 — 판단에 필요한 것은 무엇을 조회했고
 * 어떤 결과였나 두 줄뿐이다.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// 실제 next/link 는 className 등 나머지 props 를 <a> 로 흘린다 — 그것까지 흉내 내야
// 포커스 링 같은 클래스 계약을 이 스텁 위에서 검증할 수 있다.
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

import { ReadRecordCard } from "../read-record-card";
import type { ReadRecordItem } from "@/hooks/useReadRecords";

function makeItem(overrides: Partial<ReadRecordItem> = {}): ReadRecordItem {
  return {
    id: "proposal-read-1",
    title: "딜 검색: 유산균",
    status: "EXECUTED",
    kind: "READ",
    targetEntityType: null,
    targetEntityId: null,
    targetEntityName: null,
    payload: null,
    createdBy: "AGENT_WORKER",
    createdAt: "2026-09-22T05:30:00Z",
    errorMessage: null,
    resultSummary: "딜 3건을 찾았습니다.\n두 번째 줄은 카드에 보이지 않는다.",
    structuredResult: { operation: "search_deals" },
    ...overrides,
  };
}

describe("ReadRecordCard", () => {
  it("카드 전체가 /approvals/<id> 링크다", () => {
    render(
      <ul>
        <ReadRecordCard item={makeItem()} />
      </ul>
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/approvals/proposal-read-1");
    // 카드 안에 별도의 「자세히」 버튼을 두지 않는다 — 카드 자체가 링크다.
    expect(screen.queryByText("자세히")).not.toBeInTheDocument();
    // 카드가 곧 유일한 초점 대상이므로 포커스 링이 카드에 붙어야 한다(P8 정본 토큰).
    expect(link.className).toContain("focus-visible:ring-focus-ring");
  });

  it("작업 라벨을 한글로 옮기고 출처 배지와 시각(MM-DD HH:mm)을 보여준다", () => {
    render(
      <ul>
        <ReadRecordCard item={makeItem()} />
      </ul>
    );
    expect(screen.getByText("딜 검색")).toBeInTheDocument();
    expect(screen.getByText("슬랙봇")).toBeInTheDocument();
    // 2026-09-22T05:30:00Z = KST 14:30
    expect(screen.getByText("09-22 14:30")).toBeInTheDocument();
  });

  it("모르는 operation 은 원문을 그대로 보여준다", () => {
    render(
      <ul>
        <ReadRecordCard item={makeItem({ structuredResult: { operation: "brand_new_op" } })} />
      </ul>
    );
    expect(screen.getByText("brand_new_op")).toBeInTheDocument();
  });

  it("제목과 요약 첫 줄을 보여준다", () => {
    render(
      <ul>
        <ReadRecordCard item={makeItem()} />
      </ul>
    );
    expect(screen.getByText("딜 검색: 유산균")).toBeInTheDocument();
    expect(screen.getByText("딜 3건을 찾았습니다.")).toBeInTheDocument();
    expect(screen.queryByText(/두 번째 줄은/)).not.toBeInTheDocument();
  });

  it("요약이 없으면 요약 줄을 그리지 않는다", () => {
    const { container } = render(
      <ul>
        <ReadRecordCard item={makeItem({ resultSummary: null })} />
      </ul>
    );
    expect(container.querySelector("[data-slot='read-record-summary']")).toBeNull();
  });
});
