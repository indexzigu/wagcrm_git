import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/order-converter/prisma';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { generateOrderExcelBuffer } from '@/lib/order-converter/excel-generator';
import { loadOrderTemplateBuffer, resolveOrderBrand } from '@/lib/order-converter/order-brand';
import { syncOrdersByIds } from '@/lib/order-converter/naver-order-sync';
import { interleaveAddonRows } from '@/lib/order-converter/group-orders';
import { orderMatchesCampaignProductId } from '@/lib/order-converter/campaign-match';
import { isSupplementProduct } from '@/lib/order-converter/product-class';
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

// 주문확인 1클릭이 전체기간 재조회→발주확인→스냅샷 반영→엑셀 생성을 한 함수에서 수행 —
// 기본 실행시간 한도에 걸리면 발주확인이 중간에 끊긴 채 파일만 생성되는 무증상 사고가 남
// (2026-07-07 실사고: API는 정상인데 93건 미확인 잔류). analyze 라우트와 동일하게 상향.
export const maxDuration = 300;



export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: campaignId } = await params;
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // 네이버 호출 계측(P7) — 이 스트림은 에러를 throw 하지 않고 `sendEvent({error})` 로
      // 끝내는 경로가 여럿이라, 성공/실패 판정을 sendEvent 한 곳에서 가로채 모은다.
      // 그래야 조기 반환(캠페인 없음·청크 조회 실패)도 실패로 기록된다.
      const tally = createNaverCallTally();
      const opStartedAt = Date.now();
      let opErrorMessage: string | null = null;
      // 계측 요약의 성공/실패는 3분류다. `no-work`(발주할 주문이 없음)는 **정상 결과**이므로
      // 실패로 세지 않는다 — 그러지 않으면 실패율에 "네이버 장애"와 "할 일 없음"이 섞여
      // 지표를 신호로 쓸 수 없다(baseline 첫 행이 정확히 그 경우였다).
      // 홀더 객체를 쓰는 이유: 클로저(sendEvent)에서 대입하면 TS 가 `let` 을 초기값으로
      // 좁혀버려 finally 의 비교가 "겹치지 않는 타입"으로 오판된다.
      const op: { outcome: 'success' | 'no-work' | 'failure' } = { outcome: 'success' };
      // 조회 수 대조 불일치 — finally 의 계측 기록에서 읽으므로 바깥 스코프에 둔다.
      // ⚠️ 날짜만이 아니라 **수치까지** 담는다. rangeType 을 PAYED_DATETIME 으로 명시한
      // 변경(2026-07-30)의 전후 차이를 관측할 유일한 수단이 이 값이다 — API 기본값이
      // 무엇이었는지 확인할 수 없어 사전 증명이 불가능했기 때문이다. 기본값이 이미
      // PAYED_DATETIME 이었다면 이 수치가 그대로고, ORDERED_DATETIME 이었다면 달라진다.
      let fetchIntegrityDetail = '';

      const sendEvent = (data: any) => {
        if (data?.error) {
          if (opErrorMessage === null) opErrorMessage = String(data.error);
          if (op.outcome === 'success') op.outcome = 'failure';
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      try {
        await runWithNaverCallTally(tally, async () => {
        sendEvent({ progress: 5, message: '캠페인 데이터 로드 중...' });

        // 1. 캠페인 및 매핑 룰 로드
        // salesCampaigns 를 함께 싣는다 — 조회창 시작 SSOT(resolveCampaignQueryStartMs)가
        // "저장 창과 판매관리 창 중 이른 쪽"을 쓰기 때문이다(P7). 종전엔 startDate 만 봐서
        // 판매관리가 더 이르면 그 앞 구간 주문이 발주서에서 통째로 빠질 수 있었다.
        const campaign = await prisma.orderCampaign.findUnique({
          where: { id: campaignId },
          include: { mappings: true, salesCampaigns: { select: { startDate: true, endDate: true } } }
        });
        
        const activeCampaigns = await prisma.orderCampaign.findMany({
          where: { isActive: true },
        });

        if (!campaign || !campaign.template) {
          sendEvent({ error: '캠페인 또는 템플릿을 찾을 수 없습니다.' });
          return;
        }

        // 2. 네이버 주문 내역 조회 — 창·청크·생략 판정은 order-fetch-window SSOT 에 위임한다.
        // 종전에는 여기서 startDate 를 자체 파싱하고 23.9h 청크를 돌렸다(KST 날짜와 어긋남),
        // 그리고 스킵 게이트가 죽은 필드를 읽어 영구 false 였다(baseline 실측: 19청크 전량 조회).
        const now = new Date();
        const queryStartMs =
          resolveCampaignQueryStartMs(campaign as any) ??
          now.getTime() - 14 * 24 * 60 * 60 * 1000; // 기간 정보가 전무할 때만 쓰는 안전망

        const fetchResult = await fetchPendingOrderWindow(queryStartMs, {
          apiRequest: (method, path, body, query) => apiRequest(method, path, body, query),
          loadSnapshotCounts: (from, to) => naverOrderSnapshotRepository.findRangeCounts(from, to),
          loadLatestCursorIso: async () =>
            (await naverOrderSnapshotRepository.findLatestCursor())?.lastChangeStatusCursor ?? null,
          onProgress: ({ index, total, dateKey, skipped }) => {
            sendEvent({
              progress: 10 + Math.floor((index / Math.max(total, 1)) * 40),
              message: skipped
                ? `주문 조회 생략(발주 대상 없음): ${dateKey} (${index + 1}/${total})`
                : `네이버 주문 조회 중... ${dateKey} (${index + 1}/${total})`,
            });
          },
          onLogicalCall: () => noteNaverLogicalCall(tally),
          onSkipped: () => noteNaverSkippedCall(tally),
          nowMs: now.getTime(),
        });

        if (fetchResult.failure) {
          sendEvent({
            error: `주문 조회 실패(${fetchResult.failure.dateKey}): ${fetchResult.failure.message}. 누락된 발주서 생성을 막기 위해 중단했습니다. 잠시 후 다시 시도하세요.`,
          });
          return;
        }

        // 조회 수 대조는 **관측 신호로만** 쓴다(차단하지 않는다).
        // 프로덕션 실측(2026-07-30T06:14Z)에서 이 대조가 곧바로 오탐을 냈다 — 07-12 스냅샷
        // 43건 중 `paymentDate` 가 null 인 2건 때문에 조회 41 < 기록 43 이 되어 발주서
        // 생성을 막았다. 스냅샷은 날짜를 paymentDate→orderDate→orderCreateDate 폴백으로
        // 귀속하는데 범위 조회는 결제일 기준이라 **두 수가 같은 술어로 센 값이 아니다.**
        // 실제 절단 방어는 헬퍼의 pageSize 이분 재조회가 담당한다(스냅샷 비교에 무의존).
        if (fetchResult.integrityIssues.length > 0) {
          fetchIntegrityDetail = fetchResult.integrityIssues
            .map((i) => `${i.dateKey}:${i.fetched}/${i.snapshot}`)
            .join(',');
          const worst = fetchResult.integrityIssues[0];
          sendEvent({
            progress: 50,
            message: `참고: ${worst.dateKey} 조회 ${worst.fetched}건 / 기록 ${worst.snapshot}건. 결제일이 없는 주문 등으로 수가 어긋날 수 있습니다(발주서 생성은 계속).`,
          });
        }

        const detailsData: any[] = fetchResult.items;

        sendEvent({ progress: 50, message: `조회 완료: 총 ${detailsData.length}건. 매핑 분석 중...` });

        // 3. 매핑 로직
        const mainRows: any[] = [];
        const addonRows: any[] = [];
        // 추가구성상품(추가옵션) 귀속용: 메인 매칭 productId 집합 + 2차 판단 보류 리스트
        // (추가구성 주문은 productName이 애드온 자체명이라 캠페인명/매핑 매칭에서 탈락 — 발주서·발주확인 누락 원인)
        const campaignProductIds = new Set<string>();
        const deferredAddonWrappers: any[] = [];
        detailsData.forEach(orderWrapper => {
          const order = orderWrapper.productOrder;
          // 발주 대상 상태 판정은 order-fetch-window SSOT 목록을 쓴다 — 종전엔 이 라우트와
          // execute 라우트가 서로 다른 필터를 갖고 있었다(execute 는 PRODUCT_READY 미포함).
          if (!order || !(PENDING_FULFILLMENT_STATUSES as readonly string[]).includes(order.productOrderStatus)) return;

          if (isSupplementProduct(order)) {
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
            const belongsToOther = activeCampaigns.some((otherCamp: any) => 
              otherCamp.id !== campaign.id && (pName.includes(otherCamp.name) || otherCamp.name.includes(pName))
            );
            if (!belongsToOther) {
              isCampaignOrder = true;
            }
          }

          if (isCampaignOrder) {
            if (order.productId) campaignProductIds.add(String(order.productId));
            const rawDate = orderWrapper.order?.orderDate || order.paymentDate || order.orderDate || order.placeOrderStatusDate || '';
            const formattedDate = rawDate.includes('T') ? rawDate.replace('T', ' ').slice(0, 16) : rawDate;

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

        // 3-2. 추가구성상품 2차 귀속: 같은 상품(=동일 productId)의 메인 품목이 이 캠페인에
        // 매칭된 경우 발주 대상에 포함한다. 그래야 발주서에 실리고 발주확인도 함께 처리된다.
        deferredAddonWrappers.forEach(orderWrapper => {
          const order = orderWrapper.productOrder;
          if (!order?.productId || !campaignProductIds.has(String(order.productId))) return;

          const rawDate = orderWrapper.order?.orderDate || order.paymentDate || order.orderDate || order.placeOrderStatusDate || '';
          const formattedDate = rawDate.includes('T') ? rawDate.replace('T', ' ').slice(0, 16) : rawDate;

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

        // 3-3. 브랜드사 전달 목적에 맞게 주문(고객) 단위로 행 그룹핑 — 추가옵션이
        // 같은 주문의 메인 행 바로 뒤에 붙어야 브랜드사가 합포장 묶음을 인지한다.
        const matchedOrders = interleaveAddonRows(mainRows, addonRows);

        if (matchedOrders.length === 0) {
          // baseline(2026-07-30)이 드러낸 오해: 발주 대상이 0건이어도 "매핑 룰에 해당하는
          // 주문이 없습니다"가 떠서 **매핑 설정이 깨진 것처럼** 읽혔다. 두 상황은 처방이
          // 정반대다 — 앞은 아무 것도 할 게 없는 정상, 뒤는 매핑을 손봐야 하는 문제다.
          const pendingLineCount = detailsData.filter(
            (w: any) =>
              w?.productOrder &&
              (PENDING_FULFILLMENT_STATUSES as readonly string[]).includes(w.productOrder.productOrderStatus),
          ).length;

          if (pendingLineCount === 0) {
            sendEvent({ error: '지금 발주할 주문이 없습니다. 발주 대상(결제완료·상품준비중) 주문이 0건입니다. 매핑 설정 문제가 아닙니다.' });
            op.outcome = 'no-work';
          } else {
            sendEvent({ error: `발주 대상 주문 ${pendingLineCount}건이 있으나 이 캠페인의 매핑 룰에 맞는 건이 없습니다. 매핑 설정을 확인하세요.` });
          }
          return;
        }

        sendEvent({ progress: 60, message: `발주 대상 ${matchedOrders.length}건 확인됨. 스마트스토어 발주확인 처리 중...` });

        // 4. 발주확인 API 호출 (아직 발주대기(NOT_YET)인 건만 확인 처리)
        // 과거 사고: 청크 100이 API 제한/레이트리밋에 걸려 전멸했는데 console.warn으로 삼켜져
        // 파일만 정상 다운로드됨(스토어는 발주전 그대로). 청크를 30으로 줄이고, 응답 본문의
        // 실패 목록을 집계하며, 429는 1회 재시도, 실패는 UI 이벤트로 표면화한다.
        const initialToConfirm = matchedOrders.filter(o => o._placeOrderStatus === 'NOT_YET').map(o => String(o.상품주문번호)).filter(Boolean);
        let confirmSuccessCount = 0;
        let confirmFailCount = 0;
        // 재시도 후에도 네이버가 성공·실패 어디에도 담지 않고 끝내 확인하지 못한 잔여(대개 0).
        let confirmDeferredCount = 0;
        let confirmFirstError = '';
        if (initialToConfirm.length > 0) {
          const CHUNK_SIZE = 30;
          const succeeded = new Set<string>();
          const failedHard = new Set<string>(); // 명시적 실패(사유 있음) — 재시도 무의미

          // 한 라운드: ids를 청크로 발주확인하고 성공/명시적실패 id를 집합에 반영한다.
          // 네이버가 성공·실패 어느 목록에도 안 담고 누락한 id는 두 집합 어디에도 안 들어가
          // 자동으로 다음 라운드 재시도 대상(pending)에 남는다. 네트워크/서버 오류 청크도
          // 확정하지 않고(=transient) 다음 라운드에 재시도되게 남긴다.
          const runConfirmRound = async (ids: string[]) => {
            for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
              sendEvent({ progress: 60 + Math.floor((i / ids.length) * 15), message: `발주확인 중... (${Math.min(i + CHUNK_SIZE, ids.length)}/${ids.length})` });
              const chunk = ids.slice(i, i + CHUNK_SIZE);
              let attempt = 0;
              while (attempt < 2) {
                attempt++;
                try {
                  const res: any = await apiRequest('POST', '/v1/pay-order/seller/product-orders/confirm', { productOrderIds: chunk });
                  const body = res?.data ?? res ?? {};
                  // 실측 스키마(2026-07-07): { successProductOrderInfos: [{productOrderId, ...}], failProductOrderInfos: [] }
                  const okInfos: any[] = body.successProductOrderInfos || body.data?.successProductOrderInfos || [];
                  const failInfos: any[] = body.failProductOrderInfos || body.data?.failProductOrderInfos || [];
                  if (okInfos.length === 0 && failInfos.length === 0) {
                    // 목록이 둘 다 비면(스키마 상이) 청크 전체 성공으로 간주 — 무한 재시도 방지
                    chunk.forEach(id => succeeded.add(id));
                  } else {
                    for (const info of okInfos) { if (info?.productOrderId) succeeded.add(String(info.productOrderId)); }
                    for (const info of failInfos) { if (info?.productOrderId) failedHard.add(String(info.productOrderId)); }
                    if (failInfos.length > 0 && !confirmFirstError) {
                      confirmFirstError = `${failInfos[0]?.productOrderId || ''} ${failInfos[0]?.code || ''} ${failInfos[0]?.message || ''}`.trim();
                      console.warn('[발주확인 부분 실패]', JSON.stringify(failInfos).slice(0, 500));
                    }
                  }
                  break;
                } catch (err: any) {
                  const msg = err?.message || String(err);
                  const isRateLimit = msg.includes('429') || msg.toUpperCase().includes('RATE');
                  if (isRateLimit && attempt < 2) {
                    await new Promise(r => setTimeout(r, 1200));
                    continue;
                  }
                  // 확정하지 않음 — 이 청크는 다음 라운드 재시도 대상(pending)에 남는다.
                  if (!confirmFirstError) confirmFirstError = msg.slice(0, 200);
                  console.warn(`발주 확인 호출 실패 (chunk ${i}, ${chunk.length}건):`, msg);
                  break;
                }
              }
              await new Promise(r => setTimeout(r, 300)); // 청크 간 레이트리밋 완화
            }
          };

          // 재시도 루프(2026-07-13 실사고): 막 확인 요청한 건 중 일부를 네이버가 이번 호출에선
          // 확인하지 않고 조용히 누락하는 경우가 있다(제출 17 중 9만 확인·8 누락). 사용자에게
          // 재클릭을 시키면 주문확인 로그가 중복으로 쌓여 오작동처럼 보이므로, 백엔드에서 잔여분만
          // 짧게 최대 N회 자동 재시도해 클릭 1회 = 로그 1줄로 수렴시킨다. 잔여가 0이 되면 조기 종료.
          const MAX_CONFIRM_ROUNDS = 3;
          const RETRY_DELAY_MS = 2000;
          // Hobby는 함수 실행을 60초로 클램프한다(maxDuration 선언 무시). 재시도 sleep이 큰
          // 캠페인(다일 조회+수백 청크 확인)에서 이 예산을 밀어 타임아웃 kill을 유발하지 않도록,
          // 재시도 단계 총 소요를 이 예산으로 캡한다. 초과 시 잔여는 그대로 표면화(재시도 포기).
          const RETRY_TIME_BUDGET_MS = 12000;
          const confirmPhaseStart = Date.now();
          let pending = [...initialToConfirm];
          for (let round = 0; round < MAX_CONFIRM_ROUNDS && pending.length > 0; round++) {
            if (round > 0) {
              if (Date.now() - confirmPhaseStart > RETRY_TIME_BUDGET_MS) break;
              sendEvent({ progress: 78, message: `미확인 ${pending.length}건 네이버 확인 대기, 자동 재시도 중 (${round}/${MAX_CONFIRM_ROUNDS - 1})` });
              await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            }
            await runConfirmRound(pending);
            pending = pending.filter(id => !succeeded.has(id) && !failedHard.has(id));
          }

          confirmSuccessCount = succeeded.size;
          confirmFailCount = failedHard.size;
          confirmDeferredCount = pending.length; // 재시도 후에도 확인 못한 잔여(대개 0)

          if (confirmFailCount > 0 || confirmDeferredCount > 0) {
            const parts = [`성공 ${confirmSuccessCount}건`];
            if (confirmFailCount > 0) parts.push(`실패 ${confirmFailCount}건`);
            if (confirmDeferredCount > 0) parts.push(`확인 대기 잔류 ${confirmDeferredCount}건(자동 재시도 후에도 네이버 미확인)`);
            sendEvent({ progress: 80, message: `발주확인 ${parts.join(' · ')}${confirmFirstError ? `: ${confirmFirstError}` : ''}` });
          }
        }

        // 발주확인은 네이버 변경피드(last-changed-statuses)에 이벤트로 잡히지 않으므로,
        // 이 캠페인의 매칭 주문 "전체"를 query-by-id로 재조회해 스냅샷에 즉시 반영한다.
        // 이번에 새로 확인한 건(initialToConfirm)뿐 아니라 "이미 발주확인된 건"도 스냅샷은
        // 여전히 stale(NOT_YET)일 수 있으므로 전체가 대상. 그래야 재클릭 시에도 대시보드
        // 발주확인전→후가 확실히 반영된다.
        const allMatchedIds = matchedOrders.map(o => o.상품주문번호).filter(Boolean);
        if (allMatchedIds.length > 0) {
          try {
            sendEvent({ progress: 82, message: '주문 상태 반영 중...' });
            await syncOrdersByIds(allMatchedIds);
          } catch (patchErr) {
            console.warn('발주확인 후 스냅샷 반영 실패:', patchErr);
          }
        }

        sendEvent({ progress: 85, message: '엑셀 파일 생성 중...' });

        // 5. 엑셀 생성 — F4 Phase 2: 확정 규칙(excelRules)이 있으면 유일 권위(D3)
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

        const dKst = new Date(new Date().getTime() + 9 * 60 * 60 * 1000);
        const yy = String(dKst.getUTCFullYear()).slice(2);
        const mm = String(dKst.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(dKst.getUTCDate()).padStart(2, '0');
        const today = `${yy}${mm}${dd}`;

        const provider = orderBrand?.displayName || campaign.template || '기본';
        const filename = `발주서_${provider}_와이그라운드_${campaign.sellerName}_${today}.xlsx`;

        const yyyyMmDd = dKst.toISOString().slice(0, 10);
        const existingTask = await prisma.dailyOrderTask.findUnique({
          where: { campaignId_date: { campaignId, date: yyyyMmDd } }
        });
        if (!existingTask) {
          await prisma.dailyOrderTask.create({
            data: { campaignId, date: yyyyMmDd, status: 'PENDING' }
          });
        }

        sendEvent({
          progress: 100,
          message: '생성 완료',
          fileData: outputBuffer.toString('base64'),
          fileName: filename,
          confirmSuccessCount,
          confirmFailCount,
          confirmDeferredCount,
          confirmFirstError: confirmFailCount > 0 ? confirmFirstError : undefined,
        });
        });
      } catch (err: any) {
        console.error('Stream Execute Error:', err);
        sendEvent({ error: err.message || '서버 오류가 발생했습니다.' });
      } finally {
        // 주문확인 1회 = ApiCallLog 1행. 조회 범위 최적화의 전후 비교가 이 행의
        // logicalCalls/skipped 로 이루어진다(최적화 전에는 skipped=0).
        //
        // ⚠️ 기록을 `controller.close()` **앞에** 둔다. 스트림을 먼저 닫으면 응답이 완료돼
        // 서버리스 인스턴스가 이 DB 쓰기를 완주하지 못할 수 있고, 그러면 계측 행이 조용히
        // 유실된다 — 측정이 목적인 코드가 측정을 놓치는 자기모순이 된다. 그래서 종전에
        // 5곳(조기반환 3 · 성공 1 · catch 1)에 흩어져 있던 close 를 **여기 한 곳으로**
        // 모았다. 흩어진 close 를 되살리지 말 것(중복 close 는 예외를 던진다).
        // 계측 기록은 자체적으로 예외를 삼키지만, **그 내부 구현에 의존하지 않는다** —
        // 여기서 예외가 새면 아래 close 가 실행되지 않아 주문확인 버튼이 영구히
        // "조회 중"에 멈춘다(회귀 테스트 route.test.ts 가 이 경로를 고정한다).
        try {
          await recordNaverOperationUsage({
            operation: 'confirm_order',
            endpointLabel: toNaverEndpointLabel('/v1/pay-order/seller/product-orders'),
            tally,
            // no-work 는 실패가 아니다(위 outcome 주석) — outcome 을 metadata 로도 남겨
            // 나중에 "할 일 없음"과 "장애"를 분리 집계할 수 있게 한다.
            success: op.outcome !== 'failure',
            elapsedMs: Date.now() - opStartedAt,
            errorMessage: op.outcome === 'failure' ? (opErrorMessage ?? undefined) : undefined,
            context: {
              campaignId,
              outcome: op.outcome,
              // 대조 불일치는 차단 사유가 아니라 관측치다 — 실제 절단을 가리키는지
              // 프로덕션에서 축적해 보고 판단한다(현재는 오탐이 확인된 상태).
              // `날짜:조회수/기록수` 형태. rangeType 변경 전후 대조에 쓴다(위 주석).
              countMismatch: fetchIntegrityDetail,
              // 창 술어를 명시로 바꿨음을 행에 남긴다 — 나중에 "언제부터 바뀐 값인가"를
              // 이 필드로 가른다(로그 보존 1일로는 사후 추적이 안 된다).
              rangeType: 'PAYED_DATETIME',
            },
          });
        } catch (usageErr) {
          console.error('[execute/stream] 네이버 호출 계측 기록 실패(발주서 생성은 영향 없음):', usageErr);
        }
        controller.close();
      }
    }
  });

  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
