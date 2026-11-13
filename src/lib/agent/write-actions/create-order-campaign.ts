import type { Prisma } from "@prisma/client";
import { createOrderCampaignArgsSchema, type CreateOrderCampaignArgs } from "@/lib/agent-worker/contracts";
import { buildOrderCampaignCreateData } from "@/lib/order-converter/order-campaign-create";
import { AGENT_WORKER_ACTOR } from "@/lib/agent/agent-worker-proposal";
import { AGENT_MAPPING_APPLY_ACTOR } from "@/lib/agent-internal/actors";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

/**
 * 주문캠페인(「주문 관리」 캠페인 등록)을 새로 만든다 — 봇 기안을 사람이 결재함에서 승인했을 때만(2026-11-13).
 *
 * args 는 기안 시점에 CRM 앱 봇 내부 창구(`agent-internal/order-campaign-draft.ts`)가 네이버에서 읽어 만든 초안이다
 * (상품 연결 번호·상품명·썸네일·기간·스토어 옵션 줄·거래처 양식). 저장 칸 조립은 화면 등록 라우트
 * (`POST /order-converter/api/campaigns`)와 같은 본체 `buildOrderCampaignCreateData` 를 쓴다 — 두 입구가 만든
 * 캠페인이 같은 모양이어야 한다. 매핑 줄의 상품코드는 비워 둔다(등록 창 「스토어 옵션 불러오기」와 같다); 코드는
 * 이후 봇 매핑 작업이나 캠페인 설정 창이 채운다.
 *
 * 가드:
 *  ① 사람 승인만 — 시스템 실행자(`SYSTEM_*`)·봇 실행자(`AGENT_WORKER`)·매핑 즉시 저장 실행자(`AGENT_MAPPING_APPLY`, 매핑
 *     저장 전용 창구)는 쓰기 전에 거부한다(없던 캠페인이 생기는 일).
 *  ② 생성 — 승인 tx 안에서. 실패하면 tx 가 통째로 롤백돼 기안이 FAILED 로 남는다.
 *
 * 📝 같은 상품에 이미 캠페인이 있어도 막지 않는다 — 주문캠페인은 셀러·회차마다 새로 만드는 것이 운영 표준이다
 *    (`seller-portal.ts` 상단 오너 확정 2026-08-05). 대신 결재함 미리보기가 기안 시점의 같은 상품 캠페인을 보여 준다.
 * 📝 ActivityLog 를 남기지 않는다: `ActivityEntityType` 에 주문캠페인이 없다(`upsert-product-mappings.ts` 와 같다).
 */
async function handleCreateOrderCampaign(
  args: CreateOrderCampaignArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  // ①
  if (isAutomatedActor(actor) || actor === AGENT_WORKER_ACTOR || actor === AGENT_MAPPING_APPLY_ACTOR) {
    throw new Error(`주문캠페인 생성 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ②
  const created = await tx.orderCampaign.create({
    data: buildOrderCampaignCreateData({
      name: args.name,
      sellerName: args.sellerName,
      template: args.template,
      toEmail: args.toEmail,
      ccEmail: args.ccEmail,
      thumbnailUrl: args.thumbnailUrl,
      category: args.category,
      productStatus: args.productStatus,
      salePeriod: args.salePeriod,
      productId: args.productId,
      mappings: args.mappings.map((row) => ({ ...row, brandCode: "" })),
    }),
    select: { id: true, name: true },
  });

  return {
    refType: "ORDER_CAMPAIGN",
    refId: created.id,
    summary: `주문캠페인 "${created.name}" 생성(셀러 ${args.sellerName}, 매핑 ${args.mappings.length}줄)`,
    createdCount: args.mappings.length,
  };
}

export const createOrderCampaignAction: WriteActionDefinition<CreateOrderCampaignArgs> = {
  argsSchema: createOrderCampaignArgsSchema,
  handler: handleCreateOrderCampaign,
  // 후속 처리 = 화면 등록 라우트와 같다: 서버 캐시 태그 무효화 없음(`/order-converter` 는 전부 클라이언트 fetch),
  // 커밋 뒤 `autoMapOrderCampaign(id).then(() => fetchAndSyncCampaigns(false))` fire-and-forget(`write-action-effects.ts`).
  effects: (result) => ({ revalidate: [], calendarCampaignId: null, autoMapOrderCampaignId: result.refId }),
};
