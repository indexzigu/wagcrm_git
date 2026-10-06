import { NextRequest, NextResponse } from 'next/server';
import { withProxySource } from '@/lib/order-converter/proxy-usage';
import { prisma } from '@/lib/order-converter/prisma';
import { apiRequest } from '@/lib/order-converter/naver-commerce-client';
import { generateOrderExcelBuffer } from '@/lib/order-converter/excel-generator';
import { loadOrderTemplateBuffer, resolveOrderBrand } from '@/lib/order-converter/order-brand';
import { findMissingProductOrderIds, syncOrdersByIds } from '@/lib/order-converter/naver-order-sync';
import {
  createNaverCallTally,
  noteNaverLogicalCall,
  noteNaverSkippedCall,
  recordNaverOperationUsage,
  runWithNaverCallTally,
  toNaverEndpointLabel,
  type NaverCallTally,
} from '@/lib/order-converter/naver-api-usage';
import { fetchPendingOrderWindow } from '@/lib/order-converter/order-fetch-window';
import { resolveCampaignQueryStartMs } from '@/lib/order-converter/mapping-service';
import {
  buildPurchaseOrderRows,
  describeEmptyPurchaseOrder,
  toPreviewRow,
  wrapFlatOrder,
  type DroppedOrder,
  type OrderWrapper,
} from '@/lib/order-converter/purchase-order-rows';
import {
  collectPreparedOrderWrappers,
  decidePreparedPoAvailability,
  describePreparedPoUnavailable,
  preparedSnapshotRange,
  type PreparedPoAvailability,
} from '@/lib/order-converter/prepared-po';
import { confirmPlaceOrders } from '@/lib/order-converter/place-order-confirm';
import { getSnapshotL1Cache, hydrateSnapshotL1 } from '@/lib/order-converter/snapshot-l1-cache';
import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { orderFulfillmentRepository } from '@/repositories/orderFulfillmentRepository';

/**
 * 발주요청의 **미리보기(GET)와 확정(POST)** — 발주 자동화 2단계(오너 승인 2026-10-06, 설계 정본
 * `docs/private/specs/2026-10-06-order-automation-phase2.md`).
 *
 * 종전 발주요청(구 `execute` GET)은 조회·네이버 발주확인·엑셀 생성을 한 번에 했고, 오너가 무엇이
 * 나가는지 보기 **전에** 네이버 쓰기가 끝났다. 이제 둘로 나눈다:
 *
 * - **GET 미리보기 — 네이버 쓰기 0.** `source` 없음: 준비본 가용성만(DB 읽기). `source=prepared`:
 *   저장된 주문 사본(스냅샷)으로 행을 만든다(네이버 요청 0). `source=live`: 종전과 같은 조회
 *   (`fetchPendingOrderWindow`)만 한다.
 * - **POST 확정 — 미리보기에서 본 주문 그대로.** 발주확인(그중 확인 전인 것만) → 그 주문들을 id 로
 *   재조회 → **재조회 결과로** 행을 다시 만들어(사이에 취소된 주문은 빠진다) 엑셀을 돌려준다. 메일
 *   발송은 기존 `send-email` 이 한다(이 라우트는 메일을 보내지 않는다 — 메일만 실패하면 발주확인을
 *   되풀이하지 않고 다시 보낼 수 있게).
 *
 * 요청 수: 미리보기 준비본 0 · 미리보기 재수집 = 종전 조회와 같음 · 확정 = 발주확인 청크 + 재조회
 * 청크(종전과 같음). 미리보기와 확정을 나눠도 합계는 그대로다.
 */

// 확정은 발주확인 재시도(최대 12초 예산)·재조회·엑셀까지 한 요청에서 돈다 — 종전 execute 와 같은 상향.
export const maxDuration = 300;

// 이 요청 안의 프록시(Fixie) 요청은 종전과 같은 버킷(order-execute)으로 센다(proxy-usage.ts) —
// 전후 비교가 끊기지 않게.
export const GET = withProxySource('order-execute', handlePreview);
export const POST = withProxySource('order-execute', handleCommit);

/** 한 번에 확정할 수 있는 상품주문 상한 — 비정상 요청이 발주확인을 대량으로 쏘는 것을 막는다. */
const MAX_COMMIT_ORDERS = 3000;
const DEFAULT_WINDOW_FALLBACK_MS = 14 * 24 * 60 * 60 * 1000; // 기간 정보가 전무할 때만 쓰는 안전망

type Source = 'prepared' | 'live';
type RouteContext = { params: Promise<{ id: string }> };

async function loadCampaign(campaignId: string) {
  // salesCampaigns 의 status 는 끝난 회차(정산 락)를 조회창에서 빼는 게이트의 유일한 입력이다 —
  // 빠지면 지난 회차가 조회창을 몇 달 앞으로 끌어당긴다(2026-09-16 실사고, 계약
  // query-window-status-select.contract.test.ts).
  const campaign = await prisma.orderCampaign.findUnique({
    where: { id: campaignId },
    include: { mappings: true, salesCampaigns: { select: { startDate: true, endDate: true, status: true } } },
  });
  const activeCampaigns = await prisma.orderCampaign.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
  });
  return { campaign, activeCampaigns };
}

function queryStartOf(campaign: any, nowMs: number): number {
  return resolveCampaignQueryStartMs(campaign) ?? nowMs - DEFAULT_WINDOW_FALLBACK_MS;
}

async function loadAvailability(campaign: any, nowMs: number): Promise<PreparedPoAvailability & { message?: string }> {
  const cursor = await naverOrderSnapshotRepository.latestChangeCursor();
  const availability = decidePreparedPoAvailability({
    autoPrepEnabled: campaign.autoPrepEnabled === true,
    cursorIso: cursor?.lastChangeStatusCursor ?? null,
    queryStartMs: queryStartOf(campaign, nowMs),
    nowMs,
  });
  return availability.available
    ? availability
    : { ...availability, message: describePreparedPoUnavailable(availability.reason, availability.asOfIso) };
}

async function loadPreparedWrappers(campaign: any, nowMs: number): Promise<OrderWrapper[]> {
  const { startKey, endKey } = preparedSnapshotRange(queryStartOf(campaign, nowMs), nowMs);
  await hydrateSnapshotL1(startKey, endKey, 'purchase-order-prepared');
  return collectPreparedOrderWrappers(getSnapshotL1Cache(), startKey, endKey);
}

async function loadPoRequestedSet(ids: string[]): Promise<Set<string>> {
  // 실패하면 던진다 — 빈 집합으로 폴백하면 이미 발주요청한(배송대기) 주문이 브랜드사에 **두 번**
  // 발주된다(되돌릴 수 없다). 종전 execute 는 경고만 남기고 폴백했다.
  return orderFulfillmentRepository.getPoRequestedSet(ids);
}

async function recordUsage(
  tally: NaverCallTally,
  startedAt: number,
  status: number,
  thrown: unknown,
  context: Record<string, string | number | boolean | null>,
) {
  try {
    await recordNaverOperationUsage({
      operation: 'order_excel',
      endpointLabel: toNaverEndpointLabel('/v1/pay-order/seller/product-orders'),
      tally,
      success: status < 400,
      elapsedMs: Date.now() - startedAt,
      errorMessage: thrown ?? undefined,
      context: { httpStatus: status, ...context },
    });
  } catch (usageErr) {
    // 계측이 발주 흐름을 깨면 안 된다(P7) — 기록만 실패로 남긴다.
    console.error('[purchase-order] 네이버 호출 계측 기록 실패(발주 흐름은 영향 없음):', usageErr);
  }
}

// ---------------------------------------------------------------------------
// GET 미리보기
// ---------------------------------------------------------------------------

async function handlePreview(request: NextRequest, { params }: RouteContext) {
  const { id: campaignId } = await params;
  const url = new URL(request.url);
  const sourceParam = url.searchParams.get('source');
  const includePending = url.searchParams.get('includePending') === 'true';
  const nowMs = Date.now();

  const { campaign, activeCampaigns } = await loadCampaign(campaignId);
  if (!campaign) return NextResponse.json({ error: '캠페인을 찾을 수 없습니다.' }, { status: 404 });
  if (!campaign.template) {
    return NextResponse.json({ error: '캠페인에 지정된 베이스 템플릿이 없습니다.' }, { status: 400 });
  }

  const availability = await loadAvailability(campaign, nowMs);

  // source 없음 = 발주요청 창 1단계의 「준비본을 쓸 수 있나」만. 네이버 0 · 행 생성 없음.
  if (sourceParam === null) {
    return NextResponse.json({ availability });
  }
  if (sourceParam !== 'prepared' && sourceParam !== 'live') {
    return NextResponse.json({ error: `알 수 없는 출처입니다: ${sourceParam}` }, { status: 400 });
  }
  const source: Source = sourceParam;

  if (source === 'prepared') {
    if (!availability.available) {
      return NextResponse.json({ error: availability.message, availability }, { status: 409 });
    }
    const wrappers = await loadPreparedWrappers(campaign, nowMs);
    return buildPreviewResponse({ campaign, activeCampaigns, wrappers, includePending, source, asOfIso: availability.asOfIso, availability });
  }

  // live — 종전 발주요청과 같은 조회(창·청크·생략 판정은 order-fetch-window SSOT). 쓰기는 없다.
  const tally = createNaverCallTally();
  const startedAt = Date.now();
  let status = 500;
  let thrown: unknown = null;
  try {
    const response = await runWithNaverCallTally(tally, async () => {
      const fetchResult = await fetchPendingOrderWindow(queryStartOf(campaign, nowMs), {
        apiRequest: (method, path, body, query) => apiRequest(method, path, body, query),
        loadSnapshotCounts: (from, to) => naverOrderSnapshotRepository.findRangeCounts(from, to),
        loadLatestCursorIso: async () =>
          (await naverOrderSnapshotRepository.findLatestCursor())?.lastChangeStatusCursor ?? null,
        onLogicalCall: () => noteNaverLogicalCall(tally),
        onSkipped: () => noteNaverSkippedCall(tally),
        nowMs,
      });
      if (fetchResult.failure) {
        return NextResponse.json(
          {
            error: `주문 조회 실패(${fetchResult.failure.dateKey}): ${fetchResult.failure.message}. 누락된 발주서를 막기 위해 중단했습니다. 잠시 후 다시 시도하세요.`,
          },
          { status: 502 },
        );
      }
      if (fetchResult.integrityIssues.length > 0) {
        // 관측 신호로만 쓴다(차단하지 않는다) — 결제일 없는 주문 등으로 오탐이 확인된 대조다(P7).
        console.warn('[purchase-order] 조회 수 대조 불일치(관측 신호):', JSON.stringify(fetchResult.integrityIssues));
      }
      return buildPreviewResponse({
        campaign,
        activeCampaigns,
        wrappers: fetchResult.items,
        includePending,
        source,
        asOfIso: new Date(nowMs).toISOString(),
        availability,
      });
    });
    status = response.status;
    return response;
  } catch (error: unknown) {
    thrown = error;
    console.error('[purchase-order] 미리보기 조회 실패:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '미리보기 조회에 실패했습니다.' }, { status: 500 });
  } finally {
    await recordUsage(tally, startedAt, thrown ? 500 : status, thrown, { phase: 'preview', source, campaignId });
  }
}

async function buildPreviewResponse(args: {
  campaign: any;
  activeCampaigns: { id: string; name: string }[];
  wrappers: OrderWrapper[];
  includePending: boolean;
  source: Source;
  asOfIso: string;
  availability: PreparedPoAvailability & { message?: string };
}) {
  const { campaign, activeCampaigns, wrappers, includePending, source, asOfIso, availability } = args;
  const exclude = includePending
    ? undefined
    : await loadPoRequestedSet(wrappers.map((w) => w.productOrder?.productOrderId).filter(Boolean));
  const { rows, pendingLineCount } = buildPurchaseOrderRows({
    wrappers,
    campaign,
    activeCampaigns,
    excludeProductOrderIds: exclude,
  });
  const previewRows = rows.map(toPreviewRow);
  return NextResponse.json({
    source,
    asOfIso,
    availability,
    rows: previewRows,
    summary: {
      lineCount: previewRows.length,
      quantityTotal: previewRows.reduce((sum, r) => sum + r.quantity, 0),
      needsConfirmCount: previewRows.filter((r) => r.needsConfirm).length,
      missingCount: previewRows.filter((r) => r.missing.length > 0).length,
    },
    empty: rows.length === 0 ? describeEmptyPurchaseOrder(pendingLineCount) : null,
  });
}

// ---------------------------------------------------------------------------
// POST 확정
// ---------------------------------------------------------------------------

type CommitBody = {
  source?: unknown;
  productOrderIds?: unknown;
  confirmIds?: unknown;
  includePending?: unknown;
};

function asIdList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return Array.from(new Set(value.map((v) => String(v ?? '').trim()).filter(Boolean)));
}

async function handleCommit(request: NextRequest, { params }: RouteContext) {
  const { id: campaignId } = await params;
  let body: CommitBody;
  try {
    body = (await request.json()) as CommitBody;
  } catch {
    return NextResponse.json({ error: '요청 본문을 읽지 못했습니다.' }, { status: 400 });
  }
  const productOrderIds = asIdList(body.productOrderIds);
  const confirmIdsRaw = asIdList(body.confirmIds) ?? [];
  const source = body.source === 'prepared' ? 'prepared' : body.source === 'live' ? 'live' : null;
  if (!productOrderIds || productOrderIds.length === 0 || !source) {
    return NextResponse.json({ error: '확정할 주문 목록(productOrderIds)과 출처(source)가 필요합니다.' }, { status: 400 });
  }
  if (productOrderIds.length > MAX_COMMIT_ORDERS) {
    return NextResponse.json({ error: `한 번에 확정할 수 있는 주문은 ${MAX_COMMIT_ORDERS}건까지입니다.` }, { status: 400 });
  }
  const includePending = body.includePending === true;
  const previewSet = new Set(productOrderIds);
  // 발주확인은 미리보기 집합 안에서만 한다 — 그 밖의 id 로 네이버 쓰기가 나가지 않게.
  const confirmIds = confirmIdsRaw.filter((id) => previewSet.has(id));

  const { campaign, activeCampaigns } = await loadCampaign(campaignId);
  if (!campaign) return NextResponse.json({ error: '캠페인을 찾을 수 없습니다.' }, { status: 404 });
  if (!campaign.template) {
    return NextResponse.json({ error: '캠페인에 지정된 베이스 템플릿이 없습니다.' }, { status: 400 });
  }

  const tally = createNaverCallTally();
  const startedAt = Date.now();
  let status = 500;
  let thrown: unknown = null;
  try {
    const response = await runWithNaverCallTally(tally, () =>
      commitPurchaseOrder({ campaign, activeCampaigns, productOrderIds, previewSet, confirmIds, includePending }),
    );
    status = response.status;
    return response;
  } catch (error: unknown) {
    thrown = error;
    console.error('[purchase-order] 확정 실패:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : '발주 확정에 실패했습니다.' }, { status: 500 });
  } finally {
    await recordUsage(tally, startedAt, thrown ? 500 : status, thrown, { phase: 'commit', source, campaignId });
  }
}

async function commitPurchaseOrder(args: {
  campaign: any;
  activeCampaigns: { id: string; name: string }[];
  productOrderIds: string[];
  previewSet: Set<string>;
  confirmIds: string[];
  includePending: boolean;
}): Promise<NextResponse> {
  const { campaign, activeCampaigns, productOrderIds, previewSet, confirmIds, includePending } = args;

  // 1. 네이버 발주확인 — 미리보기에서 「확인 전」이던 주문만(청크·재시도 규칙은 place-order-confirm SSOT).
  const confirm =
    confirmIds.length > 0
      ? await confirmPlaceOrders(confirmIds, { apiRequest: (method, path, body) => apiRequest(method, path, body) })
      : null;

  // 2. 미리보기 집합 전체를 id 로 재조회 — 발주확인 결과와 그 사이의 취소를 반영한 **지금 상태**로 행을
  //    다시 만든다. 스냅샷도 함께 갱신된다(발주확인은 변경피드에 안 실린다 — P7 Naver Quirks ①).
  //    재조회가 실패하면 엑셀을 만들지 않는다: 미리보기 시점 데이터로 보내면 그 사이 취소된 주문이 나간다.
  let refreshed: any[];
  try {
    refreshed = (await syncOrdersByIds(productOrderIds)).orders;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    const confirmedNote = confirm ? ` 네이버 발주확인은 ${confirm.succeeded.size}건 처리됐습니다.` : '';
    return NextResponse.json(
      { error: `주문 재조회에 실패해 발주서를 만들지 않았습니다(${detail}).${confirmedNote} 잠시 후 다시 시도하세요.` },
      { status: 502 },
    );
  }

  const returnedIds = new Set(refreshed.map((o) => String(o?.productOrderId ?? '')).filter(Boolean));
  const notReturned = new Set(findMissingProductOrderIds(productOrderIds, returnedIds));

  // 3. 행 재생성 — 미리보기와 같은 판정(purchase-order-rows SSOT), 같은 배송대기 제외 규칙.
  const wrappers = refreshed.filter((o) => previewSet.has(String(o?.productOrderId ?? ''))).map(wrapFlatOrder);
  const poRequested = includePending ? null : await loadPoRequestedSet(productOrderIds);
  const { rows } = buildPurchaseOrderRows({
    wrappers,
    campaign,
    activeCampaigns,
    excludeProductOrderIds: poRequested ?? undefined,
  });
  const sendRows = rows.filter((r) => previewSet.has(String(r.상품주문번호)));
  const sentIds = new Set(sendRows.map((r) => String(r.상품주문번호)));

  const refreshedById = new Map(refreshed.map((o) => [String(o?.productOrderId ?? ''), o]));
  const dropped: DroppedOrder[] = productOrderIds
    .filter((id) => !sentIds.has(id))
    .map((id) => {
      const order = refreshedById.get(id);
      const reason: DroppedOrder['reason'] = notReturned.has(id)
        ? 'not-returned'
        : poRequested?.has(id)
          ? 'already-requested'
          : 'status-changed';
      return { productOrderId: id, recipientName: order?.shippingAddress?.name ?? '', reason };
    });

  // 발주확인 실패로 집계됐어도 재조회에서 이미 확인된 상태(NOT_YET 아님)면 실패가 아니다 — 스토어에서
  // 직접 확인했거나 준비본이 낡아 「확인 전」으로 보였던 주문이다. 진짜 실패만 남긴다.
  const stillNotConfirmed = (id: string) => refreshedById.get(id)?.placeOrderStatus === 'NOT_YET';
  const confirmFailedIds = confirm
    ? [...confirm.failedHard, ...confirm.pending].filter((id) => sentIds.has(id) && stillNotConfirmed(id))
    : [];

  if (sendRows.length === 0) {
    return NextResponse.json(
      {
        error: '미리보기 이후 주문이 모두 취소·변경돼 보낼 주문이 없습니다. 발주서를 만들지 않았습니다.',
        dropped,
        confirm: confirm ? { succeeded: confirm.succeeded.size, failed: confirmFailedIds.length } : null,
      },
      { status: 409 },
    );
  }

  // 4. 엑셀 — 확정 규칙(excelRules)이 있으면 유일 권위(F4 Phase 2, D3).
  const orderBrand = await resolveOrderBrand(campaign.template);
  const buffer = await generateOrderExcelBuffer({
    orders: sendRows,
    templateId: campaign.template,
    formatAdapter: orderBrand?.formatAdapter,
    excelRules: orderBrand?.excelRules,
    templateBuffer: await loadOrderTemplateBuffer(orderBrand),
    sellerName: campaign.sellerName,
    mappings: campaign.mappings,
  });

  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const yymmdd = `${String(kst.getUTCFullYear()).slice(2)}${String(kst.getUTCMonth() + 1).padStart(2, '0')}${String(kst.getUTCDate()).padStart(2, '0')}`;
  const provider = orderBrand?.displayName || campaign.template || '기본';

  // 일일 발주 태스크(구 execute 와 같은 기록) — 송장 회신 메일 검색이 이 날짜들을 쓴다.
  const yyyyMmDd = kst.toISOString().slice(0, 10);
  await prisma.dailyOrderTask.upsert({
    where: { campaignId_date: { campaignId: campaign.id, date: yyyyMmDd } },
    create: { campaignId: campaign.id, date: yyyyMmDd, status: 'PENDING' },
    update: {},
  });

  return NextResponse.json({
    fileName: `발주서_${provider}_와이그라운드_${campaign.sellerName}_${yymmdd}.xlsx`,
    fileBase64: buffer.toString('base64'),
    productOrderIds: sendRows.map((r) => String(r.상품주문번호)),
    dropped,
    confirm: confirm
      ? {
          requested: confirmIds.length,
          succeeded: confirm.succeeded.size,
          failed: confirmFailedIds.length,
          firstError: confirmFailedIds.length > 0 ? confirm.firstError : '',
        }
      : { requested: 0, succeeded: 0, failed: 0, firstError: '' },
  });
}

