import type { Prisma } from "@prisma/client";
import { createSalesCampaignRoundArgsSchema, type CreateSalesCampaignRoundArgs } from "@/lib/agent-worker/contracts";
import { createCampaignInTx } from "@/services/campaignService";
import { CAMPAIGN_INVALIDATION_TAGS } from "@/lib/cache-tags";
import { campaignStatusLabels } from "@/lib/crm-types";
import { toKstDateStr } from "@/lib/campaign-row";
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import { AGENT_MAPPING_APPLY_ACTOR } from "@/lib/agent-internal/actors";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

/**
 * 판매캠페인 다음 회차를 새로 만든다 — 봇 기안을 사람이 결재함에서 승인했을 때만(2026-11-14).
 *
 * args 는 기안 시점에 CRM 앱 봇 내부 창구(`agent-internal/sales-campaign-round-draft.ts`)가 이전 회차와 스토어 상품에서
 * 만든 초안이다. 생성은 화면(`POST /api/campaigns`)과 같은 본체 `createCampaignInTx` 를 승인 tx 안에서 부른다 — 마진
 * 유도·추적 링크·체크리스트·이력·회차/이름 재계산(`generateCampaignName`)이 두 입구에서 같다.
 *
 * 가드:
 *  ① 사람 승인만 — 시스템·봇·매핑 즉시 저장 실행자는 쓰기 전에 거부한다(없던 캠페인이 생기는 일).
 *  ② 같은 판매 조건·셀러에 같은 기간 캠페인이 승인 사이에 생겼으면 거부한다(중복 회차). 롤백되면 기안은 FAILED.
 *  ③ 생성 — 하위품목은 이전 회차 값(수수료율·셀러 마진·원가·판매가)을 옮기고 수량·매출은 0 에서 시작한다.
 */
async function handleCreateSalesCampaignRound(
  args: CreateSalesCampaignRoundArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  // ①
  if (isAutomatedActor(actor) || actor === AGENT_WORKER_ACTOR || actor === AGENT_MAPPING_APPLY_ACTOR) {
    throw new Error(`판매캠페인 생성 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ②
  const rounds = await tx.salesCampaign.findMany({
    where: { dealId: args.dealId, sellerId: args.sellerId },
    select: { campaignName: true, startDate: true, endDate: true },
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
  const created = await createCampaignInTx(
    tx,
    {
      dealId: args.dealId,
      sellerId: args.sellerId,
      startDate: args.startDate,
      endDate: args.endDate,
      salesChannel: args.salesChannel,
      baseNaverLink: args.baseNaverLink,
      status: args.status,
      isManualMargin: args.isManualMargin,
      totalMarginRate: args.totalMarginRate,
      sellerMarginRate: args.sellerMarginRate,
      campaignDeals:
        args.campaignItems.length > 0
          ? args.campaignItems.map((item) => ({
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
  );

  const name = created.campaignName ?? `${args.dealName} - ${args.sellerName}`;
  return {
    refType: "CAMPAIGN",
    refId: created.id,
    // 상태 이름은 라벨 표에서 — 같은 상태를 화면마다 다른 말로 부르지 않는다(P2 화면 문구 기준 ①).
    summary: `판매캠페인 "${name}" 등록(${campaignStatusLabels[args.status]}, ${args.startDate}~${args.endDate})`,
    ...(args.linkOrderCampaign ? { linkOrderCampaignId: args.linkOrderCampaign.id } : {}),
  };
}

export const createSalesCampaignRoundAction: WriteActionDefinition<CreateSalesCampaignRoundArgs> = {
  argsSchema: createSalesCampaignRoundArgsSchema,
  handler: handleCreateSalesCampaignRound,
  // 화면 생성 라우트와 같은 짝: 캠페인 캐시 무효화 + 구글 캘린더 등록 + 드라이브 폴더. 기안 시점에 이 상품의 아직
  // 연결 안 된 주문캠페인이 있었으면 그 주문캠페인의 판매 딜 자동 연결을 다시 돌려 새 회차를 붙인다
  // (`autoMapOrderCampaign` 이 연결 판정의 정본 — 여기서 직접 orderCampaignId 를 쓰지 않는다).
  effects: (result) => ({
    revalidate: CAMPAIGN_INVALIDATION_TAGS,
    calendarCampaignId: result.refId,
    driveFolderCampaignId: result.refId,
    ...(result.linkOrderCampaignId ? { autoMapOrderCampaignId: result.linkOrderCampaignId } : {}),
  }),
};
