import { z } from "zod";

/**
 * 후보 조회 2종이 공유하는 쿼리 계약.
 *
 * `suggest`(합류할 **기존 그룹**)와 `combinable`(묶을 **미그룹 캠페인**)은 답하는 질문이
 * 다르지만 받는 파라미터는 같고, 화면이 두 라우트를 **같은 값으로 함께** 부른다. 그래서
 * 한쪽 스키마만 바뀌면 다른 쪽이 400 으로 떨어진다 — 클라이언트의 `toCandidateSearch`
 * (`campaign-group-client.ts`)와 짝을 이루는 서버 쪽 절반이다.
 */
export const candidateQuerySchema = z.object({
  sellerId: z.string().min(1, "sellerId는 필수입니다."),
  startDate: z.string().date(),
  endDate: z.string().date(),
  excludeCampaignId: z.string().min(1).optional(),
});

export type CandidateQuery = z.infer<typeof candidateQuerySchema>;

/** 라우트가 받은 검색 파라미터를 위 계약으로 판독한다. */
export function parseCandidateQuery(searchParams: URLSearchParams) {
  return candidateQuerySchema.safeParse({
    sellerId: searchParams.get("sellerId") ?? undefined,
    startDate: searchParams.get("startDate") ?? undefined,
    endDate: searchParams.get("endDate") ?? undefined,
    excludeCampaignId: searchParams.get("excludeCampaignId") ?? undefined,
  });
}
