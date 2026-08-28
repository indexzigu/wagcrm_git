import { beforeEach, describe, expect, it, vi } from "vitest";

// 대시보드 추이 창(최근 6개월)은 1~5월에 실행하면 앞쪽 월이 전년도로 넘어간다.
// 목표 조회가 당해년도만 보면 그 달들의 목표선이 통째로 사라지므로, where 절의
// 의미(OR · 완전일치 · startsWith)를 흉내내는 가짜 저장소로 **실제로 걸리는 행**을
// 검증한다.
const { goalRows, revenueGoalFindMany } = vi.hoisted(() => {
  const goalRows: Array<{ periodKey: string; revenueTarget: number }> = [];
  const revenueGoalFindMany = vi.fn(
    async (args: { where: { OR: Array<{ periodKey: unknown }> } }) =>
      goalRows.filter((row) =>
        args.where.OR.some((clause) => {
          const filter = clause.periodKey;
          if (typeof filter === "string") return row.periodKey === filter;
          if (filter && typeof filter === "object" && "startsWith" in filter) {
            return row.periodKey.startsWith((filter as { startsWith: string }).startsWith);
          }
          throw new Error(`unsupported periodKey filter: ${JSON.stringify(filter)}`);
        }),
      ),
  );
  return { goalRows, revenueGoalFindMany };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    salesCampaign: { findMany: vi.fn(async () => []) },
    revenueGoal: { findMany: revenueGoalFindMany },
    salesTask: { findMany: vi.fn(async () => []) },
    storageIntegration: { findUnique: vi.fn(async () => null) },
    reminderSettings: { findFirst: vi.fn(async () => null) },
    deal: { findMany: vi.fn(async () => []) },
  }),
}));

const { getDesktopDashboardData } = await import("./desktop-dashboard");

/** 해당 연도의 YEAR 1행 + MONTH 12행 — 운영 설정 UI 가 쓰는 모양 그대로. */
function seedYear(year: number, monthlyTarget: number, annualTarget: number) {
  goalRows.push({ periodKey: String(year), revenueTarget: annualTarget });
  for (let month = 1; month <= 12; month += 1) {
    goalRows.push({
      periodKey: `${year}-${String(month).padStart(2, "0")}`,
      revenueTarget: monthlyTarget + month,
    });
  }
}

describe("getDesktopDashboardData — 목표 조회의 연도 경계", () => {
  beforeEach(() => {
    goalRows.length = 0;
    seedYear(2025, 40_000_000, 400_000_000);
    seedYear(2026, 30_000_000, 426_000_000);
  });

  it("1~5월 실행 시 추이 창의 전년도 월에도 목표선을 싣는다", async () => {
    const data = await getDesktopDashboardData(new Date("2026-03-15T00:00:00.000Z"));

    expect(data.trend.map((point) => point.month)).toEqual([
      "2025-10",
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
    ]);
    expect(data.trend.map((point) => point.goal)).toEqual([
      40_000_010,
      40_000_011,
      40_000_012,
      30_000_001,
      30_000_002,
      30_000_003,
    ]);
  });

  it("1월 실행 시 KPI 카드의 전월·전전월 목표(전년도)도 채운다", async () => {
    const data = await getDesktopDashboardData(new Date("2026-01-20T00:00:00.000Z"));

    expect(data.goals.prevMonthTarget).toBe(40_000_012); // 2025-12
    expect(data.goals.prevPrevMonthTarget).toBe(40_000_011); // 2025-11
  });

  it("조회를 넓혀도 연간 목표는 당해년도 YEAR 행으로 유지된다", async () => {
    const data = await getDesktopDashboardData(new Date("2026-03-15T00:00:00.000Z"));

    expect(data.goals.annualTarget).toBe(426_000_000);
    expect(data.goals.monthTarget).toBe(30_000_003);
    expect(data.yearlyTrend.map((point) => point.goal)).toEqual([
      30_000_001,
      30_000_002,
      30_000_003,
    ]);
  });

  it("추이 창이 한 해 안에 있으면 그 해만 조회한다", async () => {
    revenueGoalFindMany.mockClear();

    await getDesktopDashboardData(new Date("2026-08-15T00:00:00.000Z"));

    const clauses = revenueGoalFindMany.mock.calls[0]![0].where.OR;
    expect(clauses).toHaveLength(2);
    expect(clauses).toContainEqual({ periodKey: "2026" });
  });
});
