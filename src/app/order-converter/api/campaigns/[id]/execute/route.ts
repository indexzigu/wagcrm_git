import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { generateOrderExcelBuffer } from '@/lib/order-converter/excel-generator';
import { loadOrderTemplateBuffer, resolveOrderBrand } from '@/lib/order-converter/order-brand';
import { syncOrdersByIds } from '@/lib/order-converter/naver-order-sync';
import { interleaveAddonRows } from '@/lib/order-converter/group-orders';
import { orderMatchesCampaignProductId } from '@/lib/order-converter/campaign-match';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';
import {
  createNaverCallTally,
  noteNaverLogicalCall,
  noteNaverSkippedCall,
  recordNaverOperationUsage,
  runWithNaverCallTally,
  toNaverEndpointLabel,
} from '@/lib/order-converter/naver-api-usage';
import { fetchPendingOrderWindow, PENDING_FULFILLMENT_STATUSES } from '@/lib/order-converter/order-fetch-window';
import { resolveCampaignQueryStartMs } from '@/lib/order-converter/mapping-service';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';

// 발주요청(이메일 첨부) 경로도 이 라우트를 사용 — 전체기간 재조회+발주확인+엑셀 생성이
// 한 함수라 기본 실행시간 한도에 걸리면 발주확인이 끊긴 채 파일만 생성됨. stream과 동일 상향.
export const maxDuration = 300;

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // 네이버 호출 계측(P7) — 이 라우트는 실패를 throw 하지 않고 4xx/5xx JSON 으로 돌려주는
  // 경로가 여럿이라, 응답 상태코드로 성공/실패를 판정한다(조기 반환도 실패로 기록).
  const tally = createNaverCallTally();
  const opStartedAt = Date.now();
  let opResponse: NextResponse | null = null;
  let opThrownError: unknown = null;

  try {
    opResponse = await runWithNaverCallTally(tally, async () => {
    const { id: campaignId } = await params;
    const url = new URL(request.url);
    const action = url.searchParams.get('action'); // 'download' or 'email'
    const includePending = url.searchParams.get('includePending') === 'true'; // 배송대기건 포함 여부

    // 1. 캠페인 및 매핑 룰 로드
    // salesCampaigns 동승 — 조회창 시작 SSOT(resolveCampaignQueryStartMs)가 요구한다(P7).
    const campaign = await prisma.orderCampaign.findUnique({
      where: { id: campaignId },
      include: { mappings: true, salesCampaigns: { select: { startDate: true, endDate: true } } }
    });
    
    const activeCampaigns = await prisma.orderCampaign.findMany({
      where: { isActive: true },
    });

    if (!campaign) {
      return NextResponse.json({ error: '캠페인을 찾을 수 없습니다.' }, { status: 404 });
    }

    if (!campaign.template) {
      return NextResponse.json({ error: '캠페인에 지정된 베이스 템플릿이 없습니다.' }, { status: 400 });
    }

    // 2. 네이버 주문 내역 조회 — 창·청크·생략 판정은 order-fetch-window SSOT 에 위임한다
    // (주문확인 스트림 라우트와 **같은 헬퍼**. 종전엔 두 라우트가 조회 로직을 복사해 갖고
    // 있었고 상태 필터가 이미 어긋나 있었다 — 이쪽은 PRODUCT_READY 를 빼먹고 있었다).
    const now = new Date();
    const queryStartMs =
      resolveCampaignQueryStartMs(campaign as any) ??
      now.getTime() - 14 * 24 * 60 * 60 * 1000; // 기간 정보가 전무할 때만 쓰는 안전망

    const fetchResult = await fetchPendingOrderWindow(queryStartMs, {
      apiRequest: (method, path, body, query) => apiRequest(method, path, body, query),
      loadSnapshotCounts: (from, to) => naverOrderSnapshotRepository.findRangeCounts(from, to),
      loadLatestCursorIso: async () =>
        (await naverOrderSnapshotRepository.findLatestCursor())?.lastChangeStatusCursor ?? null,
      onLogicalCall: () => noteNaverLogicalCall(tally),
      onSkipped: () => noteNaverSkippedCall(tally),
      nowMs: now.getTime(),
    });

    if (fetchResult.failure) {
      return NextResponse.json(
        { error: `주문 조회 실패(${fetchResult.failure.dateKey}): ${fetchResult.failure.message}. 누락된 발주서 생성을 막기 위해 중단했습니다. 잠시 후 다시 시도하세요.` },
        { status: 502 },
      );
    }

    // 조회 수 대조는 관측 신호로만 쓴다(차단하지 않는다) — stream 라우트와 동일 이유.
    // 프로덕션 실측에서 오탐이 확인됐다: 스냅샷의 날짜 귀속(paymentDate 폴백)과 범위 조회의
    // 결제일 기준이 달라 두 수가 같은 술어로 센 값이 아니다(헬퍼 주석 참조).
    if (fetchResult.integrityIssues.length > 0) {
      console.warn(
        '[execute] 조회 수 대조 불일치(관측 신호 — 발주서 생성은 계속):',
        JSON.stringify(fetchResult.integrityIssues),
      );
    }

    const detailsData: any[] = fetchResult.items;

    // 3. 매핑 테이블을 기반으로 주문 필터링 및 브랜드 코드 주입
    // 배송대기(기발송) 건 제외를 위한 세트 로드
    let poRequestedSet = new Set<string>();
    try {
      poRequestedSet = await orderFulfillmentRepository.getPoRequestedSet(
        detailsData.map(w => w.productOrder?.productOrderId).filter(Boolean)
      );
    } catch (err) {
      console.warn('[execute/route] poRequested 집합 로드 실패:', err);
    }

    const mainRows: any[] = [];
    const addonRows: any[] = [];
    // 추가구성상품(추가옵션) 귀속용 — stream 라우트와 동일 규칙
    const campaignProductIds = new Set<string>();
    const deferredAddonWrappers: any[] = [];

    detailsData.forEach(orderWrapper => {
      const order = orderWrapper.productOrder;
      if (!order) return;
      // 발주 대상 판정을 order-fetch-window SSOT 로 통일 — 종전 이 라우트는 PRODUCT_READY 를
      // 빼먹어 스트림 라우트와 결과가 갈릴 수 있었다(같은 캠페인, 다른 발주서).
      if (!(PENDING_FULFILLMENT_STATUSES as readonly string[]).includes(order.productOrderStatus)) return;

      // 배송대기건 포함 여부(includePending)가 false인데 이미 발송된 건이면 제외
      if (!includePending && poRequestedSet.has(String(order.productOrderId || ''))) {
        return;
      }

      if (order.productClass === '추가구성상품') {
        deferredAddonWrappers.push(orderWrapper);
        return;
      }

      const pName = order.productName || '';
      const oName = order.productOption || '';
      
      const normalize = (str: string) => (str || '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
      const normPName = normalize(pName);
      const normOName = normalize(oName);

      const matchedMapping = campaign.mappings.find(m => {
        const hasProduct = !!m.productName;
        const hasOption = !!m.optionName;
        if (!hasProduct && !hasOption) return false;

        let productMatches = false;
        if (hasProduct) {
          const normMProd = normalize(m.productName);
          if (normMProd.length > 0) {
            productMatches = (normPName.length > 0 && (normPName.includes(normMProd) || normMProd.includes(normPName))) ||
                             (normOName.length > 0 && (normOName.includes(normMProd) || normMProd.includes(normOName)));
          }
        }

        let optionMatches = false;
        if (hasOption) {
          const normMOpt = normalize(m.optionName);
          if (normMOpt.length > 0) {
            optionMatches = (normOName.length > 0 && (normOName.includes(normMOpt) || normMOpt.includes(normOName))) ||
                            (normPName.length > 0 && (normPName.includes(normMOpt) || normMOpt.includes(normPName)));
          }
        }

        if (hasOption && optionMatches) return true;
        if (hasProduct && !hasOption && productMatches) return true;
        return productMatches || optionMatches;
      });

      let isCampaignOrder = false;
      let matchesCampName = false;

      if (campaign.productId && (order.productId != null || order.originalProductId != null)) {
        if (orderMatchesCampaignProductId(order, campaign.productId)) {
          if (pName.includes(campaign.name) || campaign.name.includes(pName)) {
            matchesCampName = true;
          }
        }
      } else {
        if (pName.includes(campaign.name) || campaign.name.includes(pName)) {
          matchesCampName = true;
        }
      }

      if (matchesCampName) {
        isCampaignOrder = true;
      } else if (matchedMapping) {
        // 매핑 룰에 맞더라도 상품명이 '다른 캠페인명'을 명시적으로 포함하고 있으면 무시
        const belongsToOther = activeCampaigns.some((otherCamp: any) => 
          otherCamp.id !== campaign.id && (pName.includes(otherCamp.name) || otherCamp.name.includes(pName))
        );
        if (!belongsToOther) {
          isCampaignOrder = true;
        }
      }

      if (isCampaignOrder) {
        if (order.productId) campaignProductIds.add(String(order.productId));
        // YYYY-MM-DD HH:MM 형식으로 변환
        const rawDate = orderWrapper.order?.orderDate || order.paymentDate || order.orderDate || order.placeOrderStatusDate || '';
        let formattedDate = rawDate;
        if (rawDate && rawDate.includes('T')) {
          formattedDate = rawDate.replace('T', ' ').slice(0, 16);
        }

        mainRows.push({
          _orderId: orderWrapper.order?.orderId || order.orderId || '',
          주문일: formattedDate,
          상품주문번호: order.productOrderId || '',
          구매자명: orderWrapper.order?.ordererName || order.shippingAddress?.name || '',
          구매자연락처: orderWrapper.order?.ordererTel || '',
          수취인명: order.shippingAddress?.name || '',
          수취인연락처1: order.shippingAddress?.tel1 || '',
          수취인연락처2: order.shippingAddress?.tel2 || '',
          우편번호: order.shippingAddress?.zipCode || '',
          배송지: order.shippingAddress?.baseAddress + ' ' + (order.shippingAddress?.detailedAddress || ''),
          옵션정보: oName,
          수량: order.quantity || 1,
          배송비: order.shippingFee || '0',
          배송메시지: order.shippingAddress?.shippingMemo || '',
          사은품: '',
          _placeOrderStatus: order.placeOrderStatus
        });
      }
    });

    // 3-2. 추가구성상품 2차 귀속: 동일 productId의 메인 품목이 이 캠페인에 매칭된 경우 포함
    // (발주서 실림 + 발주확인 대상 포함, stream 라우트와 동일 규칙)
    deferredAddonWrappers.forEach(orderWrapper => {
      const order = orderWrapper.productOrder;
      if (!order?.productId || !campaignProductIds.has(String(order.productId))) return;

      // 배송대기건 포함 여부(includePending)가 false인데 이미 발송된 건이면 제외
      if (!includePending && poRequestedSet.has(String(order.productOrderId || ''))) {
        return;
      }

      const rawDate = orderWrapper.order?.orderDate || order.paymentDate || order.orderDate || order.placeOrderStatusDate || '';
      const formattedDate = rawDate && rawDate.includes('T') ? rawDate.replace('T', ' ').slice(0, 16) : rawDate;

      addonRows.push({
        _orderId: orderWrapper.order?.orderId || order.orderId || '',
        주문일: formattedDate,
        상품주문번호: order.productOrderId || '',
        구매자명: orderWrapper.order?.ordererName || order.shippingAddress?.name || '',
        구매자연락처: orderWrapper.order?.ordererTel || '',
        수취인명: order.shippingAddress?.name || '',
        수취인연락처1: order.shippingAddress?.tel1 || '',
        수취인연락처2: order.shippingAddress?.tel2 || '',
        우편번호: order.shippingAddress?.zipCode || '',
        배송지: order.shippingAddress?.baseAddress + ' ' + (order.shippingAddress?.detailedAddress || ''),
        옵션정보: order.productOption || '',
        수량: order.quantity || 1,
        배송비: order.shippingFee || '0',
        배송메시지: order.shippingAddress?.shippingMemo || '',
        사은품: '',
        _placeOrderStatus: order.placeOrderStatus
      });
    });

    // 3-3. 브랜드사 전달 목적: 주문(고객) 단위 그룹핑 — 추가옵션을 같은 주문의 메인 행
    // 바로 뒤에 배치해 브랜드사가 합포장 묶음을 인지하게 한다.
    const matchedOrders = interleaveAddonRows(mainRows, addonRows);

    if (matchedOrders.length === 0) {
      // "발주 대상 0건"과 "매핑 불일치"를 분리한다 — 처방이 정반대이고, 종전 문구는 전자에서도
      // 매핑이 깨진 것처럼 읽혔다(스트림 라우트와 동일 교정).
      const pendingLineCount = detailsData.filter(
        (w: any) =>
          w?.productOrder &&
          (PENDING_FULFILLMENT_STATUSES as readonly string[]).includes(w.productOrder.productOrderStatus),
      ).length;
      return NextResponse.json(
        {
          error:
            pendingLineCount === 0
              ? '지금 발주할 주문이 없습니다. 발주 대상(결제완료·상품준비중) 주문이 0건입니다. 매핑 설정 문제가 아닙니다.'
              : `발주 대상 주문 ${pendingLineCount}건이 있으나 이 캠페인의 매핑 룰에 맞는 건이 없습니다. 매핑 설정을 확인하세요.`,
          pendingLineCount,
        },
        { status: 404 },
      );
    }

    // [발주확인 처리] - 네이버 스마트스토어 API 호출
    // placeOrderStatus가 'NOT_YET' (발주대기) 인 건만 발주확인 API 호출.
    // 청크 30(제한/레이트리밋 대응) + 응답 실패 목록 집계 + 429 1회 재시도 (stream 라우트와 동일)
    const ordersToConfirm = matchedOrders.filter(o => o._placeOrderStatus === 'NOT_YET').map(o => o.상품주문번호).filter(Boolean);
    if (ordersToConfirm.length > 0) {
      const CHUNK_SIZE = 30;
      for (let i = 0; i < ordersToConfirm.length; i += CHUNK_SIZE) {
        const chunk = ordersToConfirm.slice(i, i + CHUNK_SIZE);
        let attempt = 0;
        while (attempt < 2) {
          attempt++;
          try {
            const res: any = await apiRequest('POST', '/v1/pay-order/seller/product-orders/confirm', {
              productOrderIds: chunk
            });
            const body = res?.data ?? res ?? {};
            const failInfos: any[] = body.failProductOrderInfos || body.data?.failProductOrderInfos || [];
            if (failInfos.length > 0) {
              console.warn(`[발주확인 부분 실패] (chunk ${i}):`, JSON.stringify(failInfos).slice(0, 500));
            }
            break;
          } catch (confirmErr: any) {
            const msg = confirmErr?.message || String(confirmErr);
            const isRateLimit = msg.includes('429') || msg.toUpperCase().includes('RATE');
            if (isRateLimit && attempt < 2) {
              await new Promise(r => setTimeout(r, 1200));
              continue;
            }
            console.warn(`발주 확인 처리 실패 (chunk ${i}, ${chunk.length}건):`, msg);
            break;
          }
        }
        await new Promise(r => setTimeout(r, 300));
      }
    }

    // 발주확인은 변경피드에 안 잡히므로, 매칭 주문 "전체"를 ID로 재조회해 스냅샷에 즉시 반영.
    // 이미 발주확인된 건(ordersToConfirm에 없음)도 스냅샷은 stale일 수 있어 전체가 대상 —
    // 그래야 재클릭 시에도 대시보드 발주확인전→후가 확실히 반영된다.
    const allMatchedIds = matchedOrders.map(o => o.상품주문번호).filter(Boolean);
    if (allMatchedIds.length > 0) {
      try {
        await syncOrdersByIds(allMatchedIds);
      } catch (patchErr) {
        console.warn('발주확인 후 스냅샷 반영 실패:', patchErr);
      }
    }

    // 4. 템플릿 엑셀 양식 로드 및 데이터 주입 (공통 모듈 사용)
    // F4 Phase 2: 검수 확정 규칙(excelRules)이 있으면 그 규칙이 양식의 유일 권위(D3).
    const orderBrand = await resolveOrderBrand(campaign.template);
    const outputBuffer = await generateOrderExcelBuffer({
      orders: matchedOrders,
      templateId: campaign.template,
      formatAdapter: orderBrand?.formatAdapter,
      excelRules: orderBrand?.excelRules,
      templateBuffer: await loadOrderTemplateBuffer(orderBrand),
      sellerName: campaign.sellerName,
      mappings: campaign.mappings
    });

    if (action === 'download') {
      const d = new Date();
      // KST (UTC+9) 변환
      const dKst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
      
      const yy = String(dKst.getUTCFullYear()).slice(2);
      const mm = String(dKst.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dKst.getUTCDate()).padStart(2, '0');
      const today = `${yy}${mm}${dd}`;

      const provider = orderBrand?.displayName || campaign.template || '기본';

      const encodedFilename = encodeURIComponent(`발주서_${provider}_와이그라운드_${campaign.sellerName}_${today}.xlsx`);
      
      // 태스크 생성 (1단계: 주문확인 처리)
      const yyyyMmDd = dKst.toISOString().slice(0, 10);
      const existingTask = await prisma.dailyOrderTask.findUnique({
        where: { campaignId_date: { campaignId, date: yyyyMmDd } }
      });
      if (!existingTask) {
        await prisma.dailyOrderTask.create({
          data: {
            campaignId,
            date: yyyyMmDd,
            status: 'PENDING'
          }
        });
      }

      return new NextResponse(outputBuffer as any, {
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodedFilename}`,
          // 발주요청 흐름(EmailSendModal)이 이 발주서에 실린 상품주문번호를 send-email으로 넘겨
          // 발송 성공 시 배송대기(poRequestedAt)를 상품주문 단위로 스탬프하도록 노출한다.
          'X-YGRD-Order-Ids': allMatchedIds.join(','),
          'Access-Control-Expose-Headers': 'X-YGRD-Order-Ids',
        }
      });
    }

    // if action === 'email' -> (To be implemented)
    return NextResponse.json({ success: true, message: '이메일 발송 기능은 구현 예정입니다.', ordersCount: matchedOrders.length });
    });
    return opResponse;
  } catch (error: any) {
    opThrownError = error;
    console.error('Execute API Error:', error);
    return NextResponse.json({ error: error.message || '처리 중 오류가 발생했습니다.' }, { status: 500 });
  } finally {
    // 발주요청(엑셀) 1회 = ApiCallLog 1행. 이 경로는 스킵 로직이 아예 없어 skipped 는 항상 0 —
    // 주문확인(confirm_order)과 같은 지표로 비교되도록 같은 요약을 남긴다.
    const status = opThrownError !== null ? 500 : (opResponse?.status ?? 500);
    // finally 에서 예외가 새면 이미 만든 응답(발주서 버퍼)이 버려지고 500이 된다 —
    // 계측 기록의 내부 catch 에 의존하지 않고 여기서 한 번 더 막는다.
    try {
      await recordNaverOperationUsage({
        operation: 'order_excel',
        endpointLabel: toNaverEndpointLabel('/v1/pay-order/seller/product-orders'),
        tally,
        success: status < 400,
        elapsedMs: Date.now() - opStartedAt,
        errorMessage: opThrownError ?? undefined,
        context: { httpStatus: status },
      });
    } catch (usageErr) {
      console.error('[execute] 네이버 호출 계측 기록 실패(발주서 생성은 영향 없음):', usageErr);
    }
  }
}
