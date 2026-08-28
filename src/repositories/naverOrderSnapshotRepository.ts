import { prisma } from "@/lib/order-converter/prisma";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import {
  computeSnapshotDailyAggregate,
  loadAggregationCampaignSources,
  SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE,
} from "@/lib/order-converter/daily-aggregate";
import type { PulseOrderLike, PulseSalesCampaignSource } from "@/lib/mobile-pulse-data";
import {
  computeSnapshotClaimSource,
  SNAPSHOT_CLAIM_SOURCE_UNAVAILABLE,
} from "@/lib/order-converter/claim-derive";

// order-converter의 campaigns route와 동일한 prisma 클라이언트를 사용해 동일 DB 인스턴스를 보장한다.

export interface NaverOrderSnapshotUpsertInput {
  snapshotDate: string;
  orders: unknown[];
  ordersCount: number;
  newOrdersCount: number;
  preparingCount: number;
  deliveringCount: number;
  isDirty: boolean;
  lastCallTime: Date;
  syncType?: string;
  lastChangeStatusCursor?: string | null;
}

// SQLite는 Json 컬럼 타입을 지원하지 않으므로 문자열로 직렬화하고, Postgres는 객체 그대로 저장한다.
// 순수 함수라 유닛테스트에서 DB 없이 직렬화 왕복을 검증할 수 있도록 export한다.
export function serializeOrders(orders: unknown[]): unknown {
  return isSqliteDatabaseUrl() ? JSON.stringify(orders) : orders;
}

/** dailyAggregate 컬럼 직렬화 — orders와 동일 규칙(SQLite=문자열, Postgres=객체). */
export function serializeDailyAggregate(aggregate: unknown): unknown {
  return isSqliteDatabaseUrl() ? JSON.stringify(aggregate) : aggregate;
}

/** claimSource 컬럼 직렬화 — orders·dailyAggregate와 동일 규칙(SQLite=문자열, Postgres=객체). */
export function serializeClaimSource(claimSource: unknown): unknown {
  return isSqliteDatabaseUrl() ? JSON.stringify(claimSource) : claimSource;
}

/**
 * 스냅샷 1행의 주문 배열 → 저장 가능한 claimSource 값(클레임 보유 주문 최소 프로젝션).
 * dailyAggregate와 동일 계약: 실패해도 throw하지 않되 삼키지도 않는다 —
 * 경고 로그 + {v:0} 마커로 표기해 읽기(claims 라우트)가 그 행만 블롭 폴백을 타게 한다.
 */
function buildClaimSourceValue(orders: unknown[]): unknown {
  try {
    return serializeClaimSource(computeSnapshotClaimSource(orders as any[]));
  } catch (err) {
    console.warn(
      "[naverOrderSnapshotRepository] claimSource 계산 실패 — UNAVAILABLE 표기(읽기는 블롭 폴백):",
      err,
    );
    return serializeClaimSource(SNAPSHOT_CLAIM_SOURCE_UNAVAILABLE);
  }
}

// ============================================================================
// dailyAggregate 쓰기 경로 (egress 절감, 2026-07-15 · P7)
//
// 스냅샷을 쓰는 시점엔 주문 배열이 이미 메모리에 있다 — 그때 캠페인별 일별 집계를
// 함께 계산해 영속하면, 읽기(모바일 매출 상세)가 orders 블롭을 아예 select 하지
// 않아도 된다. 계산 실패는 삼키지 않고 경고 로그 + UNAVAILABLE 마커로 표기해,
// 읽기가 그 행만 블롭 폴백으로 안전 강등되게 한다(스냅샷 쓰기 자체는 계속 성공).
// ============================================================================

/**
 * 집계 입력 캠페인 우주(발주 연동 판매캠페인 전수)의 단기 메모.
 * FULL 동기화는 upsertDaily를 날짜당 1회(최대 30회) 부르므로 매번 재조회하면
 * 같은 질의를 30번 돌린다. 캠페인 집합은 분 단위로 변하지 않고, 메모가 낡아
 * 신설 캠페인이 빠지더라도 읽기의 campaignIds 멤버십 가드가 그 행을 블롭
 * 폴백으로 강등하므로(오답이 아니라 절감 미적용) 짧은 TTL 메모가 안전하다.
 */
const AGGREGATION_SOURCES_TTL_MS = 60_000;
let aggregationSourcesMemo: { at: number; sources: PulseSalesCampaignSource[] } | null = null;

async function getAggregationCampaignSources(now = Date.now()): Promise<PulseSalesCampaignSource[]> {
  if (aggregationSourcesMemo && now - aggregationSourcesMemo.at < AGGREGATION_SOURCES_TTL_MS) {
    return aggregationSourcesMemo.sources;
  }
  const sources = await loadAggregationCampaignSources(prisma);
  aggregationSourcesMemo = { at: now, sources };
  return sources;
}

/** 테스트·캠페인 변경 직후를 위한 메모 무효화. */
export function resetAggregationSourcesMemo(): void {
  aggregationSourcesMemo = null;
}

/** 스냅샷 1행의 주문 배열 → 저장 가능한 dailyAggregate 값. 실패해도 throw하지 않는다. */
async function buildDailyAggregateValue(orders: unknown[]): Promise<unknown> {
  try {
    const campaigns = await getAggregationCampaignSources();
    return serializeDailyAggregate(
      computeSnapshotDailyAggregate(campaigns, orders as PulseOrderLike[]),
    );
  } catch (err) {
    // 에러를 삼키지 않는다: 경고를 남기고 읽기가 폴백을 타도록 명시적 마커를 쓴다.
    console.warn(
      "[naverOrderSnapshotRepository] dailyAggregate 계산 실패 — UNAVAILABLE 표기(읽기는 블롭 폴백):",
      err,
    );
    return serializeDailyAggregate(SNAPSHOT_DAILY_AGGREGATE_UNAVAILABLE);
  }
}

export const naverOrderSnapshotRepository = {
  async upsertDaily(input: NaverOrderSnapshotUpsertInput) {
    const {
      snapshotDate,
      orders,
      ordersCount,
      newOrdersCount,
      preparingCount,
      deliveringCount,
      isDirty,
      lastCallTime,
      syncType,
      lastChangeStatusCursor,
    } = input;

    const serializedOrders = serializeOrders(orders);
    const dailyAggregate = await buildDailyAggregateValue(orders);
    const claimSource = buildClaimSourceValue(orders);

    // lastChangeStatusCursor가 undefined(호출부에서 커서를 넘기지 않음)면 update/create 데이터에서
    // 필드 자체를 생략해 기존값을 보존한다. 명시적으로 null을 넘긴 경우에만 커서를 소거한다.
    // (이전에는 `?? null`로 undefined도 null로 뭉개버려 커서 미전달 update가 기존 커서를 지워버렸다.)
    const cursorField =
      lastChangeStatusCursor === undefined ? {} : { lastChangeStatusCursor };

    // select 최소화: Prisma upsert는 기본적으로 전 컬럼을 RETURNING으로 되돌려받아
    // 방금 올린 orders 블롭이 그대로 다시 내려온다(쓰기 1회당 행 크기만큼 egress).
    // 호출부는 반환값을 쓰지 않으므로 식별자만 돌려받는다.
    return prisma.naverOrderSnapshot.upsert({
      where: { snapshotDate },
      select: { id: true, snapshotDate: true },
      create: {
        snapshotDate,
        orders: serializedOrders as any,
        dailyAggregate: dailyAggregate as any,
        claimSource: claimSource as any,
        ordersCount,
        newOrdersCount,
        preparingCount,
        deliveringCount,
        isDirty,
        lastCallTime,
        syncType: syncType ?? "FULL",
        ...cursorField,
      },
      update: {
        orders: serializedOrders as any,
        dailyAggregate: dailyAggregate as any,
        claimSource: claimSource as any,
        ordersCount,
        newOrdersCount,
        preparingCount,
        deliveringCount,
        isDirty,
        lastCallTime,
        syncType: syncType ?? "FULL",
        ...cursorField,
      },
    });
  },

  // 이 조회들의 소비자(데스크톱 집계·크론·에이전트 툴)는 전부 orders 블롭을 파싱한다 —
  // dailyAggregate·claimSource는 쓰지 않으므로 omit해 신규 컬럼이 기존 경로의 egress를 늘리지 않게 한다.
  async findRange(startDateKey: string, endDateKey: string) {
    // snapshotDate는 YYYY-MM-DD 형식이라 사전순 정렬이 곧 날짜순 정렬과 동일하다.
    return prisma.naverOrderSnapshot.findMany({
      where: {
        snapshotDate: {
          gte: startDateKey,
          lte: endDateKey,
        },
      },
      omit: { dailyAggregate: true, claimSource: true },
    });
  },

  // claims 라우트 전용 경량 조회 — orders 블롭을 싣지 않고 claimSource(클레임 보유 주문
  // 최소 프로젝션)만 가져온다(2026-07-21, P7). claimSource가 null(레거시)·{v:0}·버전
  // 불일치인 행은 호출부가 findByDates로 그 날짜만 블롭 폴백한다.
  async findRangeClaimSources(startDateKey: string, endDateKey: string) {
    return prisma.naverOrderSnapshot.findMany({
      where: {
        snapshotDate: {
          gte: startDateKey,
          lte: endDateKey,
        },
      },
      select: { snapshotDate: true, claimSource: true },
      orderBy: { snapshotDate: "asc" },
    });
  },

  // 하이드레이션 1단계(신선도 판정) 전용 경량 메타 — orders 블롭을 싣지 않는다.
  // 종전에는 findRange 가 매 요청 전 기간 블롭을 전송한 **뒤** L1 lastCallTime 과
  // 비교했다(egress 는 비교 전에 이미 발생). 메타만 먼저 받고 2단계(findByDates)가
  // L1 보다 새로운 날짜만 블롭을 가져와, 웜 인스턴스 폴링을 보통 1행(오늘)으로 줄인다.
  async findRangeMeta(startDateKey: string, endDateKey: string) {
    return prisma.naverOrderSnapshot.findMany({
      where: {
        snapshotDate: {
          gte: startDateKey,
          lte: endDateKey,
        },
      },
      select: { snapshotDate: true, lastCallTime: true },
    });
  },

  // 하이드레이션 2단계 — 신선도 판정을 통과한 날짜의 전체 행(블롭 포함)만 조회.
  async findByDates(dateKeys: string[]) {
    if (dateKeys.length === 0) return [];
    return prisma.naverOrderSnapshot.findMany({
      where: { snapshotDate: { in: dateKeys } },
      omit: { dailyAggregate: true, claimSource: true },
    });
  },

  async findOne(snapshotDate: string) {
    return prisma.naverOrderSnapshot.findUnique({
      where: { snapshotDate },
      omit: { dailyAggregate: true, claimSource: true },
    });
  },

  // 변경피드 폴링 커서로 사용할, lastChangeStatusCursor가 있는 스냅샷 중 가장 최근 것을 반환한다.
  // 소비자(runChangedSync)는 커서 문자열과 날짜키만 쓴다 — orders 블롭을 싣지 않는다
  // (종전에는 전 컬럼을 읽어 CHANGED 동기화마다 최신행 블롭이 왕복했다).
  async findLatestCursor() {
    return prisma.naverOrderSnapshot.findFirst({
      where: { lastChangeStatusCursor: { not: null } },
      orderBy: { lastCallTime: "desc" },
      select: { snapshotDate: true, lastChangeStatusCursor: true },
    });
  },

  // 커서 전진 전용 좁은 update — orders를 다시 쓰지도, 돌려받지도 않는다.
  // (종전 경로: findLatestCursor로 블롭을 읽어 동일 orders를 upsertDaily로 재기록.
  //  dailyAggregate·claimSource는 실제 주문 변경 upsert 때만 재계산되며, 커서 전진이
  //  재계산을 생략해도 읽기 측 행 단위 폴백(P7)이 정합을 보장한다.)
  async advanceCursor(snapshotDate: string, cursorIso: string) {
    return prisma.naverOrderSnapshot.update({
      where: { snapshotDate },
      data: { lastChangeStatusCursor: cursorIso, syncType: "CHANGED" },
      select: { id: true },
    });
  },

  // 에이전트 툴(get_order_snapshot) 전용 경량 조회 — 일별 카운트 컬럼만 쓰고 orders 블롭은
  // 파싱조차 하지 않으므로 select에서 제외한다(관성 전컬럼 fetch 제거, 2026-07-24).
  async findRangeCounts(startDateKey: string, endDateKey: string) {
    return prisma.naverOrderSnapshot.findMany({
      where: {
        snapshotDate: {
          gte: startDateKey,
          lte: endDateKey,
        },
      },
      select: {
        snapshotDate: true,
        ordersCount: true,
        newOrdersCount: true,
        preparingCount: true,
        deliveringCount: true,
        lastCallTime: true,
      },
      orderBy: { snapshotDate: "asc" },
    });
  },

  // 가장 최근에 호출된 스냅샷의 lastCallTime·syncType (신선도 배지 등에 사용)
  async latestSyncMeta() {
    return prisma.naverOrderSnapshot.findFirst({
      orderBy: { lastCallTime: "desc" },
      select: { lastCallTime: true, syncType: true },
    });
  },

  // 캐시 무효화 지점(발송처리·마감취소 등) 회귀 방지용: GET이 더 이상 동기 fetch를 하지
  // 않으므로 "__naverDailyCache nuke" 관례만으로는 낡은 DB 스냅샷이 그대로 재하이드레이션된다.
  // 지정한 날짜의 스냅샷만 dirty로 마킹해 isSnapshotStale이 그 날짜에서 true를 반환하게 한다.
  //
  // ⛔ **날짜를 모른다고 창 전체를 찍지 말 것**(종전 `markAllDirty()`는 최근 30일을 뭉뚱그렸다).
  // dirty를 지우는 주체는 "그 날짜의 upsert" 하나뿐인데 크론은 CHANGED만 돌아 **변경피드에
  // 잡힌 날짜만** upsert한다 — 조용한 과거 날짜의 dirty는 지워지지 않는다. 그래서 창 전체
  // 마킹은 단조 증가해 **실측 48행 중 47행이 상시 true**가 됐고(2026-07-30), 플래그로
  // "이 날짜가 정말 재조회가 필요한가"를 물어볼 수 없게 됐다(관측 가치 0 · PR #145가 발주
  // 조회 생략 게이트에서 `isDirty`를 제외해야 했던 이유). 호출부가 영향 날짜를 알 수 없으면
  // 창을 넓히지 말고 `syncOrdersByIds` 같은 정밀 갱신 경로를 쓴다.
  async markDirty(dateKeys: string[]) {
    const unique = Array.from(new Set((dateKeys || []).filter(Boolean)));
    if (unique.length === 0) return { count: 0 };
    return prisma.naverOrderSnapshot.updateMany({
      where: { snapshotDate: { in: unique } },
      data: { isDirty: true },
    });
  },

  parseOrders(row: { orders: unknown }): any[] {
    return typeof row.orders === "string" ? JSON.parse(row.orders) : (row.orders as any[]);
  },
};
