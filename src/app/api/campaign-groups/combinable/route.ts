import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { parseCandidateQuery } from "@/lib/campaign-group-candidate-query";
import { campaignGroupRepository } from "@/repositories/campaignGroupRepository";
import { toKstDateStr } from "@/lib/campaign-row";
import {
  expandYmdRangeByWindow,
  GROUP_WINDOW_DAYS,
  overlapsOrNear,
} from "@/lib/campaign-group-clustering";
import type {
  CampaignCombineCandidateRow,
  CampaignCombineCandidatesResponse,
  CampaignStatus,
} from "@/lib/crm-types";

/**
 * GET /api/campaign-groups/combinable?sellerId&startDate&endDate&excludeCampaignId
 *
 * 반환은 **아직 어느 그룹에도 속하지 않은 캠페인**이다 — 형제 라우트 `suggest` 가
 * 돌려주는 「합류할 기존 그룹」과 다른 질문에 답한다. 이 둘을 한 라우트로 합치지 말 것:
 * 종전에는 화면이 `suggest` 하나만 부르면서 문구는 "묶을 캠페인이 없습니다"라고 말해,
 * 그룹이 하나도 없는 셀러에서는 **무엇을 골라도 영원히 빈 목록**이었다(실제 결함).
 *
 * 기간 판정은 `overlapsOrNear`(클러스터링 정본)를 그대로 호출한다 — ⛔ 같은 규칙을
 * Prisma `where` 로 다시 쓰지 말 것: 소급 스크립트(`backfill-campaign-groups`)와 갈리면
 * 스크립트가 제안한 묶음이 화면에서는 후보로 안 보이고, 그 침묵은 결함처럼 보인다.
 *
 * ⚠️ **공유하는 것은 기간 창 하나이고 클러스터링 전체가 아니다.** 소급 스크립트는
 * `clusterByDateWindow` 를 써서 **같은 `dealId` 가 한 묶음에 두 번 나오면 분리**하지만
 * (무인 실행이라 회차 재판매를 조합으로 오인하면 되돌릴 사람이 없다), 이 라우트는 그
 * 축을 적용하지 않는다 — 여기서는 **사람이 고르고**, 화면이 딜 이름과 차수 배지를 함께
 * 보여주므로 같은 딜의 다른 회차인지 오너가 보고 판단한다. 서버 불변식도 이 축을 막지
 * 않는다(같은 셀러·2건 이상·미그룹 셋뿐). 이 문단을 지우고 "스크립트와 같은 기준"이라고
 * 뭉뚱그리지 말 것 — 실제로 두 경로의 결과 집합은 같은 딜 쌍에서 갈린다.
 */

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const parsed = parseCandidateQuery(request.nextUrl.searchParams);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // 넓힌 범위로 DB 를 좁힌다 — 순수 겹침 술어가 `overlapsOrNear` 와 등가가 되므로
    // 창 규칙을 SQL 에 다시 쓰지 않으면서 인덱스를 탄다. 아래 JS 필터는 그 등가를
    // 지키는 이중 방어이자, 창 규칙의 **정본이 어디인지**를 코드로 남기는 자리다.
    const widened = expandYmdRangeByWindow(parsed.data);
    const rows = await campaignGroupRepository.findSellerCampaignsForCombine({
      sellerId: parsed.data.sellerId,
      rangeStart: new Date(widened.startDate),
      rangeEnd: new Date(widened.endDate),
      excludeCampaignId: parsed.data.excludeCampaignId,
    });

    const origin = {
      startDate: new Date(parsed.data.startDate),
      endDate: new Date(parsed.data.endDate),
    };
    const near = rows.filter((row) =>
      overlapsOrNear(origin, { startDate: row.startDate, endDate: row.endDate }, GROUP_WINDOW_DAYS),
    );

    const candidates: CampaignCombineCandidateRow[] = near
      .filter((row) => row.groupId === null)
      .map((row) => ({
        campaignId: row.id,
        dealName: row.deal.dealName,
        brandName: row.deal.brandName ?? null,
        partnerName: row.deal.partner?.name ?? null,
        status: row.status as CampaignStatus,
        roundNumber: row.roundNumber ?? null,
        startDate: toKstDateStr(row.startDate)!,
        endDate: toKstDateStr(row.endDate)!,
      }));

    const payload: CampaignCombineCandidatesResponse = {
      candidates,
      alreadyGroupedCount: near.length - candidates.length,
    };
    return NextResponse.json(payload);
  } catch (error) {
    console.error("GET /api/campaign-groups/combinable failed:", error);
    return NextResponse.json({ error: "묶을 캠페인 조회에 실패했습니다." }, { status: 500 });
  }
}
