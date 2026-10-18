// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardHome } from "../dashboard-home";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";
import { buildTaxableRevenueTracker } from "@/lib/taxable-revenue-tracker";
import type { OrderWorkSummary } from "@/lib/order-converter/order-work";
import {
  DASHBOARD_PAGE_SCOPE_CAPTION,
  DASHBOARD_SCOPE_CAPTION,
  DASHBOARD_YTD_SCOPE_CAPTION,
} from "@/lib/dashboard-scope";

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

// 「오늘 처리할 일」의 주문·승인대기 원천은 react-query 훅이다(사이드바 배지와 공유 캐시) — 여기서는
// 훅 값을 고정해 홈이 원천을 모아 카드에 넘기는지만 본다. 카드 자체의 표시 계약은
// today-work-card.test.tsx, 행 규칙은 src/lib/__tests__/today-work.test.ts 가 본다.
const hookState = vi.hoisted(() => ({
  orders: undefined as unknown,
  approvalsCount: 0,
}));
vi.mock("@/hooks/useOrderWorkSummary", () => ({
  useOrderWorkSummary: () => ({
    data: hookState.orders,
    dataUpdatedAt: Date.now(),
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));
vi.mock("@/hooks/useApprovalInbox", () => ({
  useApprovalInbox: () => ({ count: hookState.approvalsCount, isLoading: false, isError: false, refetch: vi.fn() }),
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
    taxableRevenueTracker: buildTaxableRevenueTracker([], new Date("2026-06-15T03:00:00.000Z")),
    ...overrides,
  };
}

function orderSummary(overrides: Partial<OrderWorkSummary> = {}): OrderWorkSummary {
  return {
    awaitingPo: { lines: 0, campaigns: 0, delayedLines: 0 },
    delayed: { lines: 0, campaigns: 0, invoiceLines: 0, shippingLines: 0 },
    openClaims: { lines: 0, campaigns: 0, unmatchedLines: 0 },
    total: 0,
    lastSyncAt: new Date().toISOString(),
    activeCampaignCount: 1,
    hasSnapshot: true,
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
      // 중립 뮤트는 알파 없이 하한 토큰 그대로(T-214 — /60 은 흰 카드 위 2.30:1).
      expect(labels[i].className).toMatch(/(^|\s)text-muted-foreground(\s|$)/);
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

  it("--chart-2를 쓰지 않는다 — 그 중간 틸은 차트 계열 구분 색이다", () => {
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

  // 「오늘 처리할 일」(2026-10-18): 주문·영업 팔로업·지연된 정산·승인대기·데이터 점검을 한 목록으로.
  it("모든 원천이 0건이면 「오늘 처리할 일」이 한 줄로 접힌다", async () => {
    hookState.orders = orderSummary();
    hookState.approvalsCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ tasks: [], settlements: [] }) }),
    );
    render(<DashboardHome initialData={data()} />);
    expect(await screen.findByText("오늘 처리할 일이 없습니다")).toBeInTheDocument();
    // 종전 핵심 업무 탭 카드(축하 빈 상태)와 빠른 정산 창은 흡수됐다.
    expect(screen.queryByText(/오늘 할 일이 모두 완료/)).not.toBeInTheDocument();
  });

  it("원천을 모아 행으로 — 지연된 정산 한 건은 그 캠페인 상세로, 데이터 점검은 아래 탭으로 간다", async () => {
    hookState.orders = orderSummary({ awaitingPo: { lines: 4, campaigns: 2, delayedLines: 0 }, total: 4 });
    hookState.approvalsCount = 2;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ tasks: [{ id: "t-1" }, { id: "t-2" }], settlements: [{ id: "camp-9" }] }),
      }),
    );
    const { container } = render(
      <DashboardHome
        initialData={data({
          dataIntegrityIssues: [
            { campaignId: "c-1", campaignName: "점검캠페인", type: "MISSING_SALES", label: "매출 미입력" },
          ] as unknown as DesktopDashboardData["dataIntegrityIssues"],
        })}
      />,
    );
    const settlement = (await screen.findByText("지연된 정산")).closest("a")!;
    expect(settlement).toHaveAttribute("href", "/settlement?campaign=camp-9");
    expect(screen.getByText("영업 팔로업").closest("a")).toHaveAttribute("href", "/outreach");
    expect(screen.getByText("승인대기").closest("a")).toHaveAttribute("href", "/approvals");
    expect(screen.getByText("발주 대기").closest("a")).toHaveAttribute("href", "/order-converter");
    const check = container.querySelector('a[data-row="data-check"]')!;
    expect(check).toHaveAttribute("href", "/#data-check");
    expect(container.querySelector("#data-check")).not.toBeNull();
  });

  // 오너 2026-10-06: 퍼널 트랙의 빈 구간이 slate-100(흰 카드 대비 1.09:1)이라 안 보였다 → slate-300.
  // 약한 행이 --chart-2 @.45 로 남으면 slate-300 위 대비가 1.58 로 묻힌다 — 네이비 농도 사다리(1 / .6)로 고정.
  it("영업 전환 퍼널은 보이는 트랙(slate-300) 위에 네이비 농도 사다리로 그린다", () => {
    const { container } = render(
      <DashboardHome initialData={data({ outreach90d: { total: 40, responded: 18, confirmed: 6, converted: 6 } })} />,
    );
    const card = screen.getByText("최근 90일 영업 전환").closest('[data-slot="card"]') ?? container;
    const tracks = [...card.querySelectorAll("div.h-2\\.5.rounded-full")];
    expect(tracks).toHaveLength(3);
    for (const track of tracks) {
      expect(track.className).toContain("bg-slate-300");
      expect(track.className).not.toContain("bg-slate-100");
      const fill = track.firstElementChild as HTMLElement;
      expect(fill.style.backgroundColor).toBe("var(--chart-1)");
    }
    expect(tracks.map((t) => (t.firstElementChild as HTMLElement).style.opacity)).toEqual(["0.6", "0.6", "1"]);
  });

  it("does not render lagging indicators on the realtime board", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.queryByText("확정 손익")).not.toBeInTheDocument();
    expect(screen.queryByText("정산 노출액")).not.toBeInTheDocument();
  });

  // 밴드 재배치(애플 UI 리뉴얼 묶음 1-b, 오너 2026-10-17) — 첫 밴드는 두 초점(오늘 처리할 일 + 거래액 목표).
  it("첫 밴드에 「오늘 처리할 일」과 거래액 목표 히어로가 함께 있다", () => {
    const { container } = render(<DashboardHome initialData={data()} />);
    const stack = container.querySelector("main > div.space-y-6")!;
    // 맨 위 한 줄은 범위 안내(<p>), 그 다음이 첫 밴드다.
    const firstBand = stack.querySelector('[data-band="focus"]')!;
    expect(firstBand).not.toBeNull();
    expect(firstBand.contains(screen.getByRole("heading", { name: "오늘 처리할 일" }))).toBe(true);
    expect(firstBand.contains(screen.getByRole("heading", { name: "이번 달 거래액" }))).toBe(true);
    expect(firstBand.contains(screen.getByRole("heading", { name: "연간 누적" }))).toBe(true);
  });

  it("밴드 순서 — 두 초점 → 거래액 차트 → 일정 → 점검·과세기준", () => {
    const { container } = render(<DashboardHome initialData={data()} />);
    const stack = container.querySelector("main > div.space-y-6")!;
    const bands = [...stack.querySelectorAll(":scope > [data-band]")].map((el) => el.getAttribute("data-band"));
    expect(bands).toEqual(["focus", "sales-chart", "schedule", "checks"]);
    // 실적 지표 3장은 첫 밴드 좌 칸(「오늘 처리할 일」 아래)에 붙는다 — 히어로 옆을 비우지 않는다.
    const metrics = stack.querySelector('[data-band="focus"] [data-band="metrics"]');
    expect(metrics).not.toBeNull();
    expect(metrics!.textContent).toContain("최근 90일 영업 전환");
    // 데이터 점검 탭과 과세기준 카드는 같은 밴드(반폭씩).
    const checks = stack.querySelector('[data-band="checks"]')!;
    expect(checks.querySelector("#data-check")).not.toBeNull();
    expect(checks.textContent).toContain("과세기준매출");
  });

  it("「오늘 처리할 일」 데이터 점검 행의 목적지(#data-check)가 재배치 뒤에도 남는다", () => {
    const { container } = render(<DashboardHome initialData={data()} />);
    const anchor = container.querySelector("#data-check")!;
    expect(anchor).not.toBeNull();
    expect(anchor.textContent).toContain("데이터 점검");
  });

  it("활성 셀러 카드는 없다 — 판단을 바꾸지 않는 개수 카드(오너 2026-10-17)", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.queryByText("활성 셀러 현황")).not.toBeInTheDocument();
    expect(screen.queryByText(/재계약 검토/)).not.toBeInTheDocument();
  });

  it("자동화 작업 상태(구 시스템 레이더)는 대시보드에 없다 — 설정 → 외부 연동 진단으로 옮겼다", () => {
    render(<DashboardHome initialData={data()} />);
    expect(screen.queryByText("자동화 작업 상태")).not.toBeInTheDocument();
    expect(screen.queryByText("시스템 레이더")).not.toBeInTheDocument();
  });

  it("범위 안내는 페이지 맨 위에 정확히 한 번 — 히어로 안 캡션은 없다", () => {
    const { container } = render(<DashboardHome initialData={data()} />);
    const stack = container.querySelector("main > div.space-y-6")!;
    const hits = [...container.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && el.textContent === DASHBOARD_PAGE_SCOPE_CAPTION,
    );
    expect(hits).toHaveLength(1);
    expect(stack.firstElementChild?.tagName).toBe("P");
    expect(stack.firstElementChild?.textContent).toBe(DASHBOARD_PAGE_SCOPE_CAPTION);
    // 히어로에 남던 짧은 캡션 두 개(모바일 히어로가 여전히 쓴다)는 데스크톱에서 사라졌다.
    expect(container.textContent).not.toContain(DASHBOARD_SCOPE_CAPTION);
    expect(container.textContent).not.toContain(DASHBOARD_YTD_SCOPE_CAPTION);
  });

  it("거래액 차트에 범례가 있다 — 계열을 색만으로 가르지 않는다", () => {
    const { container } = render(<DashboardHome initialData={data({ trend: trend6() })} />);
    const legend = container.querySelector('[data-slot="chart-legend"]')!;
    expect(legend).not.toBeNull();
    expect(legend.textContent).toContain("총거래액");
    expect(legend.textContent).toContain("매출총이익");
  });

  it("매출총이익 막대는 청록 면색이다 — 대기 주황(--chart-4 = --status-pending 값)은 심각도 축이라 쓰지 않는다", () => {
    const { container } = render(<DashboardHome initialData={data({ trend: trend6() })} />);
    const legend = container.querySelector('[data-slot="chart-legend"]')!;
    expect(legend.innerHTML).toContain("var(--fill-teal-1)");
    expect(legend.innerHTML).not.toContain("--chart-4");
    expect(container.innerHTML).not.toContain("var(--chart-4)");
    // 막대 fill 은 chartConfig → ChartContainer 의 --color-expectedMargin 으로 흐르는데 jsdom 은 차트를
    // 그리지 않는다(크기 0) — 그래서 막대 색의 출처인 chartConfig 줄을 소스에서 고정한다. 범례·툴팁 견본과 같은 토큰.
    const src = readFileSync(join(__dirname, "..", "dashboard-home.tsx"), "utf8");
    expect(src).toMatch(/expectedMargin:\s*\{\s*label:\s*"매출총이익",\s*color:\s*"var\(--fill-teal-1\)"\s*\}/);
  });
});
