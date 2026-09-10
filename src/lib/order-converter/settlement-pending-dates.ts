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

/**
 * 클레임 창 **밖**까지 얼마나 더 읽어 관측만 할 것인가(일).
 *
 * 조회 계획은 `SETTLEMENT_CLAIM_LOOKBACK_DAYS` 안에서만 만들지만, 그 창을 **넘어가 버린**
 * 클레임(차감이 끝내 안 온 건)은 창 밖이라 읽지 않으면 존재조차 못 센다 — 창 이탈 카운터가
 * 구조적으로 영원히 0 이 된다(교차 검증이 모킹으로 확인). 여기만큼 더 읽어 그 이탈을
 * **관측**한다. 네이버 호출과 무관한 DB 읽기다.
 */
export const SETTLEMENT_CLAIM_OBSERVE_MARGIN_DAYS = 30;

/**
 * 한 회차에 부를 날짜의 상한.
 *
 * 세 경로의 날짜가 겹치지 않고 쌓이면 계획이 이론상 클레임 창(60일)만큼 커질 수 있다 —
 * 원거래는 정산됐는데 차감이 끝내 안 오는 주문이 서로 다른 결제일에 흩어지는 경우다. 그러면
 * **줄이려던 호출량을 오히려 넘긴다.** 상한을 두되, 잘린 날짜는 조용히 버리지 않고
 * `counters.truncatedDates` 로 신고한다(P7 이 같은 상황에 정한 규약 — 상한에 걸리면
 * 삼키지 않고 고지한다).
 *
 * **우선순위는 오래된 날짜다.** 오래된 쪽이 상한(§`MAX_AGE`)에 먼저 닿아 기회가 적고,
 * 최근 날짜는 어차피 다음 회차의 재확인 창에 다시 들어온다.
 */
export const SETTLEMENT_MAX_DATES_PER_RUN = 12;

/**
 * 주문이 있었던 날을 무조건 다시 보는 **횟수**(= 결제일 당일 포함 연속 일수).
 *
 * 정산 원장 행이 **결제 직후 한꺼번에 생지 않을 수 있다**는 것이 이 상수의 존재 이유다.
 * 늦게 생긴 행은 우리가 가진 `cases` 에 없어 대기 판정으로는 절대 발견되지 않으므로, 주문이
 * 있던 날짜를 **정해진 횟수만큼** 다시 물어 그 창을 닫는다. 창 이탈 조건이 `todayKey` 의
 * 단조 증가에만 의존하고 데이터 상태와 무관해 **수렴이 자명하다.**
 *
 * ⚠️ **이 값은 실측에서 도출한 것이 아니다 — 고른 값이다.** 우리가 가진 실측은 결제→정산
 * *완료* 지연 분포(설계 정본 §0-3②)이고, 이 상수가 막으려는 것은 **원장 행 *생성* 지연**
 * 이라 축이 다르다. 그 분포는 아직 관측되지 않았다.
 * ⛔ 다음 세션이 이 주석을 근거로 재도출을 건너뛰지 말 것.
 *
 * 🪤 **이 값은 「늦게 생긴 원장」의 복구 창을 정한다.** 종전 초안(개수 대조)은 그 복구가
 * `SETTLEMENT_PENDING_MAX_AGE_DAYS` 까지 살아 있었으므로, 여기로 바꾸면서 복구 창이 그만큼
 * **좁아졌다** — 대신 그 초안은 판정 근거가 무효였다(모수가 다른 두 수의 대조). 좁힌 것이
 * 실제로 무언가를 놓치는지는 `counters.ledgerShortDates` 추세로 관측한다.
 *
 * ⛔ 값을 늘려 「안전」을 사는 것은 곧 상시 호출량이다 — 캠페인이 도는 동안 주문이 있는
 * 날짜마다 이 횟수가 그대로 붙는다.
 */
export const SETTLEMENT_ORDER_DATE_RECHECK_DAYS = 4;

/** 이 날짜를 부르는 이유. 한 날짜에 여러 이유가 겹칠 수 있다. */
export type PendingDateReason =
  /** 정산완료 행이 아직 없는 주문의 결제일. 완료 행이 생기면 자동으로 빠진다. */
  | 'unsettled-order'
  /**
   * 주문이 있었던 **최근 결제일** — 결제 후 `SETTLEMENT_ORDER_DATE_RECHECK_DAYS` 동안은
   * 대기 주문이 없어 보여도 한 번씩 다시 본다.
   *
   * 정산 원장 행은 결제 직후 한꺼번에 생기지 않을 수 있고, 늦게 생긴 행은 우리 `cases` 에
   * 없으므로 `unsettled-order`(이미 받아 둔 행에서 출발한다)로는 영영 안 잡힌다 — 라벨이
   * 아니라 **행 자체가 빈다.** 크론이 며칠 멈춘 구간도 같은 경로로 메워진다.
   *
   * ⛔ 이것을 「스냅샷 주문 수 vs 원장 수」 대조로 바꾸지 말 것 — 두 수는 같은 술어로 센 값이
   * 아니다(스냅샷은 결제일이 없으면 주문일로 폴백 귀속하고, 정산 원장은 애초에 케이스가
   * 생기는 주문만 담는다). `order-fetch-window.findChunkIntegrityIssues` 가 같은 대조를
   * **차단 근거로 쓰지 말라**고 명시하고 있고, 실측에서도 양방향으로 어긋났다.
   *
   * ⚠️ **복구 범위는 이 일수까지다.** 그보다 긴 중단(프록시 한도 소진·자격증명 만료 등)이
   * 나면 그 구간은 이 경로로 안 채워진다 — 그때는 크론의 **수동 백필 파라미터**
   * (`?settledDays=&unsettledDays=`)로 한 번 넓게 훑어야 한다. 전환(2단계) 이후에도 그 두
   * 파라미터를 지운다면 백필 경로가 함께 사라진다.
   */
  | 'recent-order-date'
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
  /**
   * 상품주문 원장인가. 같은 API 가 배송비(`DELIVERY`)·리뷰적립 등 **상품주문 아닌 원장**도
   * 돌려주므로(P7 · 조사 정본 §2-1) 주문 단위 판정에서는 걸러야 한다 — 안 거르면 배송비
   * 원장이 정산 완료된 것만으로 그 주문의 상품 결제까지 「정산 끝났다」로 읽힌다.
   * `recomputeClosedCampaignSettlements` 가 같은 이유로 같은 필터를 쓴다(미기재는 포함).
   */
  productOrderType: string | null;
  payDate: Date | null;
  /**
   * 정산 예정 금액(= 실입금). 차감 계열은 음수 흐름이라(조사 정본 §2-1) `settleType` 명명과
   * 독립된 **보조** 차감 신호로 쓴다 — 단독 판정 근거로 삼지 말 것(`isDeductionRow` 주석).
   */
  settleExpectAmount: number;
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
  /**
   * 관측 카운터.
   *
   * ⚠️ **`dropped*` 계열의 기준선은 읽기 창이 정한다** — `loadSettlementQueryPlan` 이 관측용
   * 으로 읽는 범위(`SETTLEMENT_CLAIM_LOOKBACK_DAYS` + `SETTLEMENT_CLAIM_OBSERVE_MARGIN_DAYS`)를
   * 넓히거나 좁히면 같은 데이터에서도 값이 계단식으로 움직인다. 추세를 볼 때 그 창이 그대로
   * 였는지 먼저 확인할 것 — 안 그러면 창을 넓힌 날의 점프를 「포기 건 급증」으로 오독한다.
   */
  counters: {
    /** 정산완료 행이 없어 대기 중인 주문 수. */
    pendingUnsettledOrders: number;
    /** 「주문이 있었던 최근 날」이라 다시 부르는 날짜 수. */
    datesRechecked: number;
    /** 차감 행을 기다리는 취소·반품 주문 수. */
    claimsAwaitingDeduction: number;
    /** 정산완료 행이 있어 대기에서 빠진 주문 수(종료①). */
    droppedBySettled: number;
    /** 취소·반품이라 대기에서 빠진 주문 수(종료②) — 차감 대기와는 다른 부류다. */
    droppedByClaim: number;
    /** 상한(`SETTLEMENT_PENDING_MAX_AGE_DAYS`)을 넘겨 포기한 **주문** 수(종료③). */
    droppedByAge: number;
    /**
     * 날짜가 **미래**라 건너뛴 건수(세 경로 합계).
     *
     * 🪤 정상 운영에서는 0 이다. 0 이 아니면 KST 날짜키를 만드는 어딘가가 하루 밀린 것이고,
     * 그때 이 카운터가 없으면 로그가 「할 일 없음」과 **완전히 같은 얼굴**이 된다.
     */
    droppedByFutureDate: number;
    /**
     * 원장이 그 날짜 키로 **하나도 안 잡힌 채** 재확인 창을 벗어난 날짜 수.
     *
     * ⚠️ 이 값도 `ledgerShortDates` 와 **같은 조인**(스냅샷 날짜키 ↔ 원장 `payDate`)에 기대므로
     * 단정이 아니라 신호다 — 그 날 주문이 전부 결제일 없이 주문일로 폴백 귀속됐다면 원장은
     * 영영 그 키에 안 잡힌다. 「백필이 필요할 수 있다」까지가 이 값이 말하는 전부다.
     */
    droppedByAgeDates: number;
    /** 차감이 끝내 안 온 채 클레임 창을 벗어난 주문 수 — 돈이 걸린 배제라 따로 센다. */
    droppedByClaimWindow: number;
    /**
     * 원거래가 정산되지 않아 차감 재진입 대상이 아닌 클레임 수(정상 종료).
     *
     * 🪤 이 값이 갑자기 커지면 `isDeductionRow` 가 원거래를 차감으로 오분류하고 있다는
     * 신호다 — 그러면 `claimsAwaitingDeduction=0` 이 「대기 없음」처럼 보인다.
     */
    claimsWithoutSettledOriginal: number;
    /**
     * 차감으로 분류돼 대기 후보에서 빠진 **행** 수(주문 수가 아니다 — 한 주문에 차감 행이
     * 여럿일 수 있다). 대기에서 빼는 경로에는 전부 카운터가 있어야 한다.
     */
    droppedByDeductionRows: number;
    /**
     * 상품주문 원장이 아니라 건너뛴 **행** 수.
     *
     * 🪤 이 값이 갑자기 전체 행 수에 가까워지면 네이버가 `productOrderType` 표기를 바꾼
     * 것이고, 그 순간 계획은 **아무 이유 없이 비어 보인다**(할 일 0 과 구분되지 않는다).
     */
    droppedByNonProductLedgerRows: number;
    /**
     * `payDate` 가 없어 **어느 날짜를 불러야 할지 알 수 없는** 미정산 주문 수.
     *
     * 결제일 기준 창이 안 돌려주는 결제대기 주문 등이 이 부류다(P7 *Product-Order Query
     * Paging* 의 구조적 원인 ①). 날짜 축 조회로는 원리적으로 닿을 수 없으므로 계획에
     * 넣지 않되, **조용히 버리지 않고 센다** — 이 값이 커지면 날짜 축 말고
     * `productOrderId` 단독 조회가 필요하다는 신호다.
     */
    unknownPayDateOrders: number;
    /**
     * 원장 수가 스냅샷 주문 수보다 적은 날짜 수 — **관측 전용이고 판정에 쓰지 않는다.**
     *
     * 두 수는 같은 술어로 센 값이 아니라(스냅샷은 결제일이 없으면 주문일로 폴백 귀속한다)
     * 정상 운영에서도 양방향으로 어긋난다. `order-fetch-window` 가 같은 대조를 관측 신호로만
     * 쓰라고 못박은 것과 같은 이유다. 추세를 보는 용도이지 「누락 건수」가 아니다.
     */
    ledgerShortDates: number;
    /**
     * 상한(`SETTLEMENT_MAX_DATES_PER_RUN`)에 걸려 이번 회차에서 잘린 날짜 수.
     * 0 이 아니면 계획이 상한에 눌린 것이고, 호출자는 이것을 **경고로 드러내야 한다.**
     */
    truncatedDates: number;
  };
}

/**
 * 이 행이 차감(취소) 계열인가.
 *
 * 판정을 **두 축**으로 한다: ①`settleType` 이름에 `CANCEL` 이 들어가거나 ②**정산이 끝난**
 * 행인데 금액이 음수거나.
 *
 * ②를 함께 보는 이유는 `settleType` 전체 목록이 이 레포에 확정 문서화돼 있지 않기 때문이다
 * (조사 정본은 "7종"이라고만 적는다). 이름만 보면 `CANCEL` 을 포함하지 않는 차감 계열이
 * 나타났을 때 차감이 도착해도 못 알아보고, 취소 재진입(§`claim-without-deduction`)이 클레임
 * 창이 끝날 때까지 매일 같은 날짜를 다시 부른다.
 *
 * ⚠️ **②에 `settled` 를 붙인 것이 이 술어의 안전장치다.** 「차감 계열은 음수 흐름」은 조사
 * 정본이 계열 단위로 적은 서술이지 `settleExpectAmount` 한 필드의 불변식으로 실증된 것은
 * 아니다(음수로 명시된 것은 수수료 필드들이다). 미정산 행까지 음수만으로 차감 취급하면
 * 수수료·혜택 구성 때문에 음수가 된 **원거래**가 대기 집합에서 빠질 수 있다.
 */
function isDeductionRow(row: SettlementCaseRow): boolean {
  if (row.settleType && row.settleType.toUpperCase().includes('CANCEL')) return true;
  // ⚠️ 음수 축은 **정산이 끝난 행에만** 건다. 미정산 행의 음수는 「차감이 도착했다」는 증거가
  // 아니고(수수료·혜택 구성에 따라 원거래도 음수가 될 수 있다), 그 상태로 차감 취급하면 그
  // 주문이 대기 집합에서 **조용히** 빠진다 — 이 모듈이 없애려던 바로 그 형태다.
  return row.settled && row.settleExpectAmount < 0;
}

/**
 * 상품주문 원장인가 — **정산 원장을 주문 단위로 다루는 모든 곳의 공용 술어**(SSOT).
 *
 * `settle/case` 는 배송비(`DELIVERY`)·리뷰적립 등 **상품주문이 아닌 원장**도 같은 응답에
 * 실어 보낸다(조사 정본 §2-1). 미기재(`null`)는 포함한다 — 조인 키 자체가 캠페인 귀속
 * 주문이라 상품주문으로 본다.
 *
 * ⛔ 이 판정을 호출부에서 다시 적지 말 것. 종전에는 `recomputeClosedCampaignSettlements`
 * 안에 인라인으로만 있었고, 이 모듈이 그것을 **문자 그대로 복사**하면서 사본이 둘이 됐다
 * (교차 검증 지적). 한쪽만 고쳐지는 것이 이 코드베이스의 반복 실패다.
 */
export function isProductOrderLedgerRow(row: { productOrderType: string | null }): boolean {
  return !row.productOrderType || row.productOrderType === 'PROD_ORDER';
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
  /** 결제일별로 원장을 받아 본 상품주문 수 — **관측 전용**이다(§`ledgerShortDates`). */
  const ledgerOrderIdsByDate = new Map<string, Set<string>>();
  /** 정산완료 행이 아직 없는 주문 → 그 결제일. */
  const unsettledCandidates = new Map<string, string>();
  /** 미정산인데 결제일을 모르는 주문. */
  const payDatelessOrders = new Set<string>();
  const claimedIds = new Set(claimedOrders.map((o) => o.productOrderId));

  const counters: SettlementQueryPlan['counters'] = {
    pendingUnsettledOrders: 0,
    datesRechecked: 0,
    claimsAwaitingDeduction: 0,
    droppedBySettled: 0,
    droppedByClaim: 0,
    droppedByAge: 0,
    droppedByFutureDate: 0,
    droppedByAgeDates: 0,
    droppedByClaimWindow: 0,
    claimsWithoutSettledOriginal: 0,
    droppedByDeductionRows: 0,
    droppedByNonProductLedgerRows: 0,
    unknownPayDateOrders: 0,
    ledgerShortDates: 0,
    truncatedDates: 0,
  };

  // ── 원장 한 패스 — 파생 집합을 전부 여기서 만든다(이중 순회·이중 계산 제거) ──
  for (const row of cases) {
    if (!isProductOrderLedgerRow(row)) {
      // 🪤 **여기가 가장 위험한 배제다.** 네이버가 상품 원장에 예상 밖 `productOrderType` 을
      // 붙이는 순간 전 행이 조용히 빠져 「대기 0」 이 된다 — 계획이 비는 것과 할 일이 없는
      // 것이 구분되지 않는다. 그래서 반드시 센다(P0 No Silent Failure).
      counters.droppedByNonProductLedgerRows++;
      continue;
    }

    const key = payDateKeyOf(row.payDate);
    if (key) {
      let ids = ledgerOrderIdsByDate.get(key);
      if (!ids) ledgerOrderIdsByDate.set(key, (ids = new Set()));
      ids.add(row.productOrderId);
    }

    if (isDeductionRow(row)) {
      deducted.add(row.productOrderId);
      counters.droppedByDeductionRows++;
      continue;
    }
    if (row.settled) {
      settledOriginals.add(row.productOrderId);
      continue;
    }
    if (!key) {
      // 결제일을 모르면 **어느 날짜를 불러야 할지도 모른다.** 날짜 축 조회로는 닿을 수 없어
      // 계획에 넣지 못하지만, 조용히 버리지 않고 센다.
      payDatelessOrders.add(row.productOrderId);
      continue;
    }
    unsettledCandidates.set(row.productOrderId, key);
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

  for (const productOrderId of payDatelessOrders) {
    // 이 카운터는 「날짜 축으로는 못 닿는 주문이 얼마나 되나」를 재는 신호다. 이미 다른 경로로
    // 끝난 주문을 빼지 않으면 종결 건이 영구 바닥으로 앉아 신호가 흐려진다.
    if (unsettledCandidates.has(productOrderId)) continue;
    if (settledOriginals.has(productOrderId) || deducted.has(productOrderId)) continue;
    if (claimedIds.has(productOrderId)) continue;
    counters.unknownPayDateOrders++;
  }

  // ── ① 정산완료 행이 없는 주문의 결제일 ────────────────────────────────────
  // 주문 단위로 접은 뒤 판정한다 — 행 단위로 세면 낡은 미정산 사본 하나가 이미 끝난 주문을
  // 되살린다(실측에서 남아 있던 미정산 행 대부분이 정확히 그 부류였다).
  for (const [productOrderId, dateKey] of unsettledCandidates) {
    if (settledOriginals.has(productOrderId)) {
      counters.droppedBySettled++;
      continue;
    }
    if (claimedIds.has(productOrderId)) {
      counters.droppedByClaim++;
      continue;
    }
    if (dateKey > todayKey) {
      counters.droppedByFutureDate++;
      continue;
    }
    if (dateKey < oldestPendingKey) {
      counters.droppedByAge++;
      continue;
    }
    counters.pendingUnsettledOrders++;
    addDate(dateKey, 'unsettled-order', productOrderId);
  }

  // ── ② 주문이 있었던 최근 날짜는 정해진 기간 동안 다시 본다 ─────────────────
  // 원장 행은 결제 직후 한꺼번에 생기지 않을 수 있다. 그 늦게 생긴 행은 `cases` 에 없으니
  // ①로도 안 잡힌다 — 그래서 **주문이 있었던 날은 결제 후 며칠간 무조건 재확인**한다.
  // ⛔ 「스냅샷 주문 수 vs 원장 수」로 판정하지 말 것 — 두 수는 같은 술어로 센 값이 아니고
  //    (`order-fetch-window.findChunkIntegrityIssues` 가 그 이유와 함께 **차단 근거 금지**를
  //    명시한다), 실측에서 양방향으로 어긋난다. 그 대조는 아래 `ledgerShortDates` 로 **관측만** 한다.
  // 당일 포함 정확히 `SETTLEMENT_ORDER_DATE_RECHECK_DAYS` 회가 되게 −(N−1) 이다.
  const oldestRecheckKey = addKstDays(todayKey, -(SETTLEMENT_ORDER_DATE_RECHECK_DAYS - 1));
  for (const snap of snapshots) {
    if (snap.ordersCount <= 0) continue;
    if (snap.snapshotDate > todayKey) {
      counters.droppedByFutureDate++;
      continue;
    }

    const ledgerCount = ledgerOrderIdsByDate.get(snap.snapshotDate)?.size ?? 0;
    if (ledgerCount < snap.ordersCount) counters.ledgerShortDates++; // 관측 전용 — 판정에 쓰지 않는다

    if (snap.snapshotDate < oldestRecheckKey) {
      if (ledgerCount === 0) counters.droppedByAgeDates++; // 원장을 한 번도 못 받은 채 창을 벗어난 날
      continue;
    }
    counters.datesRechecked++;
    addDate(snap.snapshotDate, 'recent-order-date');
  }

  // ── ③ 취소·반품인데 차감 행이 아직 없는 주문의 결제일 ─────────────────────
  for (const claimed of claimedOrders) {
    if (!settledOriginals.has(claimed.productOrderId)) {
      // 정산 전 취소 → 차감할 돈이 없다(정상 종료). 다만 **조용히 빼지는 않는다** —
      // `isDeductionRow` 가 원거래를 차감으로 오분류하면 `settledOriginals` 가 비고, 그러면
      // 그 주문의 클레임이 전부 여기로 빠져 `claimsAwaitingDeduction=0` 이 「대기 없음」과
      // 구분되지 않는다.
      counters.claimsWithoutSettledOriginal++;
      continue;
    }
    if (deducted.has(claimed.productOrderId)) continue; // 차감이 이미 왔다
    if (claimed.payDateKey > todayKey) {
      counters.droppedByFutureDate++;
      continue;
    }
    if (claimed.payDateKey < oldestClaimKey) {
      // 차감이 끝내 안 온 채 창을 벗어난 클레임 — **돈이 걸린 배제**라 신호를 남긴다.
      counters.droppedByClaimWindow++;
      continue;
    }
    counters.claimsAwaitingDeduction++;
    addDate(claimed.payDateKey, 'claim-without-deduction', claimed.productOrderId);
  }

  const allDates: PendingDateEntry[] = [...reasonsByDate.entries()]
    .map(([dateKey, reasons]) => ({
      dateKey,
      reasons: [...reasons].sort(),
      pendingOrders: ordersByDate.get(dateKey)?.size ?? 0,
    }))
    .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0));

  // 🪤 **상한을 그냥 「오래된 순 자르기」로 하면 최근 날짜가 굶는다.** 차감이 영영 안 오는
  // 클레임(예: 접수 후 철회된 반품)이 서로 다른 결제일 여러 곳에 남으면 그 옛 날짜가 매
  // 회차 상한을 가득 채우고, 옛 날짜는 하루에 하나씩만 창을 벗어나므로 포화가 재확인 창
  // (`SETTLEMENT_ORDER_DATE_RECHECK_DAYS`)보다 오래 간다 → 오늘 주문일이 그 창 밖으로 나가
  // **다시는 계획에 오르지 못한다**(원장을 못 받았으니 종료①로도 안 잡힌다).
  // 그래서 재확인 몫을 **먼저 확보**한 뒤 남은 자리를 오래된 날짜로 채운다. 재확인 날짜는
  // 정의상 `SETTLEMENT_ORDER_DATE_RECHECK_DAYS` 개를 넘지 않으므로 상한 안에 항상 들어간다.
  const recentDates = allDates.filter((d) => d.reasons.includes('recent-order-date'));
  const olderDates = allDates.filter((d) => !d.reasons.includes('recent-order-date'));
  const roomForOlder = Math.max(0, SETTLEMENT_MAX_DATES_PER_RUN - recentDates.length);
  const dates = [...recentDates, ...olderDates.slice(0, roomForOlder)].sort((a, b) =>
    a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0,
  );
  counters.truncatedDates = allDates.length - dates.length;

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
  // 계획은 클레임 창 안에서만 만들지만, **창을 벗어난 건을 세려면 그 밖까지 읽어야 한다** —
  // 안 읽으면 `droppedByClaimWindow` 가 구조적으로 영원히 0 이다(교차 검증 지적).
  const observeFromKey = addKstDays(oldestClaimKey, -SETTLEMENT_CLAIM_OBSERVE_MARGIN_DAYS);

  const [caseRows, snapshotRows, claimRows] = await Promise.all([
    // 원장은 클레임 창까지 읽는다 — 재진입 판정이 "원거래가 정산됐는가"(`settledOriginals`)와
    // "차감이 이미 왔는가"(`deducted`)를 보는데, 그 근거 행은 대기 창(10일)보다 오래됐다.
    // 🪤 `payDate: null` 행을 조건에서 빠뜨리지 말 것 — SQL 3치 논리상 `NULL >= x` 는 참이
    // 아니라서 그 행들이 **쿼리 단계에서 통째로 사라지고**, 판정기는 존재조차 모른 채
    // 「대기 0」을 보고한다(카운터도 안 붙는 유일한 배제 경로가 된다). 명시적으로 실어서
    // `counters.unknownPayDateOrders` 로 드러낸다.
    prisma.naverSettlementCase.findMany({
      where: { OR: [{ payDate: { gte: new Date(kstDayStartMs(observeFromKey)) } }, { payDate: null }] },
      select: {
        productOrderId: true,
        settleType: true,
        productOrderType: true,
        payDate: true,
        settleExpectAmount: true,
        settled: true,
      },
    }),
    naverOrderSnapshotRepository.findRangeCounts(oldestPendingKey, todayKey),
    naverOrderSnapshotRepository.findRangeClaimSources(observeFromKey, todayKey),
  ]);

  const claimedOrders: ClaimedOrderRow[] = [];
  const claimSourceUnavailableDates: string[] = [];
  for (const row of claimRows) {
    const projected = parseSnapshotClaimSource(row.claimSource);
    if (projected === null) {
      // ⚠️ **창 밖은 경고하지 않는다.** 관측용으로 넓게 읽은 구간(`observeFromKey` ~
      // `oldestClaimKey`)은 애초에 재진입 대상이 아니라, 거기서 판독 불가를 알려 봐야
      // 손 쓸 수 없는 경고가 매 회차 쌓여 **창 안쪽의 진짜 신호를 덮는다**(레거시 스냅샷은
      // `claimSource` 가 비어 있다). 경고는 판정에 실제로 쓰이는 범위에만 건다.
      if (row.snapshotDate >= oldestClaimKey) claimSourceUnavailableDates.push(row.snapshotDate);
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

/**
 * 로그 한 줄에 이름을 적을 날짜 수.
 *
 * ⛔ `SETTLEMENT_MAX_DATES_PER_RUN` 과 **같은 뜻이 아니다** — 이건 줄 길이 제한이고 저건
 * 조회 상한이다. 두 수가 우연히 같으면 `+N` 표기가 도달 불가가 되고, 나중에 상한만 올리면
 * 읽는 사람이 그 `+N` 을 「절단됨」으로 오독한다(절단은 `truncated=` 가 말한다).
 */
const PLAN_LOG_MAX_DATES = 8;

/** 한 줄 로그·응답용 요약. 날짜가 많아도 줄이 터지지 않게 앞부분만 적는다. */
export function formatSettlementQueryPlan(plan: SettlementQueryPlan): string {
  const shown = plan.dates.slice(0, PLAN_LOG_MAX_DATES).map((d) => d.dateKey);
  const more = plan.dates.length > shown.length ? `+${plan.dates.length - shown.length}` : '';
  const c = plan.counters;
  return (
    `calls=${plan.estimatedCalls} dates=[${shown.join(',')}${more}] ` +
    `pending=${c.pendingUnsettledOrders} recheck=${c.datesRechecked} claims=${c.claimsAwaitingDeduction} ` +
    `dropped(settled=${c.droppedBySettled},claim=${c.droppedByClaim},age=${c.droppedByAge},future=${c.droppedByFutureDate},ageDates=${c.droppedByAgeDates},` +
    `claimWindow=${c.droppedByClaimWindow},deductionRows=${c.droppedByDeductionRows},nonProductRows=${c.droppedByNonProductLedgerRows}) ` +
    `unknownPayDate=${c.unknownPayDateOrders} ledgerShort=${c.ledgerShortDates} ` +
    `claimsNoOriginal=${c.claimsWithoutSettledOriginal} truncated=${c.truncatedDates}`
  );
}
