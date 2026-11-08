// [셀러분석] 셀러별 AI 분석 참여율(비율) 맵 — 셀러 목록 주소 필터 `minEr` 전용.
//
// 왜 셀러 목록 공용 로더(loadSellerSummaries)에 안 넣었나: er 은 aiTags JSON 안에만 있고, jsonb 경로를
// 잘라 읽어도 Postgres 는 행마다 aiTags 전체(셀러당 수백 KB)를 풀어야 한다. 공용 로더는 캐시 없는
// 갱신 경로(GET /api/sellers)에서도 돌므로 그 비용을 매번 치르게 된다. 여기서는 캐시된 페이지 로드에서만
// 한 번 읽는다(cached-crm-data.ts). 근본 해법(분석 시점에 스칼라 열로 저장)은 후속 과제.
import { loadAiTagsPaths, type AiTagsPathsPrisma } from "./seller-ai-tags-paths";

/** sellerId → 참여율(비율, 0.03 = 3%). 값이 없거나 숫자가 아니면 키를 넣지 않는다(= 미분석). */
export async function loadSellerEngagementRates(prisma: AiTagsPathsPrisma): Promise<Record<string, number>> {
  const rows = await loadAiTagsPaths(prisma, null, ["engagementRate"] as const);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const raw = row.engagementRate;
    const n = typeof raw === "number" ? raw : raw === null || raw === undefined ? NaN : Number(String(raw));
    if (Number.isFinite(n)) out[row.sellerId] = n;
  }
  return out;
}
