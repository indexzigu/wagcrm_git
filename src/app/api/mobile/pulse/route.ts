import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getMobilePulse } from "@/lib/mobile-pulse-loader";

/**
 * GET /api/mobile/pulse — 모바일 판매 펄스 (MOBILE_UX_PLAN §3-2 · Phase 2).
 *
 * 읽기 전용: DB에 영속화된 NaverOrderSnapshot·SalesCampaign 만 읽는다.
 * 네이버 동기화(runSync)·네이버 API fetch·after() 백그라운드 작업을 일절
 * 트리거하지 않는다 — 신선도는 응답의 asOf 로 노출하고, 갱신은 데스크탑
 * 대시보드의 기존 SWR 경로에 맡긴다.
 *
 * 캐싱: nextConfig.cacheComponents 모드라 route segment config(dynamic)는 금지 —
 * "use cache" 를 쓰지 않는 이 핸들러는 기본이 동적(매 요청 DB 조회)이다.
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const pulse = await getMobilePulse();
    return NextResponse.json(pulse);
  } catch (error) {
    console.error("GET /api/mobile/pulse failed:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to load mobile pulse" },
      { status: 500 },
    );
  }
}
