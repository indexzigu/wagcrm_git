import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, requireRole } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import {
  REVENUE_GOAL_INVALIDATION_TAGS,
  revalidateCrmTags,
} from "@/lib/cache-tags";
import {
  findRevenueGoalsSafe,
  isMissingRevenueGoalTableError,
} from "@/lib/revenue-goals";

const yearSchema = z.string().regex(/^\d{4}$/);
const patchSchema = z.object({
  year: yearSchema,
  annualTarget: z.number().nonnegative().nullable(),
  monthlyTargets: z.array(z.number().nonnegative().nullable()).length(12),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const parsedYear = yearSchema.safeParse(request.nextUrl.searchParams.get("year"));
  if (!parsedYear.success) {
    return NextResponse.json({ error: "year must use YYYY format" }, { status: 400 });
  }

  const { goals, schemaReady } = await findRevenueGoalsSafe(parsedYear.data);

  return NextResponse.json({
    year: parsedYear.data,
    annualTarget: goals.find((goal) => goal.periodKey === parsedYear.data)
      ? Number(goals.find((goal) => goal.periodKey === parsedYear.data)!.revenueTarget)
      : null,
    monthlyTargets: Array.from({ length: 12 }, (_, index) => {
      const periodKey = `${parsedYear.data}-${String(index + 1).padStart(2, "0")}`;
      const goal = goals.find((candidate) => candidate.periodKey === periodKey);
      return goal ? Number(goal.revenueTarget) : null;
    }),
    canEdit: auth.context.role === "admin",
    schemaReady,
  });
}

export async function PATCH(request: Request) {
  const auth = await requireRole("admin");
  if (!auth.authenticated) return auth.response;

  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const entries = [
    { periodType: "YEAR", periodKey: parsed.data.year, revenueTarget: parsed.data.annualTarget },
    ...parsed.data.monthlyTargets.map((revenueTarget, index) => ({
      periodType: "MONTH",
      periodKey: `${parsed.data.year}-${String(index + 1).padStart(2, "0")}`,
      revenueTarget,
    })),
  ];

  try {
    await prisma.$transaction(
      entries.map((entry) =>
        entry.revenueTarget == null
          ? prisma.revenueGoal.deleteMany({ where: { periodKey: entry.periodKey } })
          : prisma.revenueGoal.upsert({
              where: { periodKey: entry.periodKey },
              update: { revenueTarget: entry.revenueTarget, periodType: entry.periodType },
              create: {
                revenueTarget: entry.revenueTarget,
                periodType: entry.periodType,
                periodKey: entry.periodKey,
              },
            }),
      ),
    );
  } catch (error) {
    if (isMissingRevenueGoalTableError(error)) {
      return NextResponse.json(
        { error: "RevenueGoal table is missing. Apply the latest database migration first." },
        { status: 503 },
      );
    }
    throw error;
  }

  revalidateCrmTags(REVENUE_GOAL_INVALIDATION_TAGS);
  return NextResponse.json({ ok: true });
}
