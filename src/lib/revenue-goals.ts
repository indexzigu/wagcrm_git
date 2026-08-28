import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";

type RevenueGoalRecord = {
  periodKey: string;
  revenueTarget: Prisma.Decimal | number;
};

export function isMissingRevenueGoalTableError(error: unknown) {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
    return false;
  }

  return error.code === "P2021";
}

/**
 * 연 1행(`YYYY`) + 월 12행(`YYYY-MM`) 규약의 매출 목표를 조회한다.
 *
 * 조회 범위가 **여러 연도**를 받는 이유: 대시보드 추이 창(최근 6개월)은 1~5월에
 * 실행하면 앞쪽 월이 전년도로 넘어간다. 당해년도만 조회하면 그 달들의 목표선이
 * DB에 행이 있어도 통째로 비어 보인다. 소비처는 전부 `periodKey` **완전일치**
 * 조회이므로 범위를 넓혀도 다른 해의 행이 섞여 오답을 만들지 않는다.
 */
export async function findRevenueGoalsSafe(years: string | string[]): Promise<{
  goals: RevenueGoalRecord[];
  schemaReady: boolean;
}> {
  const uniqueYears = [...new Set(Array.isArray(years) ? years : [years])];

  try {
    const goals = await getPrisma().revenueGoal.findMany({
      where: {
        OR: uniqueYears.flatMap((year) => [
          { periodKey: year },
          { periodKey: { startsWith: `${year}-` } },
        ]),
      },
      orderBy: { periodKey: "asc" },
    });

    return { goals, schemaReady: true };
  } catch (error) {
    if (isMissingRevenueGoalTableError(error)) {
      return { goals: [], schemaReady: false };
    }
    throw error;
  }
}
