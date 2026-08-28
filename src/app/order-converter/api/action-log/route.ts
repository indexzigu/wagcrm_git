import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/order-converter/prisma';
import { requireAuth } from '@/lib/api-auth';
import { sanitizeActionLogInput } from '@/lib/order-converter/action-log';

// 주문관리 액션 감사 로그.
//  POST — 4개 버튼 흐름 종료 후 클라이언트가 "사용자가 실제 본 집계" 1건을 기록.
//         actor 는 클라이언트를 신뢰하지 않고 서버가 requireAuth 로 도출한다.
//  GET  — 캠페인 상세 '작업 기록' 패널이 campaignId 로 최근 로그를 조회.

const GET_LIMIT = 50;

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const input = sanitizeActionLogInput(body);
  if (!input) {
    return NextResponse.json(
      { error: '유효하지 않은 로그 입력(action/status/campaignName 확인)' },
      { status: 400 },
    );
  }

  try {
    const log = await prisma.orderActionLog.create({
      data: {
        campaignId: input.campaignId,
        campaignName: input.campaignName,
        action: input.action,
        status: input.status,
        successCount: input.successCount,
        failCount: input.failCount,
        skipCount: input.skipCount,
        errorMessage: input.errorMessage,
        details: input.details === null ? Prisma.JsonNull : (input.details as Prisma.InputJsonValue),
        actor: auth.context.email || 'SYSTEM',
      },
      select: { id: true, createdAt: true },
    });
    return NextResponse.json({ ok: true, id: log.id, createdAt: log.createdAt });
  } catch (error) {
    // 감사 로그 기록 실패가 원 액션(발송처리 등)을 되돌리지는 않으므로, 500으로 알리되
    // 호출자는 이 실패를 치명적으로 다루지 않는다(콘솔 경고 후 무시).
    const msg = error instanceof Error ? error.message : String(error);
    console.error('OrderActionLog 기록 실패:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const campaignId = request.nextUrl.searchParams.get('campaignId');
  if (!campaignId) {
    return NextResponse.json({ error: 'campaignId is required' }, { status: 400 });
  }

  try {
    const logs = await prisma.orderActionLog.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
      take: GET_LIMIT,
    });
    return NextResponse.json({ logs });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error('OrderActionLog 조회 실패:', msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
