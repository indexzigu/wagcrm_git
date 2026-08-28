import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardHome } from "../dashboard-home";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";

vi.mock("recharts", () => ({
  ComposedChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  Bar: () => null,
  Line: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/components/ui/chart", () => ({
  ChartContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

vi.mock("@/components/ui/animated-number", () => ({
  AnimatedNumber: ({ value, format, decimalPlaces = 0, suffix = "" }: any) => {
    let display = String(value);
    if (format === "percent") {
      display = value.toFixed(decimalPlaces) + "%";
    } else if (format === "currency") {
      display = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "KRW" }).format(value);
    }
    return <span>{display}{suffix}</span>;
  }
}));

function data(overrides: Partial<DesktopDashboardData> = {}): DesktopDashboardData {
  return {
    selectedMonth: "2026-06",
    latestActiveMonth: { month: "2026-05", revenue: 3000000 },
    goals: {
      monthTarget: null,
      annualTarget: 1000000000,
      monthActual: 80000000,
      ytdActual: 450000000,
      prevMonthTarget: null,
      prevMonthActual: 75000000,
      prevPrevMonthTarget: null,
      prevPrevMonthActual: 60000000,
    },
    ytdHistory: [
      { month: "2024-01", ytd: 50000000 },
      { month: "2024-02", ytd: 120000000 },
      { month: "2024-03", ytd: 200000000 },
      { month: "2024-04", ytd: 260000000 },
      { month: "2024-05", ytd: 335000000 },
      { month: "2024-06", ytd: 450000000 }
    ],
    scale: { weightedCampaignCount: 0.4, operatingDays: 4, prevWeightedCampaignCount: 0, prevOperatingDays: 0, prevPrevWeightedCampaignCount: 0 },
    sellerMomentum: {
      active: 3,
      newThisMonth: 1,
      dormant: 2,
      dormantList: [
        { id: "seller-a", name: "휴면셀러A", lastCampaignAt: "2026-02-10T00:00:00.000Z" },
        { id: "seller-b", name: "휴면셀러B", lastCampaignAt: "2026-01-05T00:00:00.000Z" },
      ],
      netChange: 1,
    },
    profitability: { expectedMargin: 0, prevExpectedMargin: 0, prevPrevExpectedMargin: 0 },
    exceptions: { overdueReminders: 23, pendingApprovals: 8 },
    outreach90d: { total: 2, responded: 2, confirmed: 1, converted: 1 },
    trend: [],
    yearlyTrend: [],
    upcomingEvents: [],
    googleCalendarConnected: false,
    revenueGoalSchemaReady: true,
    scheduleGapBriefing: {
      thresholds: { idealDays: 60, minDays: 30, deadlineDays: 21 },
      buckets: [],
      gaps: [],
      funnel: { readyDeals: 0, proposedTasks: 0, negotiatingTasks: 0, stagnantTasks: 0, pendingApproval: 0, totalActive: 0 },
      summary: { totalBuckets: 0, emptyBuckets: 0, dangerBuckets: 0, urgentBuckets: 0, gapCount: 0, riskyGapCount: 0 }
    },
    dataIntegrityIssues: [],
    ...overrides,
  };
}

// 6개월 추세 — 카드 표(당월·전월·전전월)는 이 중 뒤 3개월만 숫자로 펼친다.
function trend6(): DesktopDashboardData["trend"] {
  return ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].map((month, i) => ({
    month,
    revenue: (i + 1) * 1000000,
    expectedMargin: (i + 1) * 100000,
    campaignCount: i + 1,
    activeSellers: i,
    goal: null,
  }));
}

describe("DashboardHome 스파크라인 기간 정합", () => {
  // 회귀 방지 계약(오너 결정 2026-07-15): 표는 3개월인데 그래프는 6개월이라 왼쪽 3개 막대에
  // 대응 숫자가 없던 혼란이 원인이었다. 강조 구간(라벨 bold)이 표의 3개월과 어긋나면 그 혼란이
  // 그대로 되돌아온다.
  it("축 라벨은 6개월 전부 노출한다(중간 달 생략은 축이 불연속으로 오독됨 — 오너 2026-07-24)", () => {
    const { container } = render(<DashboardHome initialData={data({ trend: trend6() })} />);
    const axes = container.querySelectorAll('[data-slot="spark-axis"]');
    expect(axes.length).toBeGreaterThan(0);

    for (const axis of axes) {
      const labels = [...axis.children].map((el) => el.textContent);
      expect(labels).toEqual(["1월", "2월", "3월", "4월", "5월", "6월"]);
    }
  });

  it("강조 구간 라벨만 primary bold — 앞 구간은 중립 뮤트로 남긴다", () => {
    const { container } = render(<DashboardHome initialData={data({ trend: trend6() })} />);
    const axis = container.querySelector('[data-slot="spark-axis"]')!;
    const labels = [...axis.children];

    // 앞 3개월(0~2)은 맥락 — bold 금지
    for (const i of [0, 1, 2]) {
      expect(labels[i].className).toContain("text-muted-foreground/60");
      expect(labels[i].className).not.toContain("font-bold");
    }
    // 최근 3개월(3~5)은 표와 대응 — primary bold
    for (const i of [3, 4, 5]) {
      expect(labels[i].className).toContain("font-bold");
      expect(labels[i].className).toContain("text-[var(--primary)]");
    }
  });

  // 적자 달(음수 순마진)은 조용히 사라지면 안 된다. 과거 y = H-3-(p/max)*(H-6) 공식은 음수 p를
  // viewBox 밖으로 밀어내 선을 잘라먹었다 — 화면에는 "그 달이 없는" 것처럼 보였다.
  it("적자 달은 0선 아래에 그려진다 — viewBox 밖으로 잘려 사라지지 않는다", () => {
    const H = 22;
    const withLoss = trend6().map((t, i) => (i === 4 ? { ...t, expectedMargin: -1_800_000 } : t));
    const { container } = render(<DashboardHome initialData={data({ trend: withLoss })} />);

    // 순마진(line) 카드의 강조 폴리라인 = 마지막 polyline
    const polylines = [...container.querySelectorAll("svg polyline")];
    const focus = polylines[polylines.length - 1];
    const ys = focus
      .getAttribute("points")!
      .split(" ")
      .map((pair) => Number(pair.split(",")[1]));

    // 모든 좌표가 viewBox(0~22) 안에 있어야 한다 — 잘림 없음
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(H);
    }

    // 적자 달(5월 = 강조 3점 중 가운데)은 0선보다 아래(y가 큼)에 있어야 한다
    const zeroLine = container.querySelector("svg line")!;
    const zeroY = Number(zeroLine.getAttribute("y1"));
    expect(ys[1]).toBeGreaterThan(zeroY);
  });

  // D안(오너 결정 2026-07-15)의 핵심은 "경고를 추가하지 않고 교체한다"는 것이다. 추가하면 카드가
  // 17px 자라고, 그 증가가 적자 유무에 따라 생겼다 사라져 KPI 스트립이 데이터에 따라 점프한다.
  it("적자 달이 있으면 note 줄을 경고로 교체한다 — 줄을 늘리지 않는다", () => {
    const withLoss = trend6().map((t, i) => (i === 4 ? { ...t, expectedMargin: -1_800_000 } : t));
    render(<DashboardHome initialData={data({ trend: withLoss })} />);

    expect(screen.getByText("5월 적자")).toBeInTheDocument();
    // 교체됐으므로 순마진 카드의 상용구 note는 사라져야 한다
    expect(screen.queryByText("진행 중 판단용 추정치")).not.toBeInTheDocument();

    // 경고와 note가 동시에 존재하면 줄이 늘어난 것 = 회귀
    const card = screen.getByText("5월 적자").closest('[data-slot="card"]')!;
    expect(card.textContent).not.toContain("진행 중 판단용 추정치");
  });

  // 0 기준선 도입 시 실수하기 쉬운 지점: 0값 달에 최소 높이를 그냥 주면 top=zeroY가 되어 막대가
  // 0선 '아래로' 매달려 적자처럼 보인다. 부호로 방향을 먼저 정한 뒤 바닥값을 줘야 한다.
  it("캠페인 수가 0인 달의 막대는 0선 위에 최소 높이로 남는다 — 아래로 매달리지 않는다", () => {
    const zeroMonth = trend6().map((t, i) => (i === 2 ? { ...t, campaignCount: 0 } : t));
    const { container } = render(<DashboardHome initialData={data({ trend: zeroMonth })} />);

    // 캠페인 수(bars) 카드 = 첫 스파크라인 SVG
    const svg = container.querySelector('svg[viewBox="0 0 120 22"]')!;
    const bars = [...svg.querySelectorAll("rect")].filter((r) => r.getAttribute("rx") === "1");
    const zeroBar = bars[2];

    const h = Number(zeroBar.getAttribute("height"));
    const top = Number(zeroBar.getAttribute("y"));
    // 전부 양수(0 포함)면 zeroY = H - PAD = 20
    expect(h).toBeGreaterThanOrEqual(2);
    expect(top + h).toBeLessThanOrEqual(20);
  });

  it("표 밖(앞 3개월) 적자는 경고를 띄우지 않는다 — 지금의 행동을 바꾸지 않는다", () => {
    const oldLoss = trend6().map((t, i) => (i === 0 ? { ...t, expectedMargin: -5_000_000 } : t));
    render(<DashboardHome initialData={data({ trend: oldLoss })} />);
    expect(screen.queryByText(/적자$/)).not.toBeInTheDocument();
    expect(screen.getByText("진행 중 판단용 추정치")).toBeInTheDocument();
  });

  it("전부 흑자면 note를 그대로 두고 경고를 띄우지 않는다", () => {
    render(<DashboardHome initialData={data({ trend: trend6() })} />);
    expect(screen.getByText("진행 중 판단용 추정치")).toBeInTheDocument();
    expect(screen.queryByText(/적자$/)).not.toBeInTheDocument();
  });

  it("전부 흑자면 0선을 그리지 않는다 — 0선이 바닥과 같아 잉크만 늘린다", () => {
    const { container } = render(<DashboardHome initialData={data({ trend: trend6() })} />);
    const axis = container.querySelector('[data-slot="spark-axis"]')!;
    expect(axis.parentElement!.querySelector("svg line")).toBeNull();
  });

  it("--chart-2를 쓰지 않는다 — 그 파랑은 6개월 대형 차트의 계열 구분 의미를 갖는다", () => {
    const { container } = render(<DashboardHome initialData={data({ trend: trend6() })} />);
    const axis = container.querySelector('[data-slot="spark-axis"]')!;
    const spark = axis.parentElement!;
    expect(spark.innerHTML).not.toContain("--chart-2");
  });
});

describe("DashboardHome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders missing goals without fabricating a zero-percent achievement rate", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.getAllByText("미설정").length).toBeGreaterThan(0);
    expect(screen.queryByText("0.0%")).not.toBeInTheDocument();
  });

  it("does not show recent active month context when the current month has no sales", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.queryByText(/최근 실적/)).not.toBeInTheDocument();
  });

  // 움브렐라 제목 "오늘의 핵심 업무" 제거(오너 2026-07-24) — 카드는 탭[영업 팔로업|지연된 정산]이
  // 헤더다. 할 일이 없으면 축하 빈 상태를 보여준다(제목 없이도 맥락 전달).
  it("renders the daily action card empty state when there is no agenda", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [], settlements: [] }) }),
    );
    render(<DashboardHome initialData={data()} />);
    expect(await screen.findByText(/오늘 할 일이 모두 완료/)).toBeInTheDocument();
  });

  it("does not render lagging indicators on the realtime board", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.queryByText("확정 손익")).not.toBeInTheDocument();
    expect(screen.queryByText("정산 노출액")).not.toBeInTheDocument();
  });

  // 오너 2026-07-24: "셀러 베이스 모멘텀"은 알기 쉬운 한글로, 재계약 검토는 페이지 이동 없이 팝업으로
  it("셀러 카드 제목은 한글 표기('활성 셀러 현황')다 — 구 영문 혼용 표기는 회귀", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.getByText("활성 셀러 현황")).toBeInTheDocument();
    expect(screen.queryByText("셀러 베이스 모멘텀")).not.toBeInTheDocument();
  });

  it("재계약 검토는 페이지 이동 없이 팝업으로 휴면 셀러 목록을 연다", () => {
    render(<DashboardHome initialData={data()} />);
    const trigger = screen.getByRole("button", { name: /휴면 2명 재계약 검토/ });
    // 링크(페이지 이동)가 아니라 버튼이어야 한다
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    // 팝업에 휴면 셀러 목록 + 셀러 상세 진입 링크가 있어야 한다
    expect(screen.getByText("휴면셀러A")).toBeInTheDocument();
    expect(screen.getByText("휴면셀러B")).toBeInTheDocument();
    expect(screen.getByText("휴면셀러A").closest("a")).toHaveAttribute("href", "/sellers/seller-a");
  });
});
