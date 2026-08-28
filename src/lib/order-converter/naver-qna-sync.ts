import { apiRequest } from './naver-commerce-client';
import { prisma } from './prisma';

/**
 * 네이버 상품 문의(VOC) 수집 — SSOT: REVIEW_QNA_COLLECTION_PLAN.md (Phase 1)
 *
 * 공식 커머스 API 2종을 수집한다(리뷰 API는 공식 부재 — 계획서 §1):
 *  - 상품문의  GET /v1/contents/qnas       → ProductQna       (상품 단위, 주문 조인 없음)
 *  - 고객문의  GET /v1/pay-user/inquiries   → CustomerInquiry  (productOrderId 보유 = 캠페인 정밀 귀속)
 *
 * 실호출은 IP 화이트리스트라 prod 경유만 가능(로컬 불가 — 계획서 §1-6). apiRequest가
 * 토큰 캐시·429 백오프·프록시를 내장하므로 그대로 재사용한다. 순수 파싱·매칭 로직은
 * 이 파일 하단의 헬퍼로 고립해 테스트 가능하게 둔다(네트워크 비의존).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO 8601 date-time (contents/qnas 파라미터 형식). */
function toIsoDateTime(d: Date): string {
  return d.toISOString();
}

/** yyyy-MM-dd (pay-user/inquiries 파라미터 형식). */
function toYmd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────── 순수 파서(테스트 대상) ───────────────────────────

/** 네이버 상품문의(contents/qnas) 응답 element → ProductQna upsert 데이터. 결측은 방어적 처리. */
export function parseProductQna(raw: any): {
  questionId: string;
  productId: string;
  productName: string | null;
  question: string;
  answer: string | null;
  answered: boolean;
  writerMasked: string | null;
  createDate: Date;
} | null {
  const questionId = raw?.questionId != null ? String(raw.questionId).trim() : '';
  if (!questionId) return null;
  const productId = raw?.productId != null ? String(raw.productId).trim() : '';
  if (!productId) return null; // productId 없으면 딜 귀속 불가 — 스킵(계약: 상품문의는 상품 단위)
  const created = raw?.createDate ? new Date(raw.createDate) : null;
  if (!created || Number.isNaN(created.getTime())) return null;
  return {
    questionId,
    productId,
    productName: raw?.productName != null ? String(raw.productName) : null,
    question: raw?.question != null ? String(raw.question) : '',
    answer: raw?.answer != null ? String(raw.answer) : null,
    answered: !!raw?.answered,
    writerMasked: raw?.maskedWriterId != null ? String(raw.maskedWriterId) : null,
    createDate: created,
  };
}

/**
 * 네이버 고객문의(pay-user/inquiries) 응답 content → CustomerInquiry upsert 데이터.
 * customerId/customerName은 **의도적으로 버린다**(P0 PII — 계획서 D4). productOrderIdList는
 * 원본 콤마 문자열 그대로 보관(소비 시 split).
 */
export function parseCustomerInquiry(raw: any): {
  inquiryNo: string;
  category: string;
  title: string;
  content: string;
  answered: boolean;
  answerAt: Date | null;
  registeredAt: Date;
  orderId: string;
  productNo: string | null;
  productOrderIds: string;
  optionText: string | null;
} | null {
  const inquiryNo = raw?.inquiryNo != null ? String(raw.inquiryNo).trim() : '';
  if (!inquiryNo) return null;
  const registered = raw?.inquiryRegistrationDateTime ? new Date(raw.inquiryRegistrationDateTime) : null;
  if (!registered || Number.isNaN(registered.getTime())) return null;
  const answeredAt = raw?.answerRegistrationDateTime ? new Date(raw.answerRegistrationDateTime) : null;
  return {
    inquiryNo,
    category: raw?.category != null ? String(raw.category) : '기타',
    title: raw?.title != null ? String(raw.title) : '',
    content: raw?.inquiryContent != null ? String(raw.inquiryContent) : '',
    answered: !!raw?.answered,
    answerAt: answeredAt && !Number.isNaN(answeredAt.getTime()) ? answeredAt : null,
    registeredAt: registered,
    orderId: raw?.orderId != null ? String(raw.orderId) : '',
    productNo: raw?.productNo != null ? String(raw.productNo) : null,
    productOrderIds: raw?.productOrderIdList != null ? String(raw.productOrderIdList) : '',
    optionText: raw?.productOrderOption != null ? String(raw.productOrderOption) : null,
  };
}

/** 콤마 구분 productOrderIdList → 정규화된 상품주문번호 배열(공백/빈값 제거). */
export function splitProductOrderIds(list: string | null | undefined): string[] {
  if (!list) return [];
  return String(list)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ─────────────────────────── 수집(네트워크) ───────────────────────────

/** 상품문의 1창(기간) 전체 페이지 수집. size는 문서 상한 100. */
export async function fetchProductQnas(fromDate: Date, toDate: Date): Promise<any[]> {
  const all: any[] = [];
  const size = 100;
  let page = 1;
  for (;;) {
    const res = await apiRequest('GET', '/v1/contents/qnas', undefined, {
      fromDate: toIsoDateTime(fromDate),
      toDate: toIsoDateTime(toDate),
      page: String(page),
      size: String(size),
    });
    const body = res?.data ?? res ?? {};
    const items: any[] = body.contents || body.elements || [];
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    const totalPages = Number(body.totalPages);
    if (Number.isFinite(totalPages) ? page >= totalPages : items.length < size) break;
    page++;
    if (page > 100) break; // 안전 상한
  }
  return all;
}

/** 고객문의 1창(기간) 전체 페이지 수집. size는 문서 상한 200. */
export async function fetchCustomerInquiries(startDate: Date, endDate: Date): Promise<any[]> {
  const all: any[] = [];
  const size = 200;
  let page = 1;
  for (;;) {
    const res = await apiRequest('GET', '/v1/pay-user/inquiries', undefined, {
      startSearchDate: toYmd(startDate),
      endSearchDate: toYmd(endDate),
      page: String(page),
      size: String(size),
    });
    const body = res?.data ?? res ?? {};
    const items: any[] = body.content || body.contents || [];
    if (!Array.isArray(items) || items.length === 0) break;
    all.push(...items);
    const last = body.last;
    const totalPages = Number(body.totalPages);
    if (last === true || (Number.isFinite(totalPages) && page >= totalPages) || items.length < size) break;
    page++;
    if (page > 100) break; // 안전 상한
  }
  return all;
}

// ─────────────────────────── 딜 매칭 ───────────────────────────

/** buildProductDealMap의 입력 행 형태(순수 로직 테스트를 위해 분리). */
export type ProductDealRow = {
  productId: string | null;
  salesCampaigns: { dealId: string; createdAt: Date }[];
};

/**
 * OrderCampaign 행들에서 productId → dealId 맵을 만든다(순수 함수 — 테스트 대상).
 * 같은 productId가 여러 회차(OrderCampaign)에 걸치면 **가장 최근 캠페인의 dealId**를 택한다.
 * first-write-wins가 아니라 createdAt 최댓값으로 결정론적으로 고른다 — 무정렬 스캔이 과거
 * 종료 회차를 먼저 반환해 진행 중 회차를 덮는 회귀(코드리뷰 지적)를 차단한다.
 */
export function resolveMostRecentDealByProduct(rows: ProductDealRow[]): Map<string, string> {
  const best = new Map<string, { dealId: string; at: number }>();
  for (const r of rows) {
    const pid = r.productId ? String(r.productId).trim() : '';
    const sc = r.salesCampaigns[0];
    if (!pid || !sc?.dealId) continue;
    const at = sc.createdAt ? new Date(sc.createdAt).getTime() : 0;
    const cur = best.get(pid);
    if (!cur || at > cur.at) best.set(pid, { dealId: sc.dealId, at });
  }
  const map = new Map<string, string>();
  for (const [pid, v] of best) map.set(pid, v.dealId);
  return map;
}

/** 스토어 상품 1건의 번호 쌍 — 원상품번호 1 : 채널상품번호 N. */
export type ProductNumberPair = {
  originProductNo: string;
  channelProductNos: string[];
  name?: string; // 리스팅명(리뷰 커버리지 Tier-2 상품명 매칭용). 없으면 빈 문자열
};

/**
 * 원상품번호 기반 딜 맵에 채널상품번호 항목을 추가한다(순수 — 테스트 대상).
 * 31일 백필 실측(2026-07-17)에서 상품문의 productId가 원상품번호와 전량 불일치(0/19 매칭)해,
 * 스토어 상품 목록의 채널↔원상품 쌍으로 채널번호도 같은 딜에 매핑한다. 기존 키는 덮지 않는다.
 */
export function extendDealMapWithChannelNumbers(
  map: Map<string, string>,
  pairs: ProductNumberPair[],
): number {
  let added = 0;
  for (const pair of pairs) {
    const dealId = map.get(pair.originProductNo.trim());
    if (!dealId) continue;
    for (const ch of pair.channelProductNos) {
      const key = String(ch).trim();
      if (key && !map.has(key)) {
        map.set(key, dealId);
        added++;
      }
    }
  }
  return added;
}

/** products/search 응답에서 번호 쌍을 추출한다(순수 — campaigns-handler와 동일 응답 형태 방어 파싱). */
export function parseProductNumberPairs(contents: any[]): ProductNumberPair[] {
  if (!Array.isArray(contents)) return [];
  const out: ProductNumberPair[] = [];
  for (const p of contents) {
    const origin = p?.originProductNo != null ? String(p.originProductNo).trim() : '';
    if (!origin) continue;
    const channels = Array.isArray(p?.channelProducts)
      ? p.channelProducts
          .map((cp: any) => (cp?.channelProductNo != null ? String(cp.channelProductNo).trim() : ''))
          .filter((s: string) => s.length > 0)
      : [];
    const name =
      (Array.isArray(p?.channelProducts) && p.channelProducts[0]?.name != null
        ? String(p.channelProducts[0].name)
        : p?.name != null
          ? String(p.name)
          : '') || '';
    out.push({ originProductNo: origin, channelProductNos: channels, name });
  }
  return out;
}

/** 스토어 전 상품의 번호 쌍을 수집한다(페이지네이션·방어 파싱). 실패는 호출부가 폴백 처리. */
export async function fetchStoreProductNumberPairs(): Promise<ProductNumberPair[]> {
  const all: ProductNumberPair[] = [];
  const size = 200;
  let page = 1;
  for (;;) {
    const res = await apiRequest('POST', '/v1/products/search', { page, size });
    const body = res?.data ?? res ?? {};
    const contents: any[] = body.contents || [];
    if (!Array.isArray(contents) || contents.length === 0) break;
    all.push(...parseProductNumberPairs(contents));
    const totalPages = Number(body.totalPages);
    if (Number.isFinite(totalPages) ? page >= totalPages : contents.length < size) break;
    page++;
    if (page > 20) break; // 안전 상한(4천 상품 — 실사용 초과 불가)
  }
  return all;
}

/**
 * 네이버 상품번호 → dealId 맵을 구성한다(상품문의 best-effort 귀속용).
 *
 * 1차 키는 OrderCampaign.productId(원상품번호). 상품문의 productId는 실측상 채널상품번호라
 * (31일 백필 0/19 매칭 — 주문과 달리 문의는 번호를 하나만 실음), 스토어 상품 목록 API로
 * 채널↔원상품 쌍을 받아 **채널번호도 같은 딜로 확장**한다. 상품 목록 조회 실패 시 원상품
 * 맵만으로 진행하고 확장 실패를 결과에 표기한다(문의 수집을 인질로 잡지 않되 침묵하지 않음).
 */
export async function buildProductDealMap(): Promise<{
  map: Map<string, string>;
  channelKeysAdded: number;
  channelMapError: string | null;
}> {
  const rows = await prisma.orderCampaign.findMany({
    where: { productId: { not: null } },
    select: {
      productId: true,
      salesCampaigns: {
        select: { dealId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  const map = resolveMostRecentDealByProduct(rows);

  let channelKeysAdded = 0;
  let channelMapError: string | null = null;
  try {
    const pairs = await fetchStoreProductNumberPairs();
    channelKeysAdded = extendDealMapWithChannelNumbers(map, pairs);
  } catch (err) {
    channelMapError = err instanceof Error ? err.message.slice(0, 300) : 'unknown';
  }
  return { map, channelKeysAdded, channelMapError };
}

/**
 * dealId 미매칭으로 저장된 기존 상품문의를 확장 맵으로 재매칭한다(백필 후 소급 교정 경로).
 * 미매칭 행은 소량이라 전량 스캔해도 저렴하다.
 */
export async function rematchUnmatchedQnas(map: Map<string, string>): Promise<number> {
  const unmatched = await prisma.productQna.findMany({
    where: { dealId: null },
    select: { questionId: true, productId: true },
  });
  let rematched = 0;
  for (const q of unmatched) {
    const dealId = map.get(String(q.productId).trim());
    if (!dealId) continue;
    await prisma.productQna.update({ where: { questionId: q.questionId }, data: { dealId } });
    rematched++;
  }
  return rematched;
}

// ─────────────────────────── upsert + 오케스트레이션 ───────────────────────────

async function upsertProductQnas(items: any[], dealMap: Map<string, string>): Promise<number> {
  let n = 0;
  for (const raw of items) {
    const p = parseProductQna(raw);
    if (!p) continue;
    const dealId = dealMap.get(p.productId) ?? null;
    const data = { ...p, dealId, collectedAt: new Date() };
    await prisma.productQna.upsert({
      where: { questionId: p.questionId },
      create: data,
      // 재수집 시 답변 반영·매칭 갱신. collectedAt은 create에만(최초 수집 시각 보존).
      update: { ...p, dealId },
    });
    n++;
  }
  return n;
}

async function upsertCustomerInquiries(items: any[]): Promise<number> {
  let n = 0;
  for (const raw of items) {
    const c = parseCustomerInquiry(raw);
    if (!c) continue;
    await prisma.customerInquiry.upsert({
      where: { inquiryNo: c.inquiryNo },
      create: { ...c, collectedAt: new Date() },
      update: c,
    });
    n++;
  }
  return n;
}

/**
 * 문의 수집 오케스트레이션. 증분은 questionId/inquiryNo upsert dedup에 의존하고, 창은
 * 직전 창과 하루 겹쳐 폴링한다(공식 권고: 경계 누락 방지). lookbackDays 만큼 거슬러 수집.
 *
 * @param lookbackDays 수집 창 길이(일). 기본 3(일일 크론 충분), 초기 백필은 확대(각 API 상한 내).
 */
export async function runQnaSync(lookbackDays = 3): Promise<{
  productQnaFetched: number;
  productQnaUpserted: number;
  customerInquiryFetched: number;
  customerInquiryUpserted: number;
  qnaRematched: number;
  channelKeysAdded: number;
  channelMapError: string | null;
}> {
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * DAY_MS);

  const { map: dealMap, channelKeysAdded, channelMapError } = await buildProductDealMap();

  const qnaItems = await fetchProductQnas(from, now);
  const productQnaUpserted = await upsertProductQnas(qnaItems, dealMap);

  const inquiryItems = await fetchCustomerInquiries(from, now);
  const customerInquiryUpserted = await upsertCustomerInquiries(inquiryItems);

  // 과거 수집분(백필 포함) 중 미매칭 행을 확장 맵으로 소급 재매칭.
  const qnaRematched = await rematchUnmatchedQnas(dealMap);

  return {
    productQnaFetched: qnaItems.length,
    productQnaUpserted,
    customerInquiryFetched: inquiryItems.length,
    customerInquiryUpserted,
    qnaRematched,
    channelKeysAdded,
    channelMapError,
  };
}
