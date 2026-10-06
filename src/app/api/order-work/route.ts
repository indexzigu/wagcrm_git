import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { loadOrderWorkSummary } from '@/lib/order-converter/order-work-summary';

// 홈 「오늘 처리할 주문」 카드 + 사이드바 「주문 관리」 배지 — 숫자만 내려주는 읽기 전용 GET.
//
// ⛔ 이 경로에서 네이버를 부르지 말 것(동기화 트리거·스토어 조회 포함). 저장된 스냅샷·DB 만 읽는다
// (`order-work-summary.ts` 헤더). 주문 목록이나 개인정보를 싣지 않는다 — 배지 폴링이 목록을 실으면
// 상시 egress 가 된다(P7 Notification Badge Polling = countOnly 와 같은 규율).
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const summary = await loadOrderWorkSummary();
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[api/order-work] 오늘 처리할 주문 집계 실패:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '오늘 처리할 주문을 집계하지 못했습니다.' },
      { status: 500 },
    );
  }
}
