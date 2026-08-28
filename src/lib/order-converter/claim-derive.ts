import { computeSimilarityScore } from './similarity';

/**
 * B2 반품/교환 파생 모듈 — 순수 함수만 포함(유닛테스트 대상).
 *
 * naver-order-sync.ts의 normalizeQueriedOrder가 붙이는 `__claim` 원본
 * ({cancel, return, exchange, beforeClaim, currentClaim, completedClaims})에서
 * UI/알림이 쓸 수 있는 평평한 DerivedClaim[]을 파생한다. 별도 테이블 없이
 * derive-on-read 방식이라, 여기서 실패해도 절대 throw하지 않고 빈 배열 + raw
 * 보존으로 폴백한다(R3: __claim leaf 필드가 실응답 미확정).
 *
 * TODO(R3): 실 반품 1건 __claim JSON 덤프로 claimStatus enum·수거택배사·송장 필드명을
 * 확정한 뒤, 아래 방어적 옵셔널 체이닝 후보 경로들을 실제 필드 하나로 좁힐 것.
 */

export type ClaimType = 'RETURN' | 'EXCHANGE' | 'CANCEL';

export interface DerivedClaim {
  productOrderId: string;
  claimType: ClaimType;
  claimStatus: string | null;
  claimStatusLabel: string;
  collectDeliveryCompanyCode: string | null;
  collectDeliveryInvoiceNo: string | null;
  productName: string | null;
  productOption: string | null;
  /** 네이버 상품ID(원상품/채널상품) — 캠페인 귀속의 1차 키. 스냅샷 order.productId에서 채움. */
  productId: string | null;
  quantity: number | null;
  requestDate: string | null;
  isCompleted: boolean;
  matchedCampaignName?: string | null;
  raw: any;
}

/**
 * 캠페인 경량 매칭 후보. 상품명 fuzzy가 아니라 productId + 판매기간으로 귀속하기 위해
 * 서버(campaigns route)와 동일한 신뢰 키(productId)를 claim-derive까지 내려보낸다.
 */
export interface CampaignMatchInfo {
  name: string;
  productId?: string | null;
  startDate?: string | Date | null;
  endDate?: string | Date | null;
}

// claimStatus 한글 라벨 매핑. 실응답에서 관측되는 대로 계속 채워나간다(TODO R3).
const CLAIM_STATUS_LABELS: Record<string, string> = {
  RETURN_REQUEST: '반품 요청',
  RETURNING: '반품 수거중',
  RETURN_DONE: '반품 완료',
  COLLECT_DONE: '수거 완료',
  COLLECTING: '수거중',
  EXCHANGE_REQUEST: '교환 요청',
  EXCHANGING: '교환 처리중',
  EXCHANGE_DONE: '교환 완료',
  CANCEL_REQUEST: '취소 요청',
  CANCEL_DONE: '취소 완료',
};

// 종단(완료) 상태로 취급할 claimStatus 후보 — 알림 트리거·접힘 UI 판단에 사용.
const COMPLETED_STATUS_KEYWORDS = ['DONE', 'COMPLETE', 'COMPLETED'];
const COLLECTED_STATUS_KEYWORDS = ['COLLECT_DONE', 'COLLECTING_DONE', 'COLLECTED'];

function labelForStatus(status: string | null): string {
  if (!status) return '상태 미확인';
  return CLAIM_STATUS_LABELS[status] ?? status;
}

function isCompletedStatus(status: string | null): boolean {
  if (!status) return false;
  return COMPLETED_STATUS_KEYWORDS.some((kw) => status.includes(kw));
}

/**
 * claim 원본 객체(return/exchange/cancel 중 하나) + currentClaim/completedClaim에서
 * 여러 후보 경로로 필드를 방어적으로 추출한다. 네이버 실응답 필드명이 미확정이므로
 * `??` 체이닝으로 다수 후보를 순서대로 시도한다.
 */
function extractCollectCompanyCode(claimObj: any): string | null {
  return (
    claimObj?.collectDeliveryCompany ??
    claimObj?.returnDeliveryCompany ??
    claimObj?.collectDeliveryCompanyCode ??
    claimObj?.deliveryCompany ??
    claimObj?.collectDeliveryCompanyName ??
    null
  );
}

function extractCollectInvoiceNo(claimObj: any): string | null {
  return (
    claimObj?.collectDeliveryInvoiceNo ??
    claimObj?.returnDeliveryInvoiceNo ??
    claimObj?.collectInvoiceNo ??
    claimObj?.invoiceNo ??
    claimObj?.trackingNumber ??
    null
  );
}

function extractClaimStatus(claimObj: any, currentClaim: any): string | null {
  return (
    claimObj?.claimStatus ??
    claimObj?.status ??
    currentClaim?.claimStatus ??
    currentClaim?.status ??
    null
  );
}

function extractRequestDate(claimObj: any, currentClaim: any): string | null {
  return (
    claimObj?.claimRequestDate ??
    claimObj?.requestDate ??
    claimObj?.createdDate ??
    currentClaim?.claimRequestDate ??
    currentClaim?.requestDate ??
    null
  );
}

function extractQuantity(claimObj: any, order: any): number | null {
  const raw = claimObj?.claimQuantity ?? claimObj?.quantity ?? order?.quantity ?? null;
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

interface ClaimSourceEntry {
  claimType: ClaimType;
  claimObj: any;
}

/**
 * order.__claim에서 이 주문에 존재하는 클레임 소스들을 모은다.
 * return/exchange/cancel 중 값이 있는 것들 + completedClaims 배열(과거 완료건)을 모두 포함한다.
 * currentClaim은 claimType 판별의 보조 힌트로만 쓰고, 실제 claimType은 어느 키에
 * 값이 들었는지로 우선 판별한다(currentClaim.claimType이 있으면 그것도 참고).
 */
function collectClaimSources(claimBag: any): ClaimSourceEntry[] {
  const sources: ClaimSourceEntry[] = [];
  if (!claimBag) return sources;

  // 이미 파생한 claimType 집합. 네이버가 하나의 완료 클레임을 터미널 키(cancel/return/exchange)와
  // completedClaims[] 양쪽에 동시에 실어, 같은 취소가 2행으로 파생되던 이중카운트 버그(실측: 65/66
  // 주문에서 겹침)를 이 집합으로 막는다. 한 주문의 서로 다른 claimType은 그대로 각각 파생한다.
  const coveredTypes = new Set<ClaimType>();
  const pushSource = (claimType: ClaimType, claimObj: any) => {
    sources.push({ claimType, claimObj });
    coveredTypes.add(claimType);
  };

  if (claimBag.return) pushSource('RETURN', claimBag.return);
  if (claimBag.exchange) pushSource('EXCHANGE', claimBag.exchange);
  if (claimBag.cancel) pushSource('CANCEL', claimBag.cancel);

  // currentClaim이 위 세 키 어디에도 안 담겨 있는 형태(예: claimType 필드만 있는 평평한 객체)로
  // 올 가능성에 대비해 방어적으로 currentClaim.claimType을 보고 별도 소스로 추가한다.
  const currentClaimType = claimBag.currentClaim?.claimType;
  if (
    currentClaimType &&
    ['RETURN', 'EXCHANGE', 'CANCEL'].includes(currentClaimType) &&
    !coveredTypes.has(currentClaimType)
  ) {
    pushSource(currentClaimType, claimBag.currentClaim);
  }

  // completedClaims: 배열 형태로 과거 완료 클레임들이 온다고 가정(방어적으로 배열 체크).
  // 같은 claimType이 이미 터미널 키/currentClaim/앞선 완료건으로 잡혔으면 중복 파생하지 않는다.
  if (Array.isArray(claimBag.completedClaims)) {
    for (const completed of claimBag.completedClaims) {
      const ct = completed?.claimType;
      if (ct && ['RETURN', 'EXCHANGE', 'CANCEL'].includes(ct) && !coveredTypes.has(ct)) {
        pushSource(ct, completed);
      }
    }
  }

  return sources;
}

/**
 * 평평한 주문 객체(order.__claim 보유) 한 건에서 DerivedClaim[]을 파생한다.
 * __claim이 없거나 이상 형태라도 throw하지 않고 빈 배열을 반환한다.
 */
export function deriveClaimsFromOrder(order: any): DerivedClaim[] {
  try {
    const productOrderId = order?.productOrderId ? String(order.productOrderId) : null;
    if (!productOrderId) return [];

    const claimBag = order?.__claim;
    if (!claimBag || typeof claimBag !== 'object') return [];

    const sources = collectClaimSources(claimBag);
    if (sources.length === 0) return [];

    const derived: DerivedClaim[] = sources.map(({ claimType, claimObj }) => {
      const claimStatus = extractClaimStatus(claimObj, claimBag.currentClaim);
      return {
        productOrderId,
        claimType,
        claimStatus,
        claimStatusLabel: labelForStatus(claimStatus),
        collectDeliveryCompanyCode: extractCollectCompanyCode(claimObj),
        collectDeliveryInvoiceNo: extractCollectInvoiceNo(claimObj),
        productName: order?.productName ?? null,
        productOption: order?.productOption ?? null,
        productId: order?.productId != null ? String(order.productId) : null,
        quantity: extractQuantity(claimObj, order),
        requestDate: extractRequestDate(claimObj, claimBag.currentClaim),
        isCompleted: isCompletedStatus(claimStatus),
        raw: claimObj,
      };
    });

    return derived;
  } catch (err) {
    console.warn('[claim-derive] deriveClaimsFromOrder 실패 — 빈 배열로 폴백:', err, { productOrderId: order?.productOrderId });
    return [];
  }
}

/**
 * 스냅샷 orders 전체에서 DerivedClaim[]을 파생하고, 선택적으로 캠페인 후보와
 * 매칭(matchedCampaignName)을 붙인다. 후보가 없으면 매칭을 건너뛴다.
 *
 * 후보는 두 형태를 받는다:
 *  - CampaignMatchInfo[] (권장): productId + 판매기간으로 서버(campaigns route)와 동일하게
 *    귀속한다. 상품명 fuzzy는 productId가 없는 캠페인/주문에 대한 폴백으로만 쓴다.
 *  - string[] (레거시): 상품명 유사도 매칭만. 하위호환용.
 *
 * 캠페인 귀속은 주문 단위로 1회 계산해 그 주문의 모든 클레임에 동일하게 부여한다
 * (한 주문의 취소·반품·교환은 같은 캠페인 소속).
 */
export function deriveClaims(
  orders: any[],
  campaigns?: string[] | CampaignMatchInfo[],
): DerivedClaim[] {
  if (!Array.isArray(orders)) return [];

  const candidates = normalizeCampaignCandidates(campaigns);

  const results: DerivedClaim[] = [];
  for (const order of orders) {
    const claims = deriveClaimsFromOrder(order);
    if (claims.length === 0) continue;

    const matchedName =
      candidates.length > 0 ? resolveOrderCampaignName(order, candidates) : undefined;

    for (const claim of claims) {
      if (matchedName !== undefined) claim.matchedCampaignName = matchedName;
      results.push(claim);
    }
  }
  return results;
}

/** string[] | CampaignMatchInfo[] 를 내부 표준형(CampaignMatchInfo[])으로 정규화한다. */
function normalizeCampaignCandidates(
  campaigns?: string[] | CampaignMatchInfo[],
): CampaignMatchInfo[] {
  if (!Array.isArray(campaigns) || campaigns.length === 0) return [];
  if (typeof campaigns[0] === 'string') {
    return (campaigns as string[]).filter(Boolean).map((name) => ({ name }));
  }
  return (campaigns as CampaignMatchInfo[]).filter((c) => c && c.name);
}

/**
 * 주문 한 건을 캠페인에 귀속시킨다. 우선순위:
 *  1) productId 완전일치 + 주문일이 캠페인 판매기간 내 (서버 집계와 동일 신뢰키)
 *  2) 1)의 productId 일치 후보가 기간 밖뿐이면 기간 무시하고 productId 일치로 폴백
 *  3) productId 없는 캠페인/주문은 상품명 포함(containment)·유사도로 폴백
 * 동일 productId 후보가 여러 개(회차·복수 셀러 등)면 상품명 유사도로 tie-break한다.
 *
 * 신뢰키 주의: 캠페인의 productId는 네이버 **원상품번호(originalProductId)**로 저장되는데,
 * 주문 스냅샷의 1차 필드 `productId`는 **채널상품번호**라 서로 다르다(실측: 캠페인
 * 13583224998 = 주문 originalProductId, 주문 productId는 13643025431). 그래서 주문 쪽은
 * `productId`와 `originalProductId`를 **둘 다** 후보키로 삼아 비교한다. 이 비대칭을 놓치면
 * 클레임이 전량 미매칭으로 빠진다(카드는 상품명 매칭이라 정상 귀속돼 화면 간 수치가 어긋났다).
 */
function resolveOrderCampaignName(order: any, campaigns: CampaignMatchInfo[]): string | null {
  const orderPids = [order?.productId, order?.originalProductId]
    .filter((v) => v != null)
    .map((v) => String(v));
  const pName: string = order?.productName || '';
  const timeStr = order?.paymentDate || order?.orderDate || order?.orderCreateDate;
  const orderTime = timeStr ? new Date(timeStr).getTime() : 0;

  const inPeriod = (c: CampaignMatchInfo): boolean => {
    if (!orderTime) return true; // 주문일 미상이면 기간으로 배제하지 않는다
    const start = c.startDate ? new Date(c.startDate).getTime() : 0;
    const end = c.endDate ? new Date(c.endDate).getTime() : Number.MAX_SAFE_INTEGER;
    return orderTime >= start && orderTime <= end;
  };

  // 1·2) productId 기반 귀속 — 주문의 채널·원상품번호 어느 쪽이든 캠페인 productId와 맞으면 매칭.
  if (orderPids.length > 0) {
    const pidMatches = campaigns.filter((c) => c.productId && orderPids.includes(String(c.productId)));
    if (pidMatches.length > 0) {
      const inWindow = pidMatches.filter(inPeriod);
      const pool = inWindow.length > 0 ? inWindow : pidMatches;
      if (pool.length === 1) return pool[0].name;
      return pickBestByName(pName, pool) ?? pool[0].name;
    }
  }

  // 3) 상품명 폴백 — productId가 없는 캠페인/주문에만 적용(오귀속 축소).
  //    서버 route.ts와 동일하게 이름 포함을 우선하고, 없으면 유사도 임계값으로 tie-break.
  const nameCandidates = campaigns.filter((c) => !c.productId || orderPids.length === 0);
  if (nameCandidates.length === 0 || !pName) return null;

  const contained = nameCandidates.filter(
    (c) => c.name && (pName.includes(c.name) || c.name.includes(pName)),
  );
  const inWindowContained = contained.filter(inPeriod);
  const containedPool = inWindowContained.length > 0 ? inWindowContained : contained;
  if (containedPool.length > 0) {
    return pickBestByName(pName, containedPool) ?? containedPool[0].name;
  }

  return pickBestByName(pName, nameCandidates.filter(inPeriod).length > 0 ? nameCandidates.filter(inPeriod) : nameCandidates);
}

/**
 * 후보군 안에서 상품명과 유사도가 가장 높은 캠페인명을 고른다(임계값 미만이면 null).
 * 전역 매칭이 아니라 이미 좁혀진 후보(같은 productId 또는 이름 포함군) 안의 tie-break·폴백 용도.
 */
const CAMPAIGN_MATCH_THRESHOLD = 0.4;

function pickBestByName(productName: string, candidates: CampaignMatchInfo[]): string | null {
  if (!productName) return null;
  let best: { name: string; score: number } | null = null;
  for (const c of candidates) {
    const score = computeSimilarityScore(productName, c.name);
    if (!best || score > best.score) best = { name: c.name, score };
  }
  if (best && best.score >= CAMPAIGN_MATCH_THRESHOLD) return best.name;
  return null;
}

// ============================================================================
// 스냅샷 claimSource — write-path 파생 프로젝션 (egress 절감, 2026-07-21 · P7)
//
// claims 라우트가 30일 orders 블롭 전량(회당 3.94MB 실측)을 읽어 read-path 파생하던
// 것을, 동기화 쓰기 시점에 "클레임 보유 주문의 최소 프로젝션"으로 축약해
// NaverOrderSnapshot.claimSource 컬럼에 저장한다(dailyAggregate와 동일 계약).
//
// 파생 결과(DerivedClaim[])가 아니라 소스 프로젝션을 저장하는 이유: 캠페인 귀속
// (matchedCampaignName)은 살아있는 캠페인 목록에 의존하므로 쓰기 시점에 얼리면
// 낡는다. 읽기가 이 프로젝션에 동일 SSOT(deriveClaims)를 그대로 돌리므로 블롭
// 파생과의 동치성이 구조적으로 보장된다(회귀 테스트가 대조 고정).
//
// 프로젝션 필드는 deriveClaimsFromOrder + resolveOrderCampaignName이 소비하는
// 필드의 상위집합이어야 한다 — 여기서 필드를 빼면 저장 경로만 조용히 값이
// 달라지므로, 소비 필드를 추가할 때는 이 프로젝션에도 반드시 함께 추가한다.
// ============================================================================

export const SNAPSHOT_CLAIM_SOURCE_VERSION = 1;

/** 계산 실패 명시 마커 — null(레거시)과 구분되는 "시도했으나 실패". 읽기는 블롭 폴백. */
export const SNAPSHOT_CLAIM_SOURCE_UNAVAILABLE = { v: 0 } as const;

/** 클레임 파생·캠페인 귀속에 필요한 주문 필드만 남긴 최소 프로젝션. */
export interface ClaimSourceOrder {
  productOrderId: unknown;
  productName?: unknown;
  productOption?: unknown;
  productId?: unknown;
  originalProductId?: unknown;
  quantity?: unknown;
  paymentDate?: unknown;
  orderDate?: unknown;
  orderCreateDate?: unknown;
  __claim: unknown;
}

export interface SnapshotClaimSource {
  v: number;
  orders: ClaimSourceOrder[];
}

/**
 * 스냅샷 주문 배열에서 클레임 보유 주문만 골라 최소 프로젝션으로 축약한다.
 * 필터 기준은 deriveClaimsFromOrder의 조기반환 조건과 정확히 일치한다
 * (productOrderId 없음·__claim 없음·클레임 소스 0건은 어차피 빈 파생) —
 * 그래서 프로젝션 입력과 블롭 입력의 deriveClaims 결과가 같다.
 */
export function extractClaimSourceOrders(orders: any[]): ClaimSourceOrder[] {
  if (!Array.isArray(orders)) return [];
  const projected: ClaimSourceOrder[] = [];
  for (const order of orders) {
    if (!order?.productOrderId) continue;
    const claimBag = order?.__claim;
    if (!claimBag || typeof claimBag !== 'object') continue;
    if (collectClaimSources(claimBag).length === 0) continue;
    projected.push({
      productOrderId: order.productOrderId,
      productName: order.productName,
      productOption: order.productOption,
      productId: order.productId,
      originalProductId: order.originalProductId,
      quantity: order.quantity,
      paymentDate: order.paymentDate,
      orderDate: order.orderDate,
      orderCreateDate: order.orderCreateDate,
      __claim: claimBag,
    });
  }
  return projected;
}

/** 저장용 값 조립 — 버전 봉투를 씌운다(파싱 시 버전 불일치는 블롭 폴백 신호). */
export function computeSnapshotClaimSource(orders: any[]): SnapshotClaimSource {
  return { v: SNAPSHOT_CLAIM_SOURCE_VERSION, orders: extractClaimSourceOrders(orders) };
}

/**
 * 저장된 claimSource 값을 프로젝션 배열로 해석한다. 다음은 전부 null(=이 행만
 * 블롭 폴백)로 강등한다: null(레거시 행)·{v:0} 마커·버전 불일치·형태 불량·파싱 실패.
 * SQLite는 문자열(JSON 텍스트)로 저장되므로 문자열이면 파싱한다(orders 컬럼과 동일 규칙).
 */
export function parseSnapshotClaimSource(value: unknown): ClaimSourceOrder[] | null {
  if (value == null) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    if ((parsed as any).v !== SNAPSHOT_CLAIM_SOURCE_VERSION) return null;
    const orders = (parsed as any).orders;
    return Array.isArray(orders) ? orders : null;
  } catch {
    return null;
  }
}

/**
 * 알림 전이 감지용 키. 동일 productOrderId+claimType+claimStatus 조합이면 같은 "전이"로 본다.
 * (Notification.entityId를 productOrderId로, type을 전이 종류로 써서 중복 방지에 사용)
 */
export function claimTransitionKey(c: DerivedClaim): string {
  return `${c.productOrderId}:${c.claimType}:${c.claimStatus ?? 'UNKNOWN'}`;
}

/** 종단 상태(수거완료) 여부 — 네이버 클레임 상태 도메인 술어 */
export function isCollectedStatus(status: string | null): boolean {
  if (!status) return false;
  return COLLECTED_STATUS_KEYWORDS.some((kw) => status.includes(kw));
}

/** 종단 상태(반품/교환 완료) 여부 — 네이버 클레임 상태 도메인 술어 */
export function isFinalCompletedStatus(status: string | null): boolean {
  return isCompletedStatus(status);
}

// ============================================================================
// 택배 추적 딥링크 (claim-list.tsx가 사용)
// ============================================================================

/** 택배사 코드 → 추적 URL 템플릿. {inv}를 송장번호로 치환한다. 미매핑 코드는 null. */
export const DELIVERY_TRACKING_URL_TEMPLATES: Record<string, string> = {
  CJGLS: 'https://trace.cjlogistics.com/next/tracking.html?wblNo={inv}',
  HANJIN: 'https://www.hanjin.com/kor/CMS/DeliveryMgr/WaybillResult.do?mCode=MN038&schLang=KR&wblnumText2={inv}',
  HYUNDAI: 'https://www.lotteglogis.com/home/reservation/tracking/linkView?InvNo={inv}',
  KGB: 'https://www.ilogen.com/web/personal/trace/{inv}',
  EPOST: 'https://service.epost.go.kr/trace.RetrieveDomRigiTraceList.comm?sid1={inv}',
  KDEXP: 'https://kdexp.com/service/delivery/etc/delivery.do?barcode={inv}',
};

/**
 * 택배사 코드 + 송장번호로 추적 딥링크 URL을 만든다. 코드가 미매핑이거나 송장번호가
 * 없으면 null(호출부는 버튼 비활성 + 툴팁으로 처리).
 */
export function buildTrackingUrl(companyCode: string | null | undefined, invoiceNo: string | null | undefined): string | null {
  if (!companyCode || !invoiceNo) return null;
  const template = DELIVERY_TRACKING_URL_TEMPLATES[companyCode];
  if (!template) return null;
  return template.replace('{inv}', encodeURIComponent(invoiceNo));
}
