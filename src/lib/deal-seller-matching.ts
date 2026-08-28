// 딜↔셀러 양방향 검토 판정 — 단일 진실 원천 (client-safe, 순수. Prisma 무의존).
//
// 이 모듈이 답하는 질문은 **"무엇을"** 이다. 같은 F1 계열의 두 모듈과 축이 다르다:
//   - `seller-dormancy.ts`   : 이 셀러와 얼마나 **오래** 거래가 없나 (절대 일수, D20)
//   - `recampaign-timing.ts` : 이 셀러의 **평소 주기**가 돌아왔나 (상대 케이던스)
//   - 이 파일                 : 이 딜에 **누구를** / 이 셀러에게 **무엇을** 제안하나 (D2)
// ⛔ 셋을 통합하지 말 것 — 앞 둘의 병행 유지는 오너 확정이고(2026-08-04), 이 모듈은 그
//    둘의 통합이 아니라 직교하는 **딜 차원**의 추가다. `recampaign-proposal.ts` 주석이
//    적어둔 "F1의 완성형(이 셀러에게 '이 딜'을 다시 제안)"이 여기다.
//
// ⛔ `fitLevel`(계정 신호)과 합산하지 않는다(D10). 표면은 두 축을 나란히 보여주고,
//    이 모듈은 거래 실적만 다룬다.
// ⛔ D3 우선순위(`priority`)를 **필터로 쓰지 말 것** — 정렬과 배지 전용이다. 문턱 미만을
//    숨기면 오너가 아는 예외가 화면에서 사라진다.
//
// 매칭 키에 **카테고리를 쓰지 않는 것은 의도다**(오너 확정 2026-08-04). `Deal.category` 는
// 마케팅 카테고리가 아니라 클레임 게이트 규칙 선택자(C1 §4)이고 사실상 미입력이며,
// `Seller.category` 는 어휘가 다른 자유 텍스트 다중 태그다. 두 필드를 조인하면 어휘가
// 어긋난 채 거의 매칭되지 않는다. 딜 쪽 카테고리 데이터가 생기면 그때 축을 추가한다.

import { computeDormancyTier, DORMANT_DAYS, type DormancyVerdict } from "@/lib/seller-dormancy";

const DAY_MS = 86_400_000;

/** D3 — 이 매출 이상인 (셀러×딜) 쌍은 재진행을 적극 검토한다. 셀러 누적이 아니라 쌍 단위다. */
export const RERUN_PRIORITY_SALES = 10_000_000;

/**
 * 후보가 후보인 **이유**. 화면 문구가 아니라 코드 어휘다 —
 * 기안 단계의 중복 제거 키가 `셀러id + 사유코드`라, 여기서 어휘를 고정해두면 기안·자동
 * 트리거 단계에서 dedup 키가 파생으로 나온다. 표면마다 사유 문구를 따로 쓰면 키가 갈린다.
 */
export type MatchReason = "SAME_DEAL_RERUN" | "SAME_PARTNER" | "LONG_GAP_SELLER" | "NEW_MATCH";

export const MATCH_REASON_LABEL: Record<MatchReason, string> = {
  SAME_DEAL_RERUN: "재진행",
  SAME_PARTNER: "같은 거래처",
  LONG_GAP_SELLER: "주기 길어짐",
  NEW_MATCH: "신규",
};

/** 사유의 우선 순위 — 낮을수록 위. */
const REASON_RANK: Record<MatchReason, number> = {
  SAME_DEAL_RERUN: 0,
  SAME_PARTNER: 1,
  LONG_GAP_SELLER: 2,
  NEW_MATCH: 3,
};

/**
 * Prisma `salesCampaign.groupBy({ by: ["sellerId","dealId","groupId"], _count, _max: { startDate },
 * _sum: { actualSales } })` 결과 한 행.
 *
 * **호출부 계약:** `where` 로 ①`RUN_STATUSES`(실행된 상태) ②`startDate <= now` 를 이미 걸어
 * 넘긴다. 여기서 다시 거르지 않는 이유는 groupBy 버킷이 이미 접혀 있어 행 단위 판정이
 * 불가능하기 때문이다 — 다만 **미래 날짜가 `lastRunStartAt` 이 되는 것만은** 아래에서 막는다.
 */
export type PairRunRow = {
  sellerId: string;
  dealId: string;
  groupId: string | null;
  /** 이 버킷의 행 수. 그룹 버킷에서는 1로 접힌다 */
  rowCount: number;
  lastStartAt: Date | string | null;
  /** 이 버킷의 매출 합. 전 행이 미입력이면 null (0 이 아니다) */
  salesSum: number | null;
};

export type PairRunSignal = {
  sellerId: string;
  dealId: string;
  dealPartnerId: string | null;
  /** 그룹을 1회로 접은 진행 횟수 */
  runCount: number;
  /** ISO 문자열. 과거 진행이 없으면 null */
  lastRunStartAt: string | null;
  /** 이 쌍의 누적 매출. null = 미입력 → **판정 보류**이지 0 이 아니다 */
  salesTotal: number | null;
};

/**
 * groupBy 결과를 (셀러, 딜) 쌍 신호로 접는다.
 *
 * 그룹 접기 규칙은 `tallyEffectiveCampaignCounts` 와 **같다**(그룹 버킷 = 1, 미그룹 버킷 =
 * 행 수). 그 함수를 직접 부르지 않는 이유는 키가 셀러 단위라서다 — 규칙만 같게 유지한다.
 * ℹ️ 쌍 단위에서 그룹 접기는 실질 무영향에 가깝다(한 그룹이 같은 딜을 두 번 담는 일이
 * 드물다). 그래도 같은 규칙을 쓰는 이유는 "그룹 = 1건" 의미가 표면마다 갈리지 않게
 * 하기 위해서다(codebase-map Code SSOT).
 */
export function buildPairRunSignals(
  rows: readonly PairRunRow[],
  dealPartnerById: ReadonlyMap<string, string | null>,
  now: Date = new Date(),
): PairRunSignal[] {
  const nowMs = now.getTime();
  const byPair = new Map<string, PairRunSignal>();

  for (const row of rows) {
    const key = `${row.sellerId}::${row.dealId}`;
    let signal = byPair.get(key);
    if (!signal) {
      signal = {
        sellerId: row.sellerId,
        dealId: row.dealId,
        dealPartnerId: dealPartnerById.get(row.dealId) ?? null,
        runCount: 0,
        lastRunStartAt: null,
        salesTotal: null,
      };
      byPair.set(key, signal);
    }

    signal.runCount += row.groupId != null ? 1 : row.rowCount;

    // 미입력은 0 으로 합산하지 않는다 — 하나라도 값이 있을 때만 합이 존재한다.
    if (row.salesSum != null) {
      signal.salesTotal = (signal.salesTotal ?? 0) + row.salesSum;
    }

    if (row.lastStartAt != null) {
      const ms =
        row.lastStartAt instanceof Date ? row.lastStartAt.getTime() : Date.parse(row.lastStartAt);
      // 미래 시작일은 '마지막 진행'이 아니다 — v1 이 밟은 경과일 음수 함정.
      if (Number.isFinite(ms) && ms <= nowMs) {
        const prev = signal.lastRunStartAt === null ? null : Date.parse(signal.lastRunStartAt);
        if (prev === null || ms > prev) signal.lastRunStartAt = new Date(ms).toISOString();
      }
    }
  }

  return Array.from(byPair.values());
}

function daysSince(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.floor((now.getTime() - ms) / DAY_MS);
}

/**
 * 재진행 간격이 도래했나.
 *
 * **새 임계를 만들지 않고** `DORMANT_DAYS` 를 재사용한다 — D20 의 90일은 애초에 D3
 * ("동일 캠페인은 통상 3개월 간격으로 재진행")에서 나온 값이라, 여기서 별도 상수를 세우면
 * 같은 오너 진술이 두 숫자로 갈린다.
 */
function isRerunDue(pair: PairRunSignal | undefined, now: Date): boolean {
  if (!pair) return false;
  const elapsed = daysSince(pair.lastRunStartAt, now);
  return elapsed !== null && elapsed >= DORMANT_DAYS;
}

/** 방금 돌린 조합인가 — 재제안하기 이르다. */
function isTooSoon(pair: PairRunSignal | undefined, now: Date): boolean {
  if (!pair) return false;
  const elapsed = daysSince(pair.lastRunStartAt, now);
  return elapsed !== null && elapsed < DORMANT_DAYS;
}

// --- 진입점 ① 딜 → 셀러 -----------------------------------------------------

export type SellerCandidateInput = {
  sellerId: string;
  /** 그룹을 1회로 접은 과거 진행 횟수. 0 이면 D1 스코프 밖이라 후보가 아니다 */
  runCount: number;
  lastRunStartAt: string | null;
};

export type SellerCandidate = {
  sellerId: string;
  reason: MatchReason;
  /** D3 부스터 — 이 딜과의 쌍 매출이 문턱 이상 */
  priority: boolean;
  /** 이 딜과의 과거 이력. 없으면 null */
  pairRunCount: number | null;
  pairLastRunStartAt: string | null;
  /** null = 매출 미입력(판정 보류). 0 으로 대체하지 말 것 */
  pairSalesTotal: number | null;
  /** 셀러 전체 기준 거래 리듬 — 화면에서 `fitLevel` 과 **나란히** 표시한다(합산 금지) */
  dormancy: DormancyVerdict;
  runCount: number;
};

export function rankSellerCandidatesForDeal(input: {
  dealId: string;
  dealPartnerId: string | null;
  sellers: readonly SellerCandidateInput[];
  pairs: readonly PairRunSignal[];
  excludeSellerIds: readonly string[];
  now?: Date;
}): SellerCandidate[] {
  const now = input.now ?? new Date();
  const excluded = new Set(input.excludeSellerIds);

  const pairsForDeal = new Map<string, PairRunSignal>();
  const partnersBySeller = new Map<string, Set<string>>();
  for (const pair of input.pairs) {
    if (pair.dealId === input.dealId) pairsForDeal.set(pair.sellerId, pair);
    if (pair.dealPartnerId != null) {
      const set = partnersBySeller.get(pair.sellerId) ?? new Set<string>();
      set.add(pair.dealPartnerId);
      partnersBySeller.set(pair.sellerId, set);
    }
  }

  const candidates: SellerCandidate[] = [];
  for (const seller of input.sellers) {
    if (excluded.has(seller.sellerId)) continue;
    // D1 — 매칭 스코프는 실제 판매 캠페인 이력 보유 셀러뿐이다(발굴·콜드 리스트 제외).
    if (seller.runCount <= 0) continue;

    const pair = pairsForDeal.get(seller.sellerId);
    if (isTooSoon(pair, now)) continue;

    const dormancy = computeDormancyTier(seller.lastRunStartAt, now);

    let reason: MatchReason;
    if (isRerunDue(pair, now)) {
      reason = "SAME_DEAL_RERUN";
    } else if (
      input.dealPartnerId != null &&
      partnersBySeller.get(seller.sellerId)?.has(input.dealPartnerId)
    ) {
      reason = "SAME_PARTNER";
    } else if (dormancy.tier === "DORMANT" || dormancy.tier === "EXCLUDED") {
      // D2① 의 "진행주기가 길어진 셀러" — 이 딜과의 접점은 없지만 재접촉 검토 대상이다.
      reason = "LONG_GAP_SELLER";
    } else {
      reason = "NEW_MATCH";
    }

    candidates.push({
      sellerId: seller.sellerId,
      reason,
      priority: pair?.salesTotal != null && pair.salesTotal >= RERUN_PRIORITY_SALES,
      pairRunCount: pair?.runCount ?? null,
      pairLastRunStartAt: pair?.lastRunStartAt ?? null,
      pairSalesTotal: pair?.salesTotal ?? null,
      dormancy,
      runCount: seller.runCount,
    });
  }

  return candidates.sort((a, b) => {
    if (a.reason !== b.reason) return REASON_RANK[a.reason] - REASON_RANK[b.reason];
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    const aGap = a.dormancy.daysSinceLastRun ?? -1;
    const bGap = b.dormancy.daysSinceLastRun ?? -1;
    if (aGap !== bGap) return bGap - aGap; // 오래 멈춘 순
    return (b.pairSalesTotal ?? 0) - (a.pairSalesTotal ?? 0);
  });
}

// --- 진입점 ② 셀러 → 딜 -----------------------------------------------------

export type DealCandidateInput = {
  dealId: string;
  dealName: string;
  brandName: string | null;
  partnerId: string | null;
  /**
   * **신규 제안이 가능한 딜인가**(파이프라인에 살아 있는가).
   *
   * ⚠️ 재진행 후보와 신규 제안 후보의 풀이 다르기 때문에 필요한 축이다. `ARCHIVED`
   * (라벨 "완료")는 **끝난 딜이라 새로 제안할 것이 아니지만, D3 재진행의 1순위 모집단**
   * 이다("동일 캠페인은 통상 3개월 간격으로 재진행"). 살아 있는 딜만 넘기면 재진행이
   * 원천적으로 안 뜨고, 완료 딜까지 신규로 취급하면 끝난 딜을 새로 권하게 된다.
   * ⚠️ `DROPPED` 의 라벨은 "보류"다("폐기"가 아니다) — 호출부가 풀에서 제외한다.
   */
  isLive: boolean;
  /** ISO 문자열 — 동률일 때 최근 등록 순으로 가른다 */
  createdAt: string;
};

export type DealCandidate = {
  dealId: string;
  dealName: string;
  brandName: string | null;
  reason: MatchReason;
  priority: boolean;
  pairRunCount: number | null;
  pairLastRunStartAt: string | null;
  pairSalesTotal: number | null;
};

export function rankDealCandidatesForSeller(input: {
  sellerId: string;
  deals: readonly DealCandidateInput[];
  pairs: readonly PairRunSignal[];
  /**
   * 이 셀러에게 **이미 아웃리치가 있는 딜**. 딜→셀러 방향의 `excludeSellerIds` 와 같은
   * 제외이고, 두 방향이 같은 모수를 봐야 한다 — 한쪽만 걸면 목록은 후보로 보여주는데
   * 기안은 "후보가 아니다"로 거절한다(실렌더에서 잡힌 불일치).
   */
  excludeDealIds?: readonly string[];
  now?: Date;
}): DealCandidate[] {
  const now = input.now ?? new Date();
  const excluded = new Set(input.excludeDealIds ?? []);

  // 다른 셀러의 쌍 신호가 이 셀러 판정에 섞이면 안 된다 — 호출부가 전 셀러분을 넘길 수 있다.
  const myPairs = input.pairs.filter((p) => p.sellerId === input.sellerId);
  const pairByDeal = new Map(myPairs.map((p) => [p.dealId, p]));
  const myPartners = new Set(
    myPairs.map((p) => p.dealPartnerId).filter((id): id is string => id != null),
  );

  const candidates: DealCandidate[] = [];
  for (const deal of input.deals) {
    if (excluded.has(deal.dealId)) continue;
    const pair = pairByDeal.get(deal.dealId);
    if (isTooSoon(pair, now)) continue;
    // 끝난 딜은 **이 셀러가 전에 돌린 경우에만** 후보다(재진행). 접점이 없으면 신규
    // 제안 대상이 아니다 — 완료된 딜을 새로 권하게 된다.
    if (!deal.isLive && !pair) continue;

    let reason: MatchReason;
    if (isRerunDue(pair, now)) reason = "SAME_DEAL_RERUN";
    else if (deal.partnerId != null && myPartners.has(deal.partnerId)) reason = "SAME_PARTNER";
    else reason = "NEW_MATCH";
    // LONG_GAP_SELLER 가 이쪽에 없는 것은 의도다 — 셀러가 이미 하나로 고정돼 있어
    // "주기가 길어진 셀러"가 후보를 가르는 축이 되지 못한다(D2 의 두 방향은 대칭이 아니다).

    candidates.push({
      dealId: deal.dealId,
      dealName: deal.dealName,
      brandName: deal.brandName,
      reason,
      priority: pair?.salesTotal != null && pair.salesTotal >= RERUN_PRIORITY_SALES,
      pairRunCount: pair?.runCount ?? null,
      pairLastRunStartAt: pair?.lastRunStartAt ?? null,
      pairSalesTotal: pair?.salesTotal ?? null,
    });
  }

  const createdAtByDeal = new Map(input.deals.map((d) => [d.dealId, Date.parse(d.createdAt)]));
  return candidates.sort((a, b) => {
    if (a.reason !== b.reason) return REASON_RANK[a.reason] - REASON_RANK[b.reason];
    if (a.priority !== b.priority) return a.priority ? -1 : 1;
    return (createdAtByDeal.get(b.dealId) ?? 0) - (createdAtByDeal.get(a.dealId) ?? 0);
  });
}
