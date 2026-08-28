import { NextRequest, NextResponse } from 'next/server';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { runSync, syncOrdersByIds } from '@/lib/order-converter/naver-order-sync';

const ALREADY_DISPATCHED_STATUSES = new Set(['DELIVERING', 'DELIVERED', 'PURCHASE_DECIDED']);

// 발송 처리
export async function POST(request: NextRequest) {
  try {
    const { dispatchRequests } = await request.json();
    
    if (!dispatchRequests || !Array.isArray(dispatchRequests) || dispatchRequests.length === 0) {
      return NextResponse.json({ error: 'dispatchRequests is required and must be a non-empty array' }, { status: 400 });
    }

    // 1. 상태 조회를 위한 productOrderIds 추출
    const productOrderIds = dispatchRequests.map((r: any) => r.productOrderId);

    // 2. 최대 300건 제한이 있으므로, 안전하게 300건씩 상태 조회
    const allQueryContents: any[] = [];
    const QUERY_CHUNK_SIZE = 300;
    for (let i = 0; i < productOrderIds.length; i += QUERY_CHUNK_SIZE) {
      const chunkIds = productOrderIds.slice(i, i + QUERY_CHUNK_SIZE);
      const queryData = await apiRequest('POST', '/v1/pay-order/seller/product-orders/query', {
        productOrderIds: chunkIds
      });
      if (queryData && queryData.data && Array.isArray(queryData.data)) {
        allQueryContents.push(...queryData.data);
      }
    }

    // 3. 응답 분석 (상태 필터링 및 캐시 무효화를 위한 날짜 추출)
    const statusMap: Record<string, string> = {};
    const datesToInvalidate = new Set<string>();

    for (const wrapper of allQueryContents) {
      // 네이버 응답 구조에 맞게 (productOrder 가 있는지 확인)
      const order = wrapper.productOrder || wrapper; // 혹시 몰라 fallback
      if (order && order.productOrderId) {
        statusMap[order.productOrderId] = order.productOrderStatus;

        const orderInfo = wrapper.order || {};
        const orderTimeStr = orderInfo.paymentDate || orderInfo.orderDate || orderInfo.orderCreateDate || order.paymentDate || order.orderDate;
        if (orderTimeStr) {
          const dKst = new Date(new Date(orderTimeStr).getTime() + 9 * 60 * 60 * 1000);
          const yyyy = dKst.getUTCFullYear();
          const mm = String(dKst.getUTCMonth() + 1).padStart(2, '0');
          const dd = String(dKst.getUTCDate()).padStart(2, '0');
          datesToInvalidate.add(`${yyyy}-${mm}-${dd}`);
        }
      }
    }

    const validRequests: any[] = [];
    const skipped: any[] = [];
    const alreadyDispatchedIds: string[] = [];

    for (const req of dispatchRequests) {
      const status = statusMap[req.productOrderId];
      
      if (!status) {
        skipped.push({ productOrderId: req.productOrderId, reason: 'NOT_FOUND_OR_NO_STATUS' });
      } else if (status === 'PAYED' || status === 'PRODUCT_READY') {
        validRequests.push(req);
      } else {
        skipped.push({ productOrderId: req.productOrderId, reason: status });
        if (ALREADY_DISPATCHED_STATUSES.has(status)) {
          alreadyDispatchedIds.push(req.productOrderId);
        }
      }
    }

    // 4. 발송 처리 진행
    let dispatchData: any = null;
    let dispatchSuccessCount = 0;
    let dispatchFailCount = 0;
    const dispatchFailed: any[] = [];
    // query-by-id 정밀 갱신(syncOrdersByIds)이 실패했는가 — 실패했을 때만 dirty 폴백을 켠다.
    let snapshotRefreshFailed = false;

    if (validRequests.length > 0) {
      dispatchData = await apiRequest('POST', '/v1/pay-order/seller/product-orders/dispatch', {
        dispatchProductOrders: validRequests
      });

      // 네이버 발송처리 응답의 실제 성공/실패를 파싱한다(발주확인과 동일 스키마).
      // 실측 스키마(2026-07-07): { successProductOrderInfos: [{productOrderId,...}],
      //                            failProductOrderInfos: [{productOrderId, code, message}] }
      const body = dispatchData?.data ?? dispatchData ?? {};
      const okInfos: any[] = body.successProductOrderInfos || body.data?.successProductOrderInfos || [];
      const failInfos: any[] = body.failProductOrderInfos || body.data?.failProductOrderInfos || [];
      const hasInfo = okInfos.length > 0 || failInfos.length > 0;
      // 응답에 성공/실패 목록이 둘 다 없으면(스키마 상이·무응답) 시도분 전체를 성공으로 간주
      dispatchSuccessCount = hasInfo ? okInfos.length : validRequests.length;
      dispatchFailCount = failInfos.length;
      for (const f of failInfos) {
        dispatchFailed.push({
          productOrderId: f.productOrderId,
          reason: `${f.code || ''} ${f.message || ''}`.trim() || 'DISPATCH_FAILED',
        });
      }
      if (failInfos.length > 0) {
        console.warn('[발송처리 부분 실패]', JSON.stringify(failInfos).slice(0, 500));
      }

      // 동시 제출 레이스(TOCTOU) 멱등 처리 — 사전 상태조회(2단계) 시점엔 PAYED였지만,
      // 다른 런이 먼저 발송처리에 성공해 이 런의 dispatch 시점엔 이미 DELIVERING인 주문은
      // 네이버가 '9999 주문상태 및 클레임상태를 확인하세요'로 실패 처리한다. 실피해가
      // 아니라 이미 완료된 건이므로, 실패분을 ID로 재조회해 배송중 이상 상태면 fail이 아닌
      // skip으로 재분류한다(2026-07-10 실사고: 고유 87건이 이 사유로 부분실패 오인).
      const reclassifiedIds: string[] = [];
      if (dispatchFailed.length > 0) {
        try {
          const failedIds = dispatchFailed.map((f) => f.productOrderId).filter(Boolean);
          const recheckStatus: Record<string, string> = {};
          for (let i = 0; i < failedIds.length; i += QUERY_CHUNK_SIZE) {
            const chunkIds = failedIds.slice(i, i + QUERY_CHUNK_SIZE);
            const recheckData = await apiRequest('POST', '/v1/pay-order/seller/product-orders/query', {
              productOrderIds: chunkIds,
            });
            const rows: any[] = recheckData?.data && Array.isArray(recheckData.data) ? recheckData.data : [];
            for (const wrapper of rows) {
              const order = wrapper.productOrder || wrapper;
              if (order && order.productOrderId) recheckStatus[order.productOrderId] = order.productOrderStatus;
            }
          }
          const stillFailed: any[] = [];
          for (const f of dispatchFailed) {
            const st = recheckStatus[f.productOrderId];
            if (st && ALREADY_DISPATCHED_STATUSES.has(st)) {
              skipped.push({ productOrderId: f.productOrderId, reason: `ALREADY_DISPATCHED_${st}` });
              reclassifiedIds.push(f.productOrderId);
            } else {
              stillFailed.push(f);
            }
          }
          if (reclassifiedIds.length > 0) {
            dispatchFailed.length = 0;
            dispatchFailed.push(...stillFailed);
            dispatchFailCount = stillFailed.length;
            console.warn(`[발송처리 레이스 재분류] ${reclassifiedIds.length}건 fail→skip (이미 배송중 이상, 타 런이 선처리)`);
          }
        } catch (recheckErr) {
          console.warn('발송처리 실패분 상태 재확인 실패:', recheckErr);
        }
      }

      // 실제 발송 성공한 주문만 ID로 직접 재조회해 스냅샷에 즉시 반영(배송대기→배송중).
      // DISPATCHED가 변경피드에 안 잡히거나 반영이 지연돼도 query-by-id로 확정 반영하므로 피드에 비의존적이다.
      // 레이스로 재분류된 건(타 런이 배송중 처리)도 스냅샷 확정 반영 대상에 포함한다.
      try {
        const succeededIds = hasInfo
          ? okInfos.map((o: any) => o.productOrderId).filter(Boolean)
          : validRequests.map((r: any) => r.productOrderId).filter(Boolean);
        const idsToSync = [...new Set([...succeededIds, ...reclassifiedIds, ...alreadyDispatchedIds])];
        if (idsToSync.length > 0) await syncOrdersByIds(idsToSync);
      } catch (patchErr) {
        snapshotRefreshFailed = true;
        console.warn('발송처리 후 스냅샷 반영 실패:', patchErr);
      }
    } else if (alreadyDispatchedIds.length > 0) {
      try {
        await syncOrdersByIds([...new Set(alreadyDispatchedIds)]);
      } catch (patchErr) {
        snapshotRefreshFailed = true;
        console.warn('이미 배송중 주문 스냅샷 반영 실패:', patchErr);
      }
    }

    if (validRequests.length > 0 || alreadyDispatchedIds.length > 0) {
      // 무효화는 **정밀 갱신이 실패했을 때의 폴백이다.** 위 syncOrdersByIds가 상태가 바뀐 주문을
      // query-by-id로 재조회해 그 날짜를 `isDirty:false`로 upsert하므로, 성공한 경우 그 날짜는
      // 이미 권위 있게 최신이다 — 여기서 다시 dirty로 찍으면 **방금 자기가 한 갱신을 되돌린다.**
      // (종전 코드가 정확히 그랬고, `markAllDirty()`가 30일을 찍어 플래그가 상시 true로 고착됐다.)
      // 반대로 syncOrdersByIds가 실패하면 스냅샷은 발송 전 상태로 남으므로, 그때는 아는 날짜
      // (결제일자 기준 datesToInvalidate)만 dirty로 찍어 다음 GET의 SWR이 재조회하게 한다.
      // 이 갈래가 없으면 재조회 실패가 console.warn 하나로 조용히 묻힌다(P0 No Silent Failure).
      if (snapshotRefreshFailed) {
        const dates = [...datesToInvalidate];
        const dailyCache = (global as any).__naverDailyCache;
        if (dailyCache) {
          for (const date of dates) {
            if (dailyCache[date]) dailyCache[date].isDirty = true;
          }
        }
        // L1이 콜드스타트로 비어 있을 수 있으므로 DB 스냅샷도 함께 찍는다.
        naverOrderSnapshotRepository.markDirty(dates).catch(console.warn);
      }
      runSync('CHANGED').catch(console.warn);
    }

    return NextResponse.json({
      successCount: dispatchSuccessCount,
      failCount: dispatchFailCount,
      skipCount: skipped.length,
      skipped,
      failed: dispatchFailed,
      firstFailReason: dispatchFailed[0]?.reason || null,
      dispatchResponse: dispatchData
    });
  } catch (error: any) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error('Dispatch API Error:', errorMsg);
    return NextResponse.json({ error: errorMsg }, { status: 500 });
  }
}
