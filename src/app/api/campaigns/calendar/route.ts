import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getCalendarMonthCampaigns } from "@/lib/mobile-calendar-data";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;
  const monthParam = searchParams.get("month");

  const now = new Date();
  const [year, month] = monthParam
    ? monthParam.split("-").map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  const campaigns = await getCalendarMonthCampaigns(year, month);
  return NextResponse.json({ campaigns });
}
