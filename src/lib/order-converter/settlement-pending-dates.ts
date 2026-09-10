import { naverOrderSnapshotRepository } from '@/repositories/naverOrderSnapshotRepository';
import { deriveClaimsFromOrder, parseSnapshotClaimSource } from './claim-derive';
import { prisma } from './prisma';
import { addKstDays, kstDayStartMs, toKstDateKey } from './order-fetch-window';

/**
 * 정산 조회의 **대상 날짜 선정 SSOT** — 달력이 아니라 「정산 대기 주문」에서 뽑는다.
 *
 * 설계 정본: `docs/private/specs/2026-09-10-settlement-query-redesign.md`
 * API 조사 정본: `docs/private/plans/NAVER_SETTLEMENT_API_PLAN.md`
 *
 * ## 왜 이 모듈이 생겼나
 *
 * `runSettlementSync(3, 21)` 은 **날짜 수만큼 무조건** 호출한다 — 정산완료일 3일 + 결제일
 * 21일 = 하루 24콜이 데이터 유무와 무관하게 나간다. 실측에서는 그 21일 중 대상 주문이 있는
 * 날이 극소수였고, 나머지는 "없어요"를 받으려고 부른 것이다. 프록시(네이버 IP 허용 통로)의
 * 월 호출 한도가 정해져 있어 이 구조는 산술적으로 들어가지 않는다.
 *
 * 같은 규칙이 이 레포에 **이미 있다** — 발주 조회는 `order-fetch-window.decideChunkSkip` 이
 * "그 날짜에 발주 대상이 없다"는 스냅샷의 증언으로 조회를 생략하고, 사후취소 조회는
 * 정산 락(`isSalesCampaignLocked`)으로 멈춘다. **정산 조회만 그 규칙이 안 걸려 있었다.**
 *
 * ## 세 가지 대상 (`PendingDateReason`)
 *
 * 이 모듈은 「부를 날짜」를 세 경로로만 만든다. 셋 다 종료 조건이 있어 **수렴한다** —
 * 종료 조건 없는 대기 집합이 정확히 종전 구조의 실패였다. 실측에서 미정산으로 남아 있던
 * 행은 대부분 **이미 정산완료 행이 따로 있는 낡은 사본**이었고 나머지는 **취소 주문**,
 * 즉 전부 **영영 정산되지 않을 질문**이었다(수치는 위 설계 정본).
 *
 * ## ⚠️ `MAX_AGE` 는 P7 「now 상대 하한 금지」의 대상이 아니다
 *
 * P7 *Live 조회 창* 계약이 금지하는 것은 `max(캠페인_시작, now − N일)` 처럼 **고정된 도메인
 * 창의 시작을 now 로 갉아먹는** 형태다(캠페인 초반 날짜가 하루에 하나씩 조회 밖으로 밀려
 * 매출 숫자 자체가 줄어든 실사고). 여기서 기준점은 캠페인이 아니라 **주문 각자의 결제일**
 * 이고, 묻는 것은 "이 주문의 정산을 얼마나 오래 기다릴 것인가"라는 **건별 타임아웃**이다.
 * 갉아먹히는 도메인 창이 없다 — 창을 넓혀도 추가로 잡히는 것은 무시할 만한 꼬리뿐이다.
 */

/**
 * 정산 완료를 기다리는 상한(일). 이보다 오래된 결제 건은 「영영 정산되지 않을 건」으로 보고
 * 대기 집합에서 뺀다.
 *
 * **10일은 실측에서 나왔고 오너가 확정했다(2026-09-10).** 결제→정산완료 지연 분포를 재 보면
 * 상한을 5일에서 10일로 넓히는 구간에서 포착률이 급격히 평평해지고, 그 뒤로는 21일까지
 * 늘려도 남는 꼬리가 거의 없다 — **꼬리를 잡는 비용이 얻는 정확도를 넘어서는 지점**이 10일
 * 이다. 상한별 포착률·놓침 비중의 실측표는 위 설계 정본에 있다(P0: 추적 파일에 실측치를
 * 옮기지 않는다). 오너 판단은 **「그 정확도를 유지하는 비용이 과도하다」** 였다.
 *
 * 🔑 **놓쳐도 금액은 틀리지 않는다.** 네이버는 정산 **전**에도 `settleExpectAmount` 를 주고,
 * 그 값이 나중의 실입금과 같다(실측 대조에서 전건 일치). 상한을 넘겨 못 잡은 건은
 * 「정산예정」 칸에 **정확한 금액인 채로** 남는다 — 잃는 것은 예정/완료 **라벨**이고, 조정이
 * 필요하면 기존 수동 정산 항목(`CampaignSettlementItem`)으로 처리한다.
 * ⛔ 이 사실을 모른 채 상한만 키우지 말 것(그게 종전 21일이었다).
 *
 * 🪤 **7일이 아니라 10일인 이유는 취소 차감이다.** 관측된 `*_CANCEL` 차감의 지연이 원거래
 * 정산보다 길었고, 차감을 놓치는 것은 라벨이 아니라 **금액을 실제보다 높게 잡는** 방향이다.
 */
export const SETTLEMENT_PENDING_MAX_AGE_DAYS = 10;

/**
 * 취소·반품 재진입(`claim-without-deduction`)을 살펴보는 범위(일).
 *
 * 오너 도메인 기준(2026-09-10): 반품기간은 캠페인 종료 +9~10일에 끝나고, 그 뒤 움직이는 건은
 * 사후 불량 반품·제조사 배송지연(7~14일) 같은 **드문 예외**다. 캠페인은 최대 30일 안쪽으로
 * 운영되므로(P7) 결제일 기준 30 + 10 + 14 ≈ 54일이 그 예외가 도달할 수 있는 가장 늦은 지점
 * 이고, 여기에 여유를 둬 60일로 잡는다.
 *
 * **이 범위가 넓어도 조회가 늘지 않는다** — 재진입은 DB 가 「취소가 실제로 일어났다」고
 * 말하는 주문에만 붙기 때문이다(§`claim-without-deduction`). 예외가 없으면 0콜이다.
 */
export const SETTLEMENT_CLAIM_LOOKBACK_DAYS = 60;

/** 이 날짜를 부르는 이유. 한 날짜에 여러 이유가 겹칠 수 있다. */
export type PendingDateReason =
  /** 정산완료 행이 아직 없는 주문의 결제일. 완료 행이 생기면 자동으로 빠진다. */
  | 'unsettled-order'
  /**
   * 주문은 있는데 그 결제일의 정산 원장을 **한 번도 못 받은** 날.
   * 이게 없으면 크론이 며칠 멈춘 뒤 그 구간이 통째로 조회 대상에서 사라진다
   * (`unsettled-order` 는 이미 받아 둔 행에서만 출발하기 때문이다).
   */
  | 'no-ledger-yet'
  /**
   * 취소·반품이 일어났고 원거래는 정산까지 끝났는데 **차감 행이 아직 없는** 주문의 결제일.
   *
   * 취소 사실 자체는 주문 동기화의 변경피드가 **프록시 비용 0으로** 알려준다(스냅샷의
   * `claimSource` 프로젝션). 그래서 「사후 반품이 올 수도 있으니」 넓은 창을 상시 유지할
   * 필요가 없다 — **취소가 실제로 일어난 그 결제일만 다시 부른다.**
   *
   * ⚠️ 「원거래가 정산됐을 때만」이 수렴 조건이다. 정산 전에 취소된 주문은 차감할 돈이
   * 애초에 없어 차감 행이 영영 안 온다(실측에서 미정산으로 남은 취소 건이 전부 이 부류였다).
   * 그 조건이 없으면 이 이유가 종전 구조와 똑같이 수렴하지 않는다.
   */
  | 'claim-without-deduction';

/** `NaverSettlementCase` 에서 이 판정이 쓰는 필드만. */
export interface SettlementCaseRow {
  productOrderId: string;
  settleType: string | null;
  payDate: Date | null;
  settled: boolean;
}

/** 취소·반품이 관측된 주문(스냅샷 `claimSource` 파생). `payDateKey` 는 그 주문이 귀속된 스냅샷 날짜다. */
export interface ClaimedOrderRow {
  productOrderId: string;
  payDateKey: string;
}

/** 스냅샷 행(경량 — `findRangeCounts` 프로젝션의 부분집합). */
export interface SnapshotOrderCountRow {
  snapshotDate: string;
  ordersCount: number;
}

export interface PendingDateEntry {
  dateKey: string;
  /** 사전순 고정(관측·테스트 안정성). */
  reasons: PendingDateReason[];
  /** 이 날짜에 걸린 대기 주문 수 — 관측용이며 판정에 쓰지 않는다. */
  pendingOrders: number;
}

export interface SettlementQueryPlan {
  /** 부를 날짜(오름차순). 비어 있으면 이번 회차의 정산 조회는 **0콜**이다. */
  dates: PendingDateEntry[];
  /**
   * 예상 호출 수. 날짜당 1콜을 가정한다 — `pageSize` 가 1000 이라 하루 주문이 1000건을
   * 넘을 때만 페이지가 늘어난다(하루 주문 규모는 P7 *Product-Order Query Paging* 참조).
   */
  estimatedCalls: number;
  counters: {
    /** 정산완료 행이 없어 대기 중인 주문 수. */
    pendingUnsettledOrders: number;
    /** 원장을 한 번도 못 받은 날짜 수. */
    datesWithoutLedger: number;
    /** 차감 행을 기다리는 취소·반품 주문 수. */
    claimsAwaitingDeduction: number;
    /** 정산완료 행이 있어 대기에서 빠진 주문 수(종료①). */
    droppedBySettled: number;
    /** 취소·반품이라 대기에서 빠진 주문 수(종료②) — 차감 대기와는 다른 부류다. */
    droppedByClaim: number;
    /** 상한(`SETTLEMENT_PENDING_MAX_AGE_DAYS`)을 넘겨 포기한 주문 수(종료③). */
    droppedByAge: number;
  };
}

/** `settleType` 이 차감(취소) 계열인가. 원거래는 `*_ORIGINAL`, 차감은 `*_CANCEL` 이다. */
function isDeductionType(settleType: string | null): boolean {
  return !!settleType && settleType.toUpperCase().includes('CANCEL');
}

/**
 * `payDate` 를 KST 날짜키로 옮긴다.
 *
 * 네이버는 `payDate` 를 `YYYY-MM-DD` 로 주고 `new Date()` 가 그것을 **UTC 자정**으로 읽으므로
 * (즉 `…T00:00:00.000Z` 형태), +9h 를 더해도 날짜가 넘어가지 않는다. 같은 키를
 * 스냅샷 `snapshotDate`(`orderToDateKey` 가 `paymentDate` 로 만든 KST 키)와 맞대기 위해
 * 공용 헬퍼를 쓴다 — ⛔ 여기서 날짜 계산을 새로 적지 말 것(이 레포엔 KST 키 사본이 이미
 * 여럿이고, 갈리면 「같은 날인데 다른 키」로 조용히 어긋난다).
 */
function payDateKeyOf(payDate: Date | null): string | null {
  if (!payDate) return null;
  const ms = payDate.getTime();
  if (!Number.isFinite(ms)) return null;
  return toKstDateKey(ms);
}

/**
 * 부를 날짜를 정한다(순수).
 *
 * 입력은 전부 **우리 DB 가 이미 아는 것**이다 — 네이버를 부르지 않고 계획이 나오는 것이
 * 이 설계의 요점이고, 그래서 `?dryRun=1` 이 조회 0회로 검증된다.
 */
export function decideSettlementQueryPlan(args: {
  todayKey: string;
  cases: SettlementCaseRow[];
  claimedOrders: ClaimedOrderRow[];
  snapshots: SnapshotOrderCountRow[];
}): SettlementQueryPlan {
  const { todayKey, cases, claimedOrders, snapshots } = args;

  const oldestPendingKey = addKstDays(todayKey, -SETTLEMENT_PENDING_MAX_AGE_DAYS);
  const oldestClaimKey = addKstDays(todayKey, -SETTLEMENT_CLAIM_LOOKBACK_DAYS);

  /** 원거래가 정산 완료된 주문. 종료① 이자 차감 재진입의 전제다. */
  const settledOriginals = new Set<string>();
  /** 차감 행이 이미 온 주문 — 재진입이 여기서 멈춘다. */
  const deducted = new Set<string>();
  /** 원장을 받아 본 결제일 — `no-ledger-yet` 의 반대편이다. */
  const ledgerDateKeys = new Set<string>();
  const claimedIds = new Set(claimedOrders.map((o) => o.productOrderId));

  for (const row of cases) {
    const key = payDateKeyOf(row.payDate);
    if (key) ledgerDateKeys.add(key);
    if (isDeductionType(row.settleType)) {
      deducted.add(row.productOrderId);
    } else if (row.settled) {
      settledOriginals.add(row.productOrderId);
    }
  }

  const reasonsByDate = new Map<string, Set<PendingDateReason>>();
  const ordersByDate = new Map<string, Set<string>>();
  const addDate = (dateKey: string, reason: PendingDateReason, productOrderId?: string) => {
    let reasons = reasonsByDate.get(dateKey);
    if (!reasons) reasonsByDate.set(dateKey, (reasons = new Set()));
    reasons.add(reason);
    if (productOrderId) {
      let orders = ordersByDate.get(dateKey);
      if (!orders) ordersByDate.set(dateKey, (orders = new Set()));
      orders.add(productOrderId);
    }
  };

  const counters: SettlementQueryPlan['counters'] = {
    pendingUnsettledOrders: 0,
    datesWithoutLedger: 0,
    claimsAwaitingDeduction: 0,
    droppedBySettled: 0,
    droppedByClaim: 0,
    droppedByAge: 0,
  };

  // ── ① 정산완료 행이 없는 주문의 결제일 ────────────────────────────────────
  // 같은 주문의 여러 행(원거래·차감)이 같은 productOrderId 를 공유하므로 **주문 단위**로
  // 접은 뒤 판정한다 — 행 단위로 세면 낡은 미정산 사본 하나가 이미 끝난 주문을 되살린다
  // (실측에서 남아 있던 미정산 행 대부분이 정확히 그 부류였다).
  const unsettledCandidates = new Map<string, string>(); // productOrderId → payDateKey
  for (const row of cases) {
    if (row.settled || isDeductionType(row.settleType)) continue;
    const key = payDateKeyOf(row.payDate);
    if (!key) continue; // 결제일을 모르면 어느 날짜를 불러야 할지도 모른다 — 조용히 버리지 않고 계수 대상 밖으로 둔다.
    unsettledCandidates.set(row.productOrderId, key);
  }
  for (const [productOrderId, dateKey] of unsettledCandidates) {
    if (settledOriginals.has(productOrderId)) {
      counters.droppedBySettled++;
      continue;
    }
    if (claimedIds.has(productOrderId)) {
      counters.droppedByClaim++;
      continue;
    }
    if (dateKey < oldestPendingKey) {
      counters.droppedByAge++;
      continue;
    }
    counters.pendingUnsettledOrders++;
    addDate(dateKey, 'unsettled-order', productOrderId);
  }

  // ── ② 주문은 있는데 원장을 한 번도 못 받은 날 ─────────────────────────────
  for (const snap of snapshots) {
    if (snap.ordersCount <= 0) continue;
    if (snap.snapshotDate < oldestPendingKey || snap.snapshotDate > todayKey) continue;
    if (ledgerDateKeys.has(snap.snapshotDate)) continue;
    counters.datesWithoutLedger++;
    addDate(snap.snapshotDate, 'no-ledger-yet');
  }

  // ── ③ 취소·반품인데 차감 행이 아직 없는 주문의 결제일 ─────────────────────
  for (const claimed of claimedOrders) {
    if (!settledOriginals.has(claimed.productOrderId)) continue; // 정산 전 취소 → 차감할 돈이 없다
    if (deducted.has(claimed.productOrderId)) continue; // 차감이 이미 왔다
    if (claimed.payDateKey < oldestClaimKey || claimed.payDateKey > todayKey) continue;
    counters.claimsAwaitingDeduction++;
    addDate(claimed.payDateKey, 'claim-without-deduction', claimed.productOrderId);
  }

  const dates: PendingDateEntry[] = [...reasonsByDate.entries()]
    .map(([dateKey, reasons]) => ({
      dateKey,
      reasons: [...reasons].sort(),
      pendingOrders: ordersByDate.get(dateKey)?.size ?? 0,
    }))
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));

  return { dates, estimatedCalls: dates.length, counters };
}

/** 차감을 만들 수 있는 클레임. 교환은 정산 차감 행을 만들지 않으므로 재진입 대상이 아니다. */
const DEDUCTIBLE_CLAIM_TYPES = new Set(['CANCEL', 'RETURN']);

export interface SettlementQueryPlanLoad {
  plan: SettlementQueryPlan;
  /**
   * `claimSource` 프로젝션을 읽지 못한 스냅샷 날짜(레거시 행·`{v:0}` 마커·버전 불일치).
   * 그 날짜는 **취소 재진입을 판정할 수 없다** — 조용히 "취소 없음"으로 넘기지 않고 드러낸다
   * (P0 No Silent Failure). 정상 운영에서는 빈 배열이다.
   */
  claimSourceUnavailableDates: string[];
}

/**
 * DB 만 읽어 이번 회차의 조회 계획을 만든다 — **네이버 호출 0회**.
 *
 * 그래서 `?dryRun=1` 이 공짜로 검증된다 — 종전 구조는 "제대로 도는지" 확인하는 것 자체가
 * 한 회차치 호출을 통째로 쓰는 일이라 검증이 곧 한도 소모였다.
 *
 * ⚠️ `orders` 블롭은 읽지 않는다 — 취소 판정은 `claimSource` 프로젝션만 쓴다(P7 *Snapshot
 * Blob Egress Discipline*: 조회당 1.5~5.2MB 를 read-path 에 싣지 않는다).
 */
export async function loadSettlementQueryPlan(nowMs: number = Date.now()): Promise<SettlementQueryPlanLoad> {
  const todayKey = toKstDateKey(nowMs);
  const oldestPendingKey = addKstDays(todayKey, -SETTLEMENT_PENDING_MAX_AGE_DAYS);
  const oldestClaimKey = addKstDays(todayKey, -SETTLEMENT_CLAIM_LOOKBACK_DAYS);

  const [caseRows, snapshotRows, claimRows] = await Promise.all([
    // 원장은 클레임 창까지 읽는다 — 재진입 판정이 "원거래가 정산됐는가"(`settledOriginals`)와
    // "차감이 이미 왔는가"(`deducted`)를 보는데, 그 근거 행은 대기 창(10일)보다 오래됐다.
    prisma.naverSettlementCase.findMany({
      where: { payDate: { gte: new Date(kstDayStartMs(oldestClaimKey)) } },
      select: { productOrderId: true, settleType: true, payDate: true, settled: true },
    }),
    naverOrderSnapshotRepository.findRangeCounts(oldestPendingKey, todayKey),
    naverOrderSnapshotRepository.findRangeClaimSources(oldestClaimKey, todayKey),
  ]);

  const claimedOrders: ClaimedOrderRow[] = [];
  const claimSourceUnavailableDates: string[] = [];
  for (const row of claimRows) {
    const projected = parseSnapshotClaimSource(row.claimSource);
    if (projected === null) {
      claimSourceUnavailableDates.push(row.snapshotDate);
      continue;
    }
    for (const order of projected) {
      const productOrderId = order?.productOrderId != null ? String(order.productOrderId) : '';
      if (!productOrderId) continue;
      // 완료 여부로 거르지 않는다 — 반품이 진행 중이어도 차감은 그 뒤에 오고, 우리가 알고
      // 싶은 것은 "언젠가 차감이 올 주문인가"다. 종료 조건은 차감 행 도착이지 클레임 상태가
      // 아니다(상태로 거르면 완료 전이를 놓친 회차가 그대로 누락으로 굳는다).
      const deductible = deriveClaimsFromOrder(order).some((claim) => DEDUCTIBLE_CLAIM_TYPES.has(claim.claimType));
      if (deductible) claimedOrders.push({ productOrderId, payDateKey: row.snapshotDate });
    }
  }

  const plan = decideSettlementQueryPlan({
    todayKey,
    cases: caseRows,
    claimedOrders,
    snapshots: snapshotRows,
  });

  return { plan, claimSourceUnavailableDates };
}

/** 한 줄 로그·응답용 요약. 날짜가 많아도 줄이 터지지 않게 앞 12개만 적는다. */
export function formatSettlementQueryPlan(plan: SettlementQueryPlan): string {
  const shown = plan.dates.slice(0, 12).map((d) => d.dateKey);
  const more = plan.dates.length > shown.length ? `+${plan.dates.length - shown.length}` : '';
  const c = plan.counters;
  return (
    `calls=${plan.estimatedCalls} dates=[${shown.join(',')}${more}] ` +
    `pending=${c.pendingUnsettledOrders} noLedger=${c.datesWithoutLedger} claims=${c.claimsAwaitingDeduction} ` +
    `dropped(settled=${c.droppedBySettled},claim=${c.droppedByClaim},age=${c.droppedByAge})`
  );
}
