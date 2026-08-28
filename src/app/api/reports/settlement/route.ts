import { NextRequest, NextResponse } from "next/server";
import { SettlementService } from "@/services/settlementService";

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const monthParam = searchParams.get("month");
  const yearParam = searchParams.get("year");
  const teamId = searchParams.get("teamId");
  const searchQuery = searchParams.get("searchQuery");
  const statusFilter = searchParams.get("status");

  try {
    const report = await SettlementService.getSettlementReport({
      month: monthParam,
      year: yearParam,
      teamId,
      searchQuery,
      statusFilter,
    });
    return NextResponse.json(report);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

