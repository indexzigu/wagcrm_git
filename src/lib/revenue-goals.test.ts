import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

// where 절의 의미(OR · 완전일치 · startsWith)를 그대로 흉내내는 가짜 저장소.
// mockResolvedValue 로 고정하면 "무엇을 넘겼는가"만 보게 되므로, 조회 **범위**
// 회귀(연도 경계 누락)를 잡지 못한다.
const { rows, findManyMock } = vi.hoisted(() => {
  const rows: Array<{ periodKey: string; revenueTarget: number }> = [];
  const findManyMock = vi.fn(async (args: { where: { OR: Array<{ periodKey: unknown }> } }) => {
    const clauses = args.where.OR;
    return rows.filter((row) =>
      clauses.some((clause) => {
        const filter = clause.periodKey;
        if (typeof filter === "string") return row.periodKey === filter;
        if (filter && typeof filter === "object" && "startsWith" in filter) {
          return row.periodKey.startsWith((filter as { startsWith: string }).startsWith);
        }
        throw new Error(`unsupported periodKey filter: ${JSON.stringify(filter)}`);
      }),
    );
  });
  return { rows, findManyMock };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ revenueGoal: { findMany: findManyMock } }),
}));

const { findRevenueGoalsSafe } = await import("./revenue-goals");

const ALL_ROWS = [
  { periodKey: "2025", revenueTarget: 400_000_000 },
  { periodKey: "2025-11", revenueTarget: 41_000_000 },
  { periodKey: "2025-12", revenueTarget: 42_000_000 },
  { periodKey: "2026", revenueTarget: 426_000_000 },
  { periodKey: "2026-01", revenueTarget: 30_000_000 },
  { periodKey: "2027-01", revenueTarget: 99_000_000 },
];

describe("findRevenueGoalsSafe", () => {
  beforeEach(() => {
    findManyMock.mockClear();
    rows.length = 0;
    rows.push(...ALL_ROWS);
  });

  it("단일 연도를 넘기면 그 해의 연·월 목표만 가져온다", async () => {
    const { goals, schemaReady } = await findRevenueGoalsSafe("2026");

    expect(goals.map((goal) => goal.periodKey)).toEqual(["2026", "2026-01"]);
    expect(schemaReady).toBe(true);
  });

  it("연도 배열을 넘기면 모든 연도의 목표를 합쳐 가져온다", async () => {
    const { goals } = await findRevenueGoalsSafe(["2025", "2026"]);

    expect(goals.map((goal) => goal.periodKey)).toEqual([
      "2025",
      "2025-11",
      "2025-12",
      "2026",
      "2026-01",
    ]);
  });

  it("중복 연도는 한 번만 조회 조건에 넣는다", async () => {
    await findRevenueGoalsSafe(["2026", "2026"]);

    expect(findManyMock.mock.calls[0]![0].where.OR).toHaveLength(2);
  });

  it("RevenueGoal 테이블이 없으면(P2021) 던지지 않고 schemaReady=false 로 폴백한다", async () => {
    findManyMock.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("table missing", {
        code: "P2021",
        clientVersion: "6.0.0",
      }),
    );

    await expect(findRevenueGoalsSafe(["2025", "2026"])).resolves.toEqual({
      goals: [],
      schemaReady: false,
    });
  });

  it("P2021 이 아닌 오류는 삼키지 않고 그대로 던진다", async () => {
    findManyMock.mockRejectedValueOnce(new Error("connection refused"));

    await expect(findRevenueGoalsSafe("2026")).rejects.toThrow("connection refused");
  });
});
