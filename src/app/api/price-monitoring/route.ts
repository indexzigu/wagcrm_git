import { NextResponse } from "next/server";
import { fetchAllMarketPrices } from "@/lib/price-monitor/market-fetch";

// 소스 호출 로직(네이버/쿠팡/카카오 선물하기)은 lib/price-monitor/market-fetch.ts로 추출해
// cron/price-monitoring/route.ts와 공유한다("모달과 판정 로직 일원화").
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { query } = body;

    if (!query) return NextResponse.json({ error: "No query provided" }, { status: 400 });

    const { allItems, minItem, errors } = await fetchAllMarketPrices(query);

    return NextResponse.json({
      success: true,
      minItem,
      allItems,
      errors,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
