// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SellerErChart } from "../seller-er-chart";

// recharts의 ResponsiveContainer는 jsdom에서 크기 0으로 svg를 못 그리므로
// 차트 내부는 통과시키고 카드 헤더·상태 분기만 검증한다 (sellers-panel.test 관례).
vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="chart-container">{children}</div>
  ),
  ChartTooltip: () => null,
}));

vi.mock("recharts", () => ({
  Area: () => null,
  AreaChart: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

describe("SellerErChart", () => {
  it("ER 점이 2개 미만이면 차트 대신 적립 안내를 보여준다", () => {
    render(
      <SellerErChart
        data={[
          // 팔로워-only 스냅샷(er null)은 ER 점으로 세지 않는다
          { date: "2026-07-01", er: null },
          { date: "2026-07-08", er: 0.021 },
        ]}
      />
    );
    expect(screen.getByText(/스냅샷 적립 중 \(1\/2\)/)).toBeInTheDocument();
    // 점 1개라도 최신 ER 수치는 헤더에 노출
    expect(screen.getByText("2.10%")).toBeInTheDocument();
    expect(screen.queryByTestId("chart-container")).not.toBeInTheDocument();
  });

  it("ER 점이 2개 이상이면 차트와 기간 변화 배지를 렌더한다", () => {
    render(
      <SellerErChart
        data={[
          { date: "2026-07-01", er: 0.02, avgLikes: 2000, avgComments: 80 },
          { date: "2026-07-08", er: 0.025, avgLikes: 2400, avgComments: 100 },
        ]}
      />
    );
    expect(screen.getByText("ER(참여율) 추이")).toBeInTheDocument();
    // 최신 ER 헤더 수치
    expect(screen.getByText("2.50%")).toBeInTheDocument();
    // 기간 변화 +0.50%p 배지
    expect(screen.getByText(/\+0\.50%p/)).toBeInTheDocument();
    expect(screen.getByTestId("chart-container")).toBeInTheDocument();
  });
});
