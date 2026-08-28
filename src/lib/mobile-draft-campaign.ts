import type { SalesChannel } from "@/lib/crm-types";
import { getPrisma } from "@/lib/prisma";
import { parseBaseMarginPolicy } from "@/lib/base-margin-policy";
import { recalculateCampaignRounds } from "@/services/campaignService";

/**
 * 모바일 예비 캠페인 경량 생성 (MOBILE_UX_PLAN §4 · Phase 4).
 *
 * "예비"의 정의: baseNaverLink 빈값(링크 미확정) — 셀러 제안 단계(PROPOSAL)의
 * 일정 선점 레코드다. salesChannel·마진은 bulk 생성과 동일하게 딜의
 * baseMarginPolicy 첫 채널에서 자동 유도한다(수동 입력 없음).
 *
 * 캠페인명·차수는 저장하지 않고 같은 트랜잭션에서
 * recalculateCampaignRounds(딜×셀러 조합 전체 재번호+이름 재생성)로 부여한다 —
 * bulk 라우트의 캠페인명·차수 미설정 결함을 반복하지 않기 위함.
 */

export type DraftCampaignInput = {
  dealId: string;
  sellerId: string;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD (startDate 이상) */
  endDate: string;
};

export type DraftCampaignResult = {
  id: string;
  dealId: string;
  sellerId: string;
  campaignName: string | null;
  roundNumber: number | null;
  /** ISO 문자열 — 클라이언트 MobileCalendarCampaign 조립용 */
  startDate: string;
  endDate: string;
  status: string;
  /**
   * 딜 정책에서 유도된 채널(없으면 `UNSPECIFIED`) — 클라이언트가 낙관 반영할
   * `MobileCalendarCampaign` 의 자금 슬롯 판정 축이다. ⛔ 클라이언트에서 임의 값으로
   * 채우지 말 것: 예비 캠페인은 대금 예정일이 없어 지금은 마커가 안 서지만, 추측한
   * 채널이 캐시에 남으면 이후 일정이 붙는 순간 **틀린 슬롯 구성**으로 그려진다.
   */
  salesChannel: SalesChannel;
  dealName: string;
  /** alias 우선 (P2 Seller Alias Priority) */
  sellerName: string;
};

/** 라우트가 HTTP 상태로 변환할 수 있는 도메인 에러. */
export class DraftCampaignError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DraftCampaignError";
    this.status = status;
  }
}

const YMD_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export async function createDraftCampaign(
  input: DraftCampaignInput,
): Promise<DraftCampaignResult> {
  if (!YMD_PATTERN.test(input.startDate) || !YMD_PATTERN.test(input.endDate)) {
    throw new DraftCampaignError("날짜는 YYYY-MM-DD 형식이어야 합니다.", 400);
  }
  // YYYY-MM-DD 는 사전순 비교 = 날짜 비교
  if (input.endDate < input.startDate) {
    throw new DraftCampaignError("종료일은 시작일보다 빠를 수 없습니다.", 400);
  }

  const prisma = getPrisma();

  const { campaign, dealName, sellerName } = await prisma.$transaction(
    async (tx) => {
      const deal = await tx.deal.findUnique({
        where: { id: input.dealId },
        select: {
          id: true,
          dealName: true,
          dealType: true,
          status: true,
          baseMarginPolicy: true,
        },
      });
      if (!deal) {
        throw new DraftCampaignError("해당 딜을 찾을 수 없습니다.", 404);
      }

      const seller = await tx.seller.findUnique({
        where: { id: input.sellerId },
        select: { id: true, name: true, alias: true },
      });
      if (!seller) {
        throw new DraftCampaignError("해당 셀러를 찾을 수 없습니다.", 404);
      }

      // bulk(campaigns/bulk POST)와 동일 패턴: 딜 정책의 첫 채널에서 마진 자동.
      // salesChannel 은 §4 확정대로 정책 첫 채널(없으면 미지정) — 예비 단계에
      // 임의 채널을 확정하지 않는다.
      const policy = parseBaseMarginPolicy(deal.baseMarginPolicy);
      const [firstChannelName, firstChannelRate] =
        Object.entries(policy.byChannel)[0] ?? [];
      const totalMarginRate = firstChannelRate?.totalMarginRate ?? 0;
      const sellerMarginRate = firstChannelRate?.sellerMarginRate ?? 0;

      const created = await tx.salesCampaign.create({
        data: {
          dealId: input.dealId,
          sellerId: input.sellerId,
          startDate: new Date(input.startDate),
          endDate: new Date(input.endDate),
          status: "PROPOSAL",
          salesChannel: firstChannelName ?? "UNSPECIFIED",
          totalMarginRate,
          sellerMarginRate,
          netMarginRate: totalMarginRate - sellerMarginRate,
          // 예비의 정의 — 링크 빈값. 추적 링크도 실링크 확정 전이므로 비워둔다
          // (bulk 의 가짜 랜덤 track.wag.kr 링크는 복사 사고 위험이라 미채택).
          baseNaverLink: "",
          generatedTrackingLink: "",
        },
      });

      // 같은 tx 안에서 캠페인명·차수 자동 부여(딜×셀러 조합 전체 재계산).
      await recalculateCampaignRounds(input.dealId, input.sellerId, tx);

      const refreshed = await tx.salesCampaign.findUnique({
        where: { id: created.id },
        select: {
          id: true,
          campaignName: true,
          roundNumber: true,
          startDate: true,
          endDate: true,
          status: true,
          salesChannel: true,
        },
      });
      if (!refreshed) {
        throw new DraftCampaignError("생성된 캠페인을 다시 읽지 못했습니다.", 500);
      }

      return {
        campaign: refreshed,
        dealName: deal.dealName,
        sellerName: seller.alias || seller.name,
      };
    },
  );

  return {
    id: campaign.id,
    dealId: input.dealId,
    sellerId: input.sellerId,
    campaignName: campaign.campaignName ?? null,
    roundNumber: campaign.roundNumber ?? null,
    startDate: campaign.startDate.toISOString(),
    endDate: campaign.endDate.toISOString(),
    status: campaign.status,
    salesChannel: campaign.salesChannel as SalesChannel,
    dealName,
    sellerName,
  };
}
