// SegmentedTabCard 계약(오너 2026-07-24 카드 탭 묶음의 재사용 프리미티브):
//  ① 활성 탭 패널만 렌더, 클릭 시 전환
//  ② 비활성 탭도 카운트 배지 유지(숨은 알림 전달) · count 0/미지정은 배지 미렌더
//  ③ 조건부 탭 배열에서 활성 탭이 사라지면 첫 탭으로 안전 폴백(크래시 없음)
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SegmentedTabCard, type SegmentedTab } from "../segmented-tab-card";

function tabs(): SegmentedTab[] {
  return [
    { key: "a", label: "가", count: 9, countTone: "caution", render: () => <div>패널가</div> },
    { key: "b", label: "나", count: 3, countTone: "urgent", render: () => <div>패널나</div> },
    { key: "c", label: "다", render: () => <div>패널다</div> }, // count 없음
  ];
}

describe("SegmentedTabCard", () => {
  it("활성 탭 패널만 렌더하고 클릭으로 전환한다", () => {
    render(<SegmentedTabCard tabs={tabs()} />);
    expect(screen.getByText("패널가")).toBeInTheDocument();
    expect(screen.queryByText("패널나")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /나/ }));
    expect(screen.getByText("패널나")).toBeInTheDocument();
    expect(screen.queryByText("패널가")).not.toBeInTheDocument();
  });

  it("비활성 탭도 카운트 배지를 유지하고, count 없으면 배지가 없다", () => {
    render(<SegmentedTabCard tabs={tabs()} />);
    // 활성은 '가'인데 비활성 '나'의 카운트 3 이 그대로 보인다(숨은 알림 전달)
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("9")).toBeInTheDocument();
    // '다'는 count 미지정 → 숫자 배지 없음(탭 라벨 '다'만)
    expect(screen.getByRole("tab", { name: "다" })).toBeInTheDocument();
  });

  it("defaultTabKey 로 초기 활성 탭을 지정한다", () => {
    render(<SegmentedTabCard tabs={tabs()} defaultTabKey="b" />);
    expect(screen.getByText("패널나")).toBeInTheDocument();
  });

  it("활성 탭이 목록에서 사라져도 크래시 없이 첫 탭으로 폴백한다", () => {
    const { rerender } = render(<SegmentedTabCard tabs={tabs()} defaultTabKey="c" />);
    expect(screen.getByText("패널다")).toBeInTheDocument();
    // 'c' 탭이 조건부로 제거된 상태(예: 최저가 monitoredCount 0) — 첫 탭 패널로 폴백
    rerender(<SegmentedTabCard tabs={tabs().filter((t) => t.key !== "c")} defaultTabKey="c" />);
    expect(screen.getByText("패널가")).toBeInTheDocument();
    expect(screen.queryByText("패널다")).not.toBeInTheDocument();
  });
});
