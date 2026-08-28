import { NextRequest, NextResponse } from 'next/server';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { requireAuth } from '@/lib/api-auth';
import { syncOrdersByIds, normalizeQueriedOrder } from '@/lib/order-converter/naver-order-sync';
import { deriveClaimsFromOrder } from '@/lib/order-converter/claim-derive';

// 발송지연 안내 실행 — 상품주문 건별 POST /v1/pay-order/seller/product-orders/{id}/delay.
//
// ⚠️ 이 API는 고객에게 취소 불가능한 문자/네이버 알림을 즉시 발송한다. 같은 건에 재호출하면
// 고객이 알림을 또 받는다(재알림). 클라이언트(DelayDispatchModal)가 2단계 확인을 강제하지만,
// 서버도 사전 상태조회로 발송 가능 상태(PAYED/PRODUCT_READY)와 클레임 미진행을 재검증한다.
//
// dispatch(발송처리) 라우트와 동일 패턴: ① query API 300건 청크 사전 상태조회 → 통과/스킵 분류
// ② 통과분 건별 /delay 호출(순차, 실패해도 계속) ③ 집계 반환 ④ 성공분 syncOrdersByIds 즉시 반영.

const QUERY_CHUNK_SIZE = 300;

const DELAY_REASONS = new Set([
  'PRODUCT_PREPARE', // 상품준비중
  'CUSTOMER_REQUEST', // 고객요청
  'CUSTOM_BUILD', // 주문제작
  'RESERVED_DISPATCH', // 예약발송
  'OVERSEA_DELIVERY', // 해외배송
  'ETC', // 기타
]);

interface DelayRequest {
  productOrderId: string;
  dispatchDueDate: string;
  delayedDispatchReason: string;
  dispatchDelayedDetailedReason: string;
}

/** KST 기준 날짜키(YYYY-MM-DD) — 과거 발송예정일 검증용 */
function toKstDayKey(d: Date): string {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function sanitizeRequests(raw: unknown): { requests: DelayRequest[] } | { error: string } {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as any).requests)) {
    return { error: 'requests is required and must be a non-empty array' };
  }
  const list = (raw as any).requests as unknown[];
  if (list.length === 0) {
    return { error: 'requests is required and must be a non-empty array' };
  }

  const todayKey = toKstDayKey(new Date());
  const requests: DelayRequest[] = [];
  for (const item of list) {
    const r = item as Record<string, unknown>;
    const productOrderId = typeof r?.productOrderId === 'string' ? r.productOrderId.trim() : '';
    const dispatchDueDate = typeof r?.dispatchDueDate === 'string' ? r.dispatchDueDate.trim() : '';
    const reason = typeof r?.delayedDispatchReason === 'string' ? r.delayedDispatchReason.trim() : '';
    const detail =
      typeof r?.dispatchDelayedDetailedReason === 'string' ? r.dispatchDelayedDetailedReason.trim() : '';

    if (!productOrderId) return { error: 'productOrderId가 없는 요청이 있습니다.' };
    if (!DELAY_REASONS.has(reason)) {
      return { error: `유효하지 않은 지연 사유입니다: ${reason || '(빈 값)'}` };
    }
    const due = new Date(dispatchDueDate);
    if (!dispatchDueDate || isNaN(due.getTime())) {
      return { error: '발송예정일(dispatchDueDate)이 유효한 날짜가 아닙니다.' };
    }
    // 과거 발송예정일은 네이버가 검증 실패시키지만, 고객 알림이 나가기 전에 서버에서 선차단한다.
    if (toKstDayKey(due) < todayKey) {
      return { error: '발송예정일이 오늘(KST) 이전입니다.' };
    }
    if (!detail) {
      return { error: '상세 사유(dispatchDelayedDetailedReason)가 비어 있습니다. 고객에게 그대로 노출되는 문구입니다.' };
    }
    requests.push({ productOrderId, dispatchDueDate, delayedDispatchReason: reason, dispatchDelayedDetailedReason: detail });
  }
  return { requests };
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  try {
    const body = await request.json().catch(() => null);
    const sanitized = sanitizeRequests(body);
    if ('error' in sanitized) {
      return NextResponse.json({ error: sanitized.error }, { status: 400 });
    }
    const { requests } = sanitized;

    // 1. 사전 상태조회 (300건 청크) — 상태 + 클레임 진행 여부를 함께 파생
    const productOrderIds = requests.map((r) => r.productOrderId);
    const statusMap: Record<string, string> = {};
    const claimInProgressSet = new Set<string>();

    for (let i = 0; i < productOrderIds.length; i += QUERY_CHUNK_SIZE) {
      const chunkIds = productOrderIds.slice(i, i + QUERY_CHUNK_SIZE);
      const queryData = await apiRequest('POST', '/v1/pay-order/seller/product-orders/query', {
        productOrderIds: chunkIds,
      });
      const rows: any[] = queryData?.data && Array.isArray(queryData.data) ? queryData.data : [];
      for (const wrapper of rows) {
        const order = wrapper?.productOrder || wrapper;
        if (!order?.productOrderId) continue;
        const id = String(order.productOrderId);
        statusMap[id] = order.productOrderStatus;
        // 클레임 진행 판정은 claim-derive의 기존 판정 재사용(normalizeQueriedOrder가 __claim을 채운다).
        const normalized = wrapper?.productOrder ? normalizeQueriedOrder(wrapper) : order;
        try {
          const claims = deriveClaimsFromOrder(normalized);
          if (claims.some((c) => !c.isCompleted)) claimInProgressSet.add(id);
        } catch {
          // claim 파생 실패는 통과로 두지 않고 보수적으로 skip 대상에 넣지도 않는다 — 상태 필터가 뒤에서 재검증.
        }
      }
    }

    // 2. 사전 필터: 클레임 진행 skip → 상태 미확인 skip → PAYED/PRODUCT_READY만 통과
    const validRequests: DelayRequest[] = [];
    const skipped: Array<{ productOrderId: string; reason: string }> = [];

    for (const req of requests) {
      const status = statusMap[req.productOrderId];
      if (claimInProgressSet.has(req.productOrderId)) {
        skipped.push({ productOrderId: req.productOrderId, reason: 'CLAIM_IN_PROGRESS' });
      } else if (!status) {
        skipped.push({ productOrderId: req.productOrderId, reason: 'NOT_FOUND_OR_NO_STATUS' });
      } else if (status === 'PAYED' || status === 'PRODUCT_READY') {
        validRequests.push(req);
      } else {
        skipped.push({ productOrderId: req.productOrderId, reason: status });
      }
    }

    // 3. 통과분 건별 /delay 호출 — 순차 실행, 한 건 실패해도 나머지는 계속 처리한다.
    const succeededIds: string[] = [];
    const failed: Array<{ productOrderId: string; reason: string }> = [];

    for (const req of validRequests) {
      try {
        const res = await apiRequest(
          'POST',
          `/v1/pay-order/seller/product-orders/${encodeURIComponent(req.productOrderId)}/delay`,
          {
            dispatchDueDate: req.dispatchDueDate,
            delayedDispatchReason: req.delayedDispatchReason,
            dispatchDelayedDetailedReason: req.dispatchDelayedDetailedReason,
          },
        );

        // 응답 스키마는 dispatch 계열과 동일 계열로 추정: data.successProductOrderIds[] /
        // data.failProductOrderInfos[{productOrderId, code, message}]. 방어적으로 양쪽 depth 체크.
        const resBody = res?.data ?? res ?? {};
        const failInfos: any[] = resBody.failProductOrderInfos || resBody.data?.failProductOrderInfos || [];
        const failInfo = failInfos.find(
          (f: any) => !f?.productOrderId || String(f.productOrderId) === req.productOrderId,
        );
        if (failInfo) {
          failed.push({
            productOrderId: req.productOrderId,
            reason: `${failInfo.code || ''} ${failInfo.message || ''}`.trim() || 'DELAY_FAILED',
          });
        } else {
          succeededIds.push(req.productOrderId);
        }
      } catch (err: any) {
        failed.push({
          productOrderId: req.productOrderId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (failed.length > 0) {
      console.warn('[발송지연 부분 실패]', JSON.stringify(failed).slice(0, 500));
    }

    // 4. 성공분 스냅샷 즉시 반영 — shippingDueDate·지연 사유 필드가 query-by-id로 확정 반영된다
    //    (dispatch 라우트와 동일 패턴, 변경피드 비의존).
    try {
      if (succeededIds.length > 0) await syncOrdersByIds(succeededIds);
    } catch (patchErr) {
      console.warn('발송지연 후 스냅샷 반영 실패:', patchErr);
    }

    return NextResponse.json({
      successCount: succeededIds.length,
      failCount: failed.length,
      skipCount: skipped.length,
      failed,
      skipped,
      firstFailReason: failed[0]?.reason || null,
    });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Delay Dispatch API Error:', errorMsg);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
