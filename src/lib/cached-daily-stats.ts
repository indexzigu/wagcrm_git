/**
 * 마감 캠페인 일별 캐시(`OrderCampaign.cachedDailyStats` Json) 파서 — 의존성 0 순수 모듈.
 *
 * 소비처: 모바일 매출 상세(`mobile-campaign-sales.ts`) · 월별 정산의 주문일 기준 참고값
 * (`monthlySettlementService`). ⚠️ 이 파서를 `mobile-campaign-sales.ts` 안에 두면 안 된다 — 그 모듈은
 * import 시점에 DB 클라이언트를 만드는 저장소 체인을 끌고 와서, 서비스 계층이 그 파일을 import 하는
 * 순간 DB 를 목으로 둔 테스트들이 import 단계에서 죽었다(T-240 작업 중 실측).
 */
export type CachedDailyPoint = {
  /** YYYY-MM-DD (KST) */
  date: string;
  /** distinct 주문건수 */
  orders: number;
  revenue: number;
};

/** 형식 방어적으로 파싱한다 — 모양이 틀린 행은 버리고 날짜 오름차순으로 돌려준다. */
export function parseCachedDailyStats(raw: unknown): CachedDailyPoint[] {
  const parsed = typeof raw === "string" ? safeJsonParse(raw) : raw;
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((row) => {
      const r = row as { date?: unknown; orders?: unknown; revenue?: unknown };
      const date = typeof r.date === "string" ? r.date.slice(0, 10) : null;
      if (!date) return null;
      return {
        date,
        orders: Number(r.orders) || 0,
        revenue: Number(r.revenue) || 0,
      };
    })
    .filter((point): point is CachedDailyPoint => point !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
