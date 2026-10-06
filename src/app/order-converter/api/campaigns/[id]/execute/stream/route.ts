import { NextRequest, NextResponse } from 'next/server';
import { withProxySource } from '@/lib/order-converter/proxy-usage';
import { prisma } from '@/lib/order-converter/prisma';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { generateOrderExcelBuffer } from '@/lib/order-converter/excel-generator';
import { loadOrderTemplateBuffer, resolveOrderBrand } from '@/lib/order-converter/order-brand';
import { syncOrdersByIds } from '@/lib/order-converter/naver-order-sync';
import { buildPurchaseOrderRows, describeEmptyPurchaseOrder } from '@/lib/order-converter/purchase-order-rows';
import { confirmPlaceOrders } from '@/lib/order-converter/place-order-confirm';
import {
  createNaverCallTally,
  noteNaverLogicalCall,
  noteNaverSkippedCall,
  recordNaverOperationUsage,
  runWithNaverCallTally,
  toNaverEndpointLabel,
} from '@/lib/order-converter/naver-api-usage';
import { fetchPendingOrderWindow } from '@/lib/order-converter/order-fetch-window';
import { resolveCampaignQueryStartMs } from '@/lib/order-converter/mapping-service';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';

// 주문확인 1클릭이 전체기간 재조회→발주확인→스냅샷 반영→엑셀 생성을 한 함수에서 수행 —
// 기본 실행시간 한도에 걸리면 발주확인이 중간에 끊긴 채 파일만 생성되는 무증상 사고가 남
// (2026-07-07 실사고: API는 정상인데 93건 미확인 잔류). analyze 라우트와 동일하게 상향.
export const maxDuration = 300;



// 이 요청 안에서 나가는 프록시(Fixie) 요청을 경로별 일 집계에서 order-execute 로 센다(proxy-usage.ts).
export const GET = withProxySource('order-execute', handleExecuteStreamGet);

async function handleExecuteStreamGet(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
        // status 는 **끝난 회차(정산 락)를 창 계산에서 빼는 게이트의 유일한 입력**이다 — 빠지면
        // sc.status=undefined 라 전부 "살아있는 회차"로 읽혀, 지난 회차가 조회창을 몇 달 앞으로
        // 끌어당기는 2026-09-16 실사고가 조용히 되살아난다(증상은 "주문확인이 느리다" 뿐이다).
        const campaign = await prisma.orderCampaign.findUnique({
          where: { id: campaignId },
          include: { mappings: true, salesCampaigns: { select: { startDate: true, endDate: true, status: true } } }
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

        // 3. 매핑 — 발주 대상 판정·행 생성은 purchase-order-rows SSOT(발주요청·준비본과 같은 함수).
        // 주문확인은 배송대기(이미 발주요청한) 건도 빼지 않는다 — 다시 받는 파일이라 전량이 맞다.
        const { rows: matchedOrders, pendingLineCount } = buildPurchaseOrderRows({
          wrappers: detailsData,
          campaign,
          activeCampaigns,
        });

        if (matchedOrders.length === 0) {
          // 「발주 대상 0건」과 「매핑 불일치」는 처방이 정반대다 — 문구를 가른다(SSOT 쪽 주석 참조).
          const empty = describeEmptyPurchaseOrder(pendingLineCount);
          sendEvent({ error: empty.message });
          if (empty.noWork) op.outcome = 'no-work';
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
          // 청크·재시도·예산 규칙은 place-order-confirm SSOT 가 소유한다(실사고 근거도 그쪽 헤더).
          const confirm = await confirmPlaceOrders(initialToConfirm, {
            apiRequest: (method, path, body) => apiRequest(method, path, body),
            onProgress: (p) => {
              if (p.kind === 'chunk') {
                sendEvent({ progress: 60 + Math.floor((p.offset / p.total) * 15), message: `발주확인 중... (${p.done}/${p.total})` });
              } else {
                sendEvent({ progress: 78, message: `미확인 ${p.pending}건 네이버 확인 대기, 자동 재시도 중 (${p.round}/${p.maxRounds - 1})` });
              }
            },
          });
          confirmSuccessCount = confirm.succeeded.size;
          confirmFailCount = confirm.failedHard.size;
          confirmDeferredCount = confirm.pending.length; // 재시도 후에도 확인 못한 잔여(대개 0)
          confirmFirstError = confirm.firstError;

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
