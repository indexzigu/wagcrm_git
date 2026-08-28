import { apiRequest } from './naver-commerce-client';

/**
 * 반품/교환 수거 택배사 마스터.
 *
 * 별도 테이블 없이 모듈 레벨 인메모리 캐시로 유지한다(naver-commerce-client.ts의
 * cachedToken/tokenExpiresAt 토큰 캐시 관용구를 그대로 이식). TTL 24h — 택배사 목록은
 * 거의 변하지 않는 참조 데이터라 짧은 TTL이 불필요하고, 실패 시에도 기능을 죽이지
 * 않기 위해 빈 Map + warn으로 폴백한다(호출부는 코드 원문 폴백으로 계속 동작).
 */

export interface ReturnDeliveryCompany {
  name: string;
  priority: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let cachedCompanies: Map<string, ReturnDeliveryCompany> | null = null;
let cachedAt: number | null = null;
let inFlight: Promise<Map<string, ReturnDeliveryCompany>> | null = null;

/**
 * 응답 배열 요소의 실제 필드명이 문서상 확정돼 있지 않아, 여러 후보 키를 방어적으로
 * 시도한다(deliveryCompanyCode/code, deliveryCompanyName/name, priorityNumber/priority).
 */
function normalizeCompanyItem(item: any): { code: string; name: string; priority: number } | null {
  const code = item?.deliveryCompanyCode ?? item?.code ?? item?.id ?? null;
  if (!code) return null;
  const name = item?.deliveryCompanyName ?? item?.name ?? String(code);
  const priorityRaw = item?.priorityNumber ?? item?.priority ?? 0;
  const priority = typeof priorityRaw === 'number' ? priorityRaw : Number(priorityRaw) || 0;
  return { code: String(code), name: String(name), priority };
}

async function fetchReturnDeliveryCompanies(): Promise<Map<string, ReturnDeliveryCompany>> {
  const map = new Map<string, ReturnDeliveryCompany>();
  try {
    const res = await apiRequest('GET', '/v2/product-delivery-info/return-delivery-companies');
    // 응답이 배열 그대로 오는지, { data: [...] } 형태인지 문서상 미확정이라 둘 다 시도한다.
    const list: any[] = Array.isArray(res) ? res : Array.isArray(res?.data) ? res.data : [];
    for (const item of list) {
      const normalized = normalizeCompanyItem(item);
      if (normalized) {
        map.set(normalized.code, { name: normalized.name, priority: normalized.priority });
      }
    }
  } catch (err) {
    console.warn('[naver-return-delivery] 택배사 마스터 조회 실패 — 빈 Map으로 폴백:', err);
    return new Map();
  }
  return map;
}

/**
 * 반품/교환 수거 택배사 마스터를 조회한다. 24h 이내 캐시가 있으면 그대로 반환하고,
 * 없거나 만료됐으면 lazy fetch한다. 동시 호출 시 in-flight Promise를 공유해 중복 요청을 막는다.
 */
export async function getReturnDeliveryCompanies(): Promise<Map<string, ReturnDeliveryCompany>> {
  const now = Date.now();
  if (cachedCompanies && cachedAt && now - cachedAt < CACHE_TTL_MS) {
    return cachedCompanies;
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const map = await fetchReturnDeliveryCompanies();
      cachedCompanies = map;
      cachedAt = Date.now();
      return map;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * 택배사 코드를 사람이 읽을 수 있는 이름으로 변환한다. 마스터 캐시에 없으면(미스)
 * 코드 원문을 그대로 반환한다(폴백) — UI에서 빈 값보다 코드라도 보이는 게 낫다.
 */
export async function resolveCompanyName(code: string | null | undefined): Promise<string> {
  if (!code) return '';
  try {
    const companies = await getReturnDeliveryCompanies();
    const found = companies.get(code);
    return found?.name ?? code;
  } catch (err) {
    console.warn('[naver-return-delivery] resolveCompanyName 실패 — 코드 원문 폴백:', err);
    return code;
  }
}

/** 테스트 전용: 모듈 레벨 캐시를 초기화한다. */
export function __resetReturnDeliveryCacheForTests() {
  cachedCompanies = null;
  cachedAt = null;
  inFlight = null;
}
