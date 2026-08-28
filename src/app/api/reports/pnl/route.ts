import { NextRequest, NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { buildPnlReportModel } from "@/lib/pnl-report";

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

  return NextResponse.json(buildPnlReportModel(campaigns, year));
}
