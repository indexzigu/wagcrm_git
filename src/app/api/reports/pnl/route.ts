import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { buildPnlReportModel } from "@/lib/pnl-report";
import { loadPriorYearTaxReference } from "@/lib/prior-year-tax-reference";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const year = parseInt(searchParams.get("year") || new Date().getFullYear().toString());

  const prisma = getPrisma();

  const campaigns = await prisma.salesCampaign.findMany({
    where: {
      status: "COMPLETED",
      startDate: {
        gte: new Date(year, 0, 1),
        lt: new Date(year + 1, 0, 1),
      },
    },
    include: {
      deal: {
        select: {
          dealName: true,
          brandName: true,
          partner: { select: { name: true } },
        },
      },
      seller: { select: { name: true, alias: true } },
    },
    orderBy: { startDate: "asc" },
  });

  // 전년도 신고 기준은 DB 에서 읽는다 — 미등록이면 null(리포트는 그대로 그려진다).
  const priorYearReference = await loadPriorYearTaxReference();

  return NextResponse.json(
    buildPnlReportModel(campaigns, year, undefined, priorYearReference),
  );
}
