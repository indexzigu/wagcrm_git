// 그룹(조합) 캠페인의 콘텐츠 공유 범위 — 오너 확정(2026-07-13): 그룹으로 묶인 캠페인은 셀러가
// 캠페인별 개별 게시물을 올리지 않으므로 **홍보 게시물(등록 Asset·후보)·스토리를 그룹 전체가
// 공유**한다. suggested-posts·stories GET과 캠페인 상세(asset-manager)의 등록 게시물 필터가
// 이 스코프를 공용한다. CampaignGroup은 전 멤버 동일 셀러(스키마 앱 불변식)라 셀러 축은 그대로다.
import type { PrismaClient } from "@prisma/client";

export type CampaignContentScope = {
  /** 콘텐츠를 공유하는 캠페인 id 집합 — 자기 자신 포함(미그룹이면 [자신]) */
  campaignIds: string[];
  /** 후보·스토리 창 계산용 기간 — 그룹이면 멤버 min(start)~max(end) 포락선 */
  startDate: Date | null;
  endDate: Date | null;
};

export async function resolveCampaignContentScope(
  prisma: PrismaClient,
  campaign: { id: string; groupId: string | null; startDate: Date | null; endDate: Date | null },
): Promise<CampaignContentScope> {
  if (!campaign.groupId) {
    return { campaignIds: [campaign.id], startDate: campaign.startDate, endDate: campaign.endDate };
  }
  const members = await prisma.salesCampaign.findMany({
    where: { groupId: campaign.groupId },
    select: { id: true, startDate: true, endDate: true },
  });
  const ids = new Set<string>([campaign.id]);
  let start = campaign.startDate;
  let end = campaign.endDate;
  for (const m of members) {
    ids.add(m.id);
    if (m.startDate && (!start || m.startDate < start)) start = m.startDate;
    if (m.endDate && (!end || m.endDate > end)) end = m.endDate;
  }
  return { campaignIds: [...ids], startDate: start, endDate: end };
}
