import { NextRequest, NextResponse } from 'next/server';
import { runSync } from '@/lib/order-converter/naver-order-sync';

// 수동 새로고침 엔드포인트. GET(dashboard-stats/campaigns)이 read-only로 전환됨에 따라
// 클라이언트가 "지금 당장 최신화"를 원할 때 사용하는 유일한 동기 트리거 경로다.
// 다른 order-converter API와 동일한 노출 수준이라 CRON_SECRET을 요구하지 않는다.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const mode: 'CHANGED' | 'FULL' = body?.mode === 'FULL' ? 'FULL' : 'CHANGED';
    const range = body?.range;

    if (mode === 'FULL' && (!range?.startDateKey || !range?.endDateKey)) {
      return NextResponse.json(
        { error: 'mode=FULL requires range.startDateKey and range.endDateKey' },
        { status: 400 }
      );
    }

    const result = await runSync(mode, range);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error('[naver/sync] Error:', error);
    return NextResponse.json({ error: error?.message || 'Sync failed' }, { status: 500 });
  }
}
