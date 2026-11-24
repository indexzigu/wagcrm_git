import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getCalendarMonthCampaigns } from "@/lib/mobile-calendar-data";
import { fetchIcloudFinanceEvents } from "@/lib/icloud-finance-schedule";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;
  const monthParam = searchParams.get("month");

  const now = new Date();
  const [year, month] = monthParam
    ? monthParam.split("-").map(Number)
    : [now.getFullYear(), now.getMonth() + 1];

  const monthPadded = String(month).padStart(2, "0");
  const lastDay = new Date(year, month, 0).getDate();
  const windowStart = `${year}-${monthPadded}-01`;
  const windowEnd = `${year}-${monthPadded}-${String(lastDay).padStart(2, "0")}`;

  const [campaigns, financeEvents] = await Promise.all([
    getCalendarMonthCampaigns(year, month),
    fetchIcloudFinanceEvents(windowStart, windowEnd),
  ]);
  return NextResponse.json({ campaigns, financeEvents });
}
