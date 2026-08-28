// 딜↔셀러 후보 **조회**(서버 전용, Prisma 의존). 판정은 `deal-seller-matching.ts` SSOT 가
// 하고 이 파일은 집계와 표기만 담당한다.
//
// 왜 라우트에 인라인하지 않나: 후보를 **그리는** 라우트와 그 후보를 **기안으로 승격하는**
// 라우트가 같은 계산을 써야 한다. 기안 라우트가 자기 버전을 다시 짜면 "서버 권위 재계산"
// (클라이언트가 보낸 상태 불신)이 화면과 다른 답을 내면서도 통과한다.
//
// P7 egress: 캠페인 행을 fetch 하지 않고 groupBy 집계 한 번으로 (셀러,딜) 쌍 신호를 만든다.

import type { PrismaClient } from "@prisma/client";
import { tallyEffectiveCampaignCounts } from "@/lib/campaign-group-count";
import { RUN_STATUSES } from "@/lib/recampaign-timing";
import { DORMANT_DAYS } from "@/lib/seller-dormancy";
import {
  buildPairRunSignals,
  rankSellerCandidatesForDeal,
  RERUN_PRIORITY_SALES,
  type PairRunRow,
  type SellerCandidate,
} from "@/lib/deal-seller-matching";

export type SellerCandidateView = SellerCandidate & {
  /** alias 우선 표기 (P2 Seller Alias Priority) */
  name: string;
  snsHandle: string;
  snsType: string;
  fitLevel: string | null;
  currentFollowers: number;
};

export type DealSellerCandidatesResult = {
  /** 딜이 없으면 null — 호출부가 404 로 옮긴다 */
  deal: { id: string; partnerId: string | null } | null;
  candidates: SellerCandidateView[];
};

type PrismaLike = Pick<PrismaClient, "deal" | "seller" | "salesCampaign" | "salesTask">;

/** groupBy 결과를 쌍 신호로 옮긴다. Decimal → number 변환이 여기 한 곳에만 있다. */
export function toPairRunRows(
  rows: readonly {
    sellerId: string;
    dealId: string;
    groupId: string | null;
    _count: { _all: number };
    _max: { startDate: Date | null };
    _sum: { actualSales: unknown };
  }[],
): PairRunRow[] {
  return rows.map((r) => ({
    sellerId: r.sellerId,
    dealId: r.dealId,
    groupId: r.groupId,
    rowCount: r._count._all,
    lastStartAt: r._max.startDate,
    // 전 행 미입력이면 Prisma 가 null 을 준다 — **0 으로 바꾸지 않는다**(판정 보류).
    salesSum: r._sum.actualSales == null ? null : Number(r._sum.actualSales),
  }));
}

/**
 * groupBy 행을 **셀러 단위** 진행 신호로 접는다(쿼리 추가 없이) — 거래 리듬 판정 입력.
 *
 * 🪤 **쌍 신호(`PairRunSignal`)를 더해서 만들면 안 된다.** `CampaignGroup` 은 실캠페인
 * 1개를 **딜별 N행으로 분할**한 것이라(CG-1) 한 그룹이 같은 셀러의 여러 딜에 걸친다.
 * 쌍 단위로 접으면 그룹이 딜마다 1회로 세어지고, 그걸 셀러 단위로 다시 더하면 **한 번
 * 진행한 그룹이 딜 수만큼 부풀어 오른다**(프로덕션의 그룹은 전부 다딜 구성이라 상시 발생).
 * 그래서 셀러 레벨 개수는 `tallyEffectiveCampaignCounts` 에 위임하고, 그 함수가 기대하는
 * 입력 모양(`sellerId, groupId` 당 한 행)으로 먼저 접는다.
 */
export function foldSellerRunSignals(
  rows: readonly PairRunRow[],
  now: Date = new Date(),
): Map<string, { runCount: number; lastRunStartAt: string | null }> {
  const nowMs = now.getTime();

  // (sellerId, groupId) 당 한 행으로 접는다 — 딜 축을 지운다.
  // 그룹 버킷은 `tallyEffectiveCampaignCounts` 가 rowCount 를 무시하고 1 로 세고,
  // 미그룹 버킷은 행 수를 그대로 더하므로 여기서 합산해 둔다.
  const buckets = new Map<string, { sellerId: string; groupId: string | null; rowCount: number }>();
  for (const row of rows) {
    const key = `${row.sellerId}::${row.groupId ?? "-"}`;
    const existing = buckets.get(key);
    if (existing) existing.rowCount += row.rowCount;
    else buckets.set(key, { sellerId: row.sellerId, groupId: row.groupId, rowCount: row.rowCount });
  }
  const counts = tallyEffectiveCampaignCounts([...buckets.values()]);

  const lastBySeller = new Map<string, number>();
  for (const row of rows) {
    if (row.lastStartAt == null) continue;
    const ms =
      row.lastStartAt instanceof Date ? row.lastStartAt.getTime() : Date.parse(row.lastStartAt);
    // 미래 시작일은 '마지막 진행'이 아니다 — 호출부 where 절에 이은 벨트앤서스펜더.
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    const prev = lastBySeller.get(row.sellerId);
    if (prev === undefined || ms > prev) lastBySeller.set(row.sellerId, ms);
  }

  const bySeller = new Map<string, { runCount: number; lastRunStartAt: string | null }>();
  for (const [sellerId, runCount] of counts) {
    const lastMs = lastBySeller.get(sellerId);
    bySeller.set(sellerId, {
      runCount,
      lastRunStartAt: lastMs === undefined ? null : new Date(lastMs).toISOString(),
    });
  }
  return bySeller;
}

export async function loadDealSellerCandidates(
  prisma: PrismaLike,
  dealId: string,
  now: Date = new Date(),
): Promise<DealSellerCandidatesResult> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, partnerId: true },
  });
  if (!deal) return { deal: null, candidates: [] };

  const [runRows, deals, sellers, linkedTasks] = await Promise.all([
    prisma.salesCampaign.groupBy({
      by: ["sellerId", "dealId", "groupId"],
      // SSOT 호출부 계약: 실행된 상태 + 시작일 도래분만 넘긴다.
      where: { status: { in: [...RUN_STATUSES] }, startDate: { lte: now } },
      _count: { _all: true },
      _max: { startDate: true },
      _sum: { actualSales: true },
    }),
    prisma.deal.findMany({ select: { id: true, partnerId: true } }),
    prisma.seller.findMany({
      select: {
        id: true,
        name: true,
        alias: true,
        snsHandle: true,
        snsType: true,
        fitLevel: true,
        currentFollowers: true,
      },
    }),
    prisma.salesTask.findMany({ where: { dealId }, select: { sellerId: true } }),
  ]);

  const rows = toPairRunRows(runRows);
  const pairs = buildPairRunSignals(rows, new Map(deals.map((d) => [d.id, d.partnerId])), now);
  // 셀러 개수는 **쌍 신호가 아니라 원 행**에서 접는다 — 위 함수 주석의 이중 집계 함정.
  const sellerRuns = foldSellerRunSignals(rows, now);

  const ranked = rankSellerCandidatesForDeal({
    dealId: deal.id,
    dealPartnerId: deal.partnerId,
    sellers: sellers.map((s) => ({
      sellerId: s.id,
      runCount: sellerRuns.get(s.id)?.runCount ?? 0,
      lastRunStartAt: sellerRuns.get(s.id)?.lastRunStartAt ?? null,
    })),
    pairs,
    excludeSellerIds: linkedTasks.map((t) => t.sellerId),
    now,
  });

  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  return {
    deal,
    candidates: ranked.flatMap((c) => {
      const s = sellerById.get(c.sellerId);
      if (!s) return [];
      return [
        {
          ...c,
          name: s.alias && s.alias.trim() !== "" ? s.alias : s.name,
          snsHandle: s.snsHandle,
          snsType: s.snsType,
          fitLevel: s.fitLevel,
          currentFollowers: s.currentFollowers,
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------
// 자동 기안 대상 스윕 (3단계) — 크론이 하루 한 번 훑는다
// ---------------------------------------------------------------------------

export type AutoProposableRerun = {
  sellerId: string;
  /** alias 우선 표기 (P2) */
  sellerName: string;
  dealId: string;
  dealName: string;
  pairRunCount: number;
  pairDaysSinceLastRun: number;
  /** 이 쌍의 누적 매출. 자동 발화 게이트를 통과한 값이라 항상 non-null 이다 */
  pairSalesTotal: number;
};

/**
 * **자동 기안 대상**인 재진행 쌍을 훑는다.
 *
 * 화면(D2 진입점)과 **모수가 다르다** — 화면은 사유 4종을 전부 보여주지만 자동 발화는
 * 아래 조건을 전부 만족하는 `SAME_DEAL_RERUN` 만이다:
 *
 *   · 재진행 간격 도래(`DORMANT_DAYS`) — 타이밍 조건
 *   · 쌍 누적 매출 ≥ `RERUN_PRIORITY_SALES` — **오너 확정 2026-08-04**
 *   · 아직 아웃리치가 없는 조합 · 보류 딜·옵션 딜 제외
 *
 * ⚠️ **D3 매출 조건을 자동 발화 게이트로 쓰는 것은 화면의 규칙과 다르다.** 화면에서는
 * 여전히 정렬·배지 전용이고 문턱 미만도 전부 보인다(D10 — 실적 축으로 후보를 거르지
 * 않는다). 여기서만 게이트인 이유는 답하는 질문이 다르기 때문이다 — 화면은 "무엇이
 * 있는가", 크론은 "**오너를 승인함으로 부를 만한가**". 둘을 하나로 합치지 말 것.
 *
 * ⛔ `SAME_PARTNER`·`NEW_MATCH` 는 자동 발화 대상이 아니다 — 타이밍이 아니라 탐색 힌트이고,
 * 조합이 셀러×딜이라 승인함이 즉사한다.
 */
export async function loadAutoProposableRerunPairs(
  prisma: PrismaLike,
  now: Date = new Date(),
): Promise<AutoProposableRerun[]> {
  const [runRows, deals, sellers, tasks] = await Promise.all([
    prisma.salesCampaign.groupBy({
      by: ["sellerId", "dealId", "groupId"],
      where: { status: { in: [...RUN_STATUSES] }, startDate: { lte: now } },
      _count: { _all: true },
      _max: { startDate: true },
      _sum: { actualSales: true },
    }),
    // 🪤 상태 라벨을 영문 이름으로 짐작하지 말 것 — `ARCHIVED` 는 "완료"라 재진행의 주
    // 모집단이고, 빼야 하는 것은 `DROPPED`("보류")다. 옵션 딜은 제안 단위가 아니다.
    prisma.deal.findMany({
      where: { status: { notIn: ["DROPPED"] }, parentDealId: null },
      select: { id: true, dealName: true, partnerId: true },
    }),
    prisma.seller.findMany({ select: { id: true, name: true, alias: true } }),
    prisma.salesTask.findMany({ select: { sellerId: true, dealId: true } }),
  ]);

  const dealById = new Map(deals.map((d) => [d.id, d]));
  const sellerById = new Map(sellers.map((s) => [s.id, s]));
  const hasOutreach = new Set(tasks.map((t) => `${t.sellerId}::${t.dealId}`));

  const pairs = buildPairRunSignals(
    toPairRunRows(runRows),
    new Map(deals.map((d) => [d.id, d.partnerId])),
    now,
  );

  const out: AutoProposableRerun[] = [];
  for (const pair of pairs) {
    const deal = dealById.get(pair.dealId);
    const seller = sellerById.get(pair.sellerId);
    if (!deal || !seller) continue;
    if (hasOutreach.has(`${pair.sellerId}::${pair.dealId}`)) continue;
    if (pair.lastRunStartAt === null) continue;
    // 미입력 매출은 0 이 아니라 **판정 보류**다 — 게이트를 통과시키지 않는다.
    if (pair.salesTotal === null || pair.salesTotal < RERUN_PRIORITY_SALES) continue;

    const elapsed = Math.floor((now.getTime() - Date.parse(pair.lastRunStartAt)) / 86_400_000);
    if (elapsed < DORMANT_DAYS) continue;

    out.push({
      sellerId: pair.sellerId,
      sellerName: seller.alias && seller.alias.trim() !== "" ? seller.alias : seller.name,
      dealId: pair.dealId,
      dealName: deal.dealName,
      pairRunCount: pair.runCount,
      pairDaysSinceLastRun: elapsed,
      pairSalesTotal: pair.salesTotal,
    });
  }

  // 오래 멈춘 순 → 같으면 매출 큰 순. 상한에 걸릴 때 앞쪽이 남는다.
  return out.sort(
    (a, b) => b.pairDaysSinceLastRun - a.pairDaysSinceLastRun || b.pairSalesTotal - a.pairSalesTotal,
  );
}
