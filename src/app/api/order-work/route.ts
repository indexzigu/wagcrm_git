import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/api-auth';
import { loadOrderWorkSummary } from '@/lib/order-converter/order-work-summary';

const ORDER_WORK_ERROR_MESSAGE = '오늘 처리할 주문을 집계하지 못했습니다. 잠시 뒤 다시 불러오세요.';

// 홈 「오늘 처리할 주문」 카드 — 숫자만 내려주는 읽기 전용 GET.
//
// ⛔ 이 경로에서 네이버를 부르지 말 것(동기화 트리거·스토어 조회 포함). 저장된 스냅샷·DB 만 읽는다
// (`order-work-summary.ts` 헤더). 주문 목록이나 개인정보를 싣지 않는다 — 주기 갱신이 목록을 실으면
// 상시 egress 가 된다(P7 Notification Badge Polling = countOnly 와 같은 규율).
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const summary = await loadOrderWorkSummary();
    return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    // 원인은 서버 로그에만 남긴다 — DB·드라이버 오류 문구는 접속 대상 같은 내부 정보를 담을 수 있다.
    console.error('[api/order-work] 오늘 처리할 주문 집계 실패:', error);
    return NextResponse.json({ error: ORDER_WORK_ERROR_MESSAGE }, { status: 500 });
  }
}
