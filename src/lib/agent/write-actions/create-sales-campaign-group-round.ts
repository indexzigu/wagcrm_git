import type { Prisma } from "@prisma/client";
import {
  createSalesCampaignGroupRoundArgsSchema,
  type CreateSalesCampaignGroupRoundArgs,
} from "@/lib/agent-worker/contracts";
import { createCampaignInTx } from "@/services/campaignService";
import { campaignGroupService } from "@/services/campaignGroupService";
import { CAMPAIGN_INVALIDATION_TAGS } from "@/lib/cache-tags";
import { campaignStatusLabels } from "@/lib/crm-types";
import { toKstDateStr } from "@/lib/campaign-row";
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import { AGENT_MAPPING_APPLY_ACTOR } from "@/lib/agent-internal/actors";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

/**
 * 판매캠페인 **그룹** 다음 회차를 새로 만든다 — 봇 기안을 사람이 결재함에서 승인했을 때만(2026-11-14).
 *
 * args 는 기안 시점에 CRM 앱 봇 내부 창구(`agent-internal/sales-campaign-group-round-draft.ts`)가 지난 그룹과 스토어
 * 상품에서 만든 초안이다. 그룹 안 캠페인마다 화면 단건 생성과 같은 본체 `createCampaignInTx` 로 새 회차를 만들고, 화면
 * 조합 생성(`POST /api/campaigns/bulk-combo`)과 같은 `campaignGroupService.createGroup` 으로 새 그룹에 묶는다 — 모두 승인
 * tx 하나 안에서. 하나라도 실패하면 전부 롤백되고 기안은 FAILED 다(캠페인만 생기고 그룹이 없는 반쪽 상태가 없다).
 *
 * 가드:
 *  ① 사람 승인만 — 시스템·봇·옛 매핑 즉시 저장 실행자(2026-11-14 폐기)는 쓰기 전에 거부한다(없던 캠페인이 생기는 일).
 *  ② 캠페인마다 같은 판매 조건·셀러에 같은 기간 캠페인이 승인 사이에 생겼으면 거부한다(중복 회차).
 *  ③ 생성 — 하위품목은 지난 회차 값(수수료율·셀러 마진·원가·판매가)을 옮기고 수량·매출은 0 에서 시작한다.
 *  ④ 묶기 — 같은 셀러·미그룹 검사와 그룹 이름·대표 기간 계산은 그룹 서비스가 한다.
 */
async function handleCreateSalesCampaignGroupRound(
  args: CreateSalesCampaignGroupRoundArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  // ①
  if (isAutomatedActor(actor) || actor === AGENT_WORKER_ACTOR || actor === AGENT_MAPPING_APPLY_ACTOR) {
    throw new Error(`판매캠페인 생성 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ②
  const rounds = await tx.salesCampaign.findMany({
    where: { sellerId: args.sellerId, dealId: { in: args.members.map((member) => member.dealId) } },
    select: { dealId: true, campaignName: true, startDate: true, endDate: true },
  });
  const duplicate = rounds.find(
    (round) => toKstDateStr(round.startDate) === args.startDate && toKstDateStr(round.endDate) === args.endDate,
  );
  if (duplicate) {
    throw new Error(
      `판매캠페인 생성 불가: 같은 기간(${args.startDate} ~ ${args.endDate})의 캠페인 「${duplicate.campaignName ?? "이름없음"}」가 이미 있습니다.`,
    );
  }

  // ③
  const created = [];
  for (const member of args.members) {
    created.push(
      await createCampaignInTx(
        tx,
        {
          dealId: member.dealId,
          sellerId: args.sellerId,
          startDate: args.startDate,
          endDate: args.endDate,
          salesChannel: member.salesChannel,
          baseNaverLink: args.baseNaverLink,
          status: args.status,
          isManualMargin: member.isManualMargin,
          totalMarginRate: member.totalMarginRate,
          sellerMarginRate: member.sellerMarginRate,
          campaignDeals:
            member.campaignItems.length > 0
              ? member.campaignItems.map((item) => ({
                  dealId: item.dealId,
                  quantity: 0,
                  actualSales: 0,
                  feeRate: item.feeRate,
                  sellerMarginRate: item.sellerMarginRate,
                  costPrice: item.costPrice,
                  sellingPrice: item.sellingPrice,
                }))
              : undefined,
        },
        { userId: actor },
      ),
    );
  }

  // ④
  const group = await campaignGroupService.createGroup(
    created.map((campaign) => campaign.id),
    tx,
  );

  return {
    refType: "CAMPAIGN_GROUP",
    refId: group.id,
    // 상태 이름은 라벨 표에서 — 같은 상태를 화면마다 다른 말로 부르지 않는다(P2 화면 문구 기준 ①).
    summary: `판매캠페인 그룹 "${group.name ?? args.sellerName}" 등록(캠페인 ${created.length}개, ${campaignStatusLabels[args.status]}, ${args.startDate}~${args.endDate})`,
    createdCampaignIds: created.map((campaign) => campaign.id),
    ...(args.linkOrderCampaign ? { linkOrderCampaignId: args.linkOrderCampaign.id } : {}),
  };
}

/** 캠페인마다 회차 재계산 + 그룹 잠금·재계산 — 상한 10개 기준 여유 있게(기본 5초는 롤백 위험). */
const GROUP_ROUND_TX_TIMEOUT_MS = 30_000;

export const createSalesCampaignGroupRoundAction: WriteActionDefinition<CreateSalesCampaignGroupRoundArgs> = {
  argsSchema: createSalesCampaignGroupRoundArgsSchema,
  handler: handleCreateSalesCampaignGroupRound,
  txTimeoutMs: GROUP_ROUND_TX_TIMEOUT_MS,
  // 화면 조합 생성과 같은 짝: 캠페인 캐시 무효화 + 구글 캘린더 + 캠페인마다 드라이브 폴더. 캘린더는 그룹 멤버면
  // 그룹 일정 하나로 합쳐 동기화되므로(`syncCampaignToCalendar` → `syncGroupToCalendar`) 첫 캠페인으로 한 번만 부른다 —
  // 멤버마다 부르면 같은 그룹 일정을 동시에 여러 번 만들 수 있다. 주문캠페인 연결은 단건 회차와 같이
  // `autoMapOrderCampaign` 이 정본이다(옵션 점수로 그룹 캠페인들을 붙인다).
  effects: (result) => ({
    revalidate: CAMPAIGN_INVALIDATION_TAGS,
    calendarCampaignId: result.createdCampaignIds?.[0] ?? null,
    driveFolderCampaignIds: result.createdCampaignIds ?? [],
    ...(result.linkOrderCampaignId ? { autoMapOrderCampaignId: result.linkOrderCampaignId } : {}),
  }),
};
