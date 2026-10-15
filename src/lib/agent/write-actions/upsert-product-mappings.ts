import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { normalizeMappingOptionName, sameOrderCampaignName, upsertProductMappingsArgsSchema } from "@/lib/agent-worker/contracts";
import { planProductMappingUpsert } from "@/lib/order-converter/product-mapping-upsert";
import { isSqliteDatabaseUrl } from "@/lib/prisma-client";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

export type UpsertProductMappingsArgs = z.infer<typeof upsertProductMappingsArgsSchema>;

/** 봇(작업 실행기)이 기안을 만들 때 쓰는 실행자 이름 — 기안자가 스스로 승인·실행하는 길을 막는다. */
const AGENT_WORKER_ACTOR = "AGENT_WORKER";

/**
 * 주문캠페인 하나의 상품 매핑(옵션명 → 상품코드·가격)을 새로 넣거나 고친다 — 기안자가 본 값이 그대로일
 * 때만, 사람이 승인했을 때만. 승인 라우트가 연 tx(기안 EXECUTED 전이와 같은 트랜잭션) 안에서 돈다.
 *
 * 가드 순서:
 *  ① 사람 승인만 — 시스템 실행자(`SYSTEM_*`)와 봇 실행자(`AGENT_WORKER`)는 DB 를 읽기 전에 거부한다
 *     (`update-record.ts` 와 같은 경계 · 승인 경로는 승인자 id 를 actor 로 넘긴다).
 *  ② 잠금 — 주문캠페인 행을 `SELECT … FOR UPDATE` 로 잠근다(아래 동시성 절). sqlite(dev:local·test:ci)는
 *     구문이 없어 건너뛴다(`acquireGroupLock` 과 같은 분기).
 *  ③ 캠페인 확인 — 없으면 실패, 이름이 기안 때(`orderCampaignName`)와 다르면 실패. 승인자는 결재함에서
 *     기안에 적힌 이름을 보고 승인했으므로, 그 사이 이름이 바뀌었다면 다른 캠페인으로 읽었을 수 있다.
 *  ④ 계획 — 지금 줄을 읽어 `planProductMappingUpsert` 로 판정한다. 한 줄이라도 걸리면 아무것도 쓰지 않는다.
 *  ⑤ 반영 — 고칠 줄을 먼저, **조건부**로 쓴다: `updateMany({ id, brandCode: 기안 때 코드, price: 기안 때
 *     가격 })` 가 정확히 1행이 아니면 「지금 값이 승인 중에 바뀌었습니다」로 실패한다(④의 읽기와 이 쓰기
 *     사이에 남이 고친 값을 덮지 않는다 · `update-settlement-amount.ts` ③과 같은 방식). 그다음 새 줄을
 *     create(상품명 없으면 "" — 화면 저장과 같은 기본값). 고칠 줄은 상품코드·가격, 기안이 상품명을 줬을
 *     때만 상품명을 쓴다. **`campaignDealId` 는 건드리지 않는다**(화면에서 연결한 딜을 기안이 끊으면 안
 *     된다). 지우기(deleteMany)는 하지 않는다 — 화면 저장과 달리 전량 교체가 아니다.
 *
 * 후속 처리: 새 줄을 하나 이상 만들었을 때만(`createdCount > 0`), 커밋 뒤 캠페인 편집 화면 저장과 **같은
 * 전체 자동 연결**(`autoMapOrderCampaign`)이 돈다. 그 함수는 이 캠페인의 매핑 **전부**를 다시 채점하므로,
 * 새 줄뿐 아니라 이미 있던 줄의 판매 딜 연결을 바꾸거나 판매 캠페인 연결을 끊을 수 있다(D7 화면 저장과 같은
 * 동작). 고치기만 한 기안은 연결할 새 줄이 없어 자동 연결을 돌리지 않는다 — 기존 연결은 그대로다.
 *
 * 📝 ActivityLog 를 남기지 않는다: `ActivityEntityType` 에 주문캠페인이 없다(거래처·셀러·딜·캠페인 넷뿐).
 *    이력은 기안 자체(`ActionProposal.payload` 의 줄 목록·메모)와 상태 전이(`ActionProposalEvent`)가 남긴다.
 *
 * ⚠️ 동시성. ②의 행 잠금은 **봇 기안 승인끼리만** 줄 세운다 — 같은 캠페인의 두 기안을 동시에 승인하면
 *    뒤의 것이 앞의 커밋을 기다렸다가 그 결과 위에서 ④를 다시 읽는다. 화면 저장(`PUT
 *    /order-converter/api/campaigns/[id]`)은 여전히 이 잠금을 잡지 않는다: 매핑을 전량 deleteMany 한 뒤
 *    다시 만든다. 그 저장이 ④의 읽기와 ⑤의 쓰기 사이에 커밋되면 우리가 고치려던 행 id 가 사라져 조건부
 *    쓰기가 0행 → 실패하고 tx 전체가 롤백, 기안은 FAILED 로 남는다. 지금 값을 다시 조회해 다시 기안하면
 *    된다. 같은 틈에 화면 저장이 같은 옵션명을 다시 만들었다면 새 줄 create 가 중복 줄을 만들 수 있다 —
 *    다음 기안의 계획 ①(중복 2줄 이상 거절)이 드러내고, 화면에서 정리한다. 오너가 쓰는 화면과 봇 기안이
 *    같은 캠페인을 동시에 고치는 일은 드물어 화면 저장 쪽에는 잠금을 들이지 않았다.
 */
async function handleUpsertProductMappings(
  args: UpsertProductMappingsArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  // ①
  if (isAutomatedActor(actor) || actor === AGENT_WORKER_ACTOR) {
    throw new Error(`상품 매핑 반영 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ② 매개변수 바인딩 태그 템플릿 — id 는 SQL 문자열에 섞이지 않는다.
  if (!isSqliteDatabaseUrl()) {
    await tx.$queryRaw`SELECT 1 FROM "OrderCampaign" WHERE id = ${args.orderCampaignId} FOR UPDATE`;
  }

  // ③
  const campaign = await tx.orderCampaign.findUnique({
    where: { id: args.orderCampaignId },
    select: { id: true, name: true },
  });
  if (!campaign) {
    throw new Error(`주문캠페인(${args.orderCampaignId})을 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }
  if (!sameOrderCampaignName(campaign.name, args.orderCampaignName)) {
    throw new Error(`주문캠페인 이름이 기안 때와 다릅니다(지금 「${campaign.name}」)`);
  }

  // ④
  const existing = await tx.productMapping.findMany({
    where: { campaignId: campaign.id },
    select: { id: true, optionName: true, productName: true, brandCode: true, price: true },
  });
  const plan = planProductMappingUpsert(existing, args.mappings);
  if (!plan.ok) {
    throw new Error(plan.reason);
  }

  // ⑤ 고칠 줄 먼저(조건부) — 하나라도 어긋나면 새 줄을 만들기 전에 멈춘다.
  for (const { id, row } of plan.updates) {
    // 계획 ④가 고칠 줄은 기안 때 값이 둘 다 있을 때만 통과시킨다(새 줄 판정 = 둘 중 하나라도 null).
    if (row.expectedBrandCode === null || row.expectedPrice === null) {
      throw new Error(`「${normalizeMappingOptionName(row.optionName)}」 기안 때 값이 없어 고칠 수 없습니다.`);
    }
    const { count } = await tx.productMapping.updateMany({
      where: { id, brandCode: row.expectedBrandCode, price: row.expectedPrice },
      data: {
        brandCode: row.brandCode,
        price: row.price,
        ...(row.productName !== undefined ? { productName: row.productName } : {}),
      },
    });
    if (count !== 1) {
      throw new Error(
        `「${normalizeMappingOptionName(row.optionName)}」 지금 값이 승인 중에 바뀌었습니다. 다시 올려 주세요.`,
      );
    }
  }
  for (const row of plan.creates) {
    await tx.productMapping.create({
      data: {
        campaignId: campaign.id,
        optionName: row.optionName,
        productName: row.productName ?? "",
        brandCode: row.brandCode,
        price: row.price,
      },
    });
  }

  return {
    refType: "ORDER_CAMPAIGN",
    refId: campaign.id,
    summary:
      `주문캠페인 "${campaign.name}" 상품 매핑: ` +
      `새로 ${plan.creates.length}줄 · 바꿈 ${plan.updates.length}줄 · 그대로 ${plan.unchanged}줄`,
    createdCount: plan.creates.length,
  };
}

export const upsertProductMappingsAction: WriteActionDefinition<UpsertProductMappingsArgs> = {
  argsSchema: upsertProductMappingsArgsSchema,
  handler: handleUpsertProductMappings,
  // 후속 처리 = 화면 저장(캠페인 PUT 라우트 `src/app/order-converter/api/campaigns/[id]/route.ts`)과
  // 같다. 그 라우트는 `deleteMany` 로 매핑을 갈아끼운 뒤 캐시 태그를 **하나도** 무효화하지 않고
  // (`/order-converter` 는 전부 클라이언트 fetch 라 서버 캐시 표면이 없다), 커밋 뒤
  // `autoMapOrderCampaign(id).then(() => fetchAndSyncCampaigns(false))` 만 fire-and-forget 으로 돈다.
  // 그래서 `revalidate: []` 는 "아직 안 채움"이 아니라 판정 결과다(`verify-cache-policy` 라이터 등재 대상 아님).
  // 자동 연결은 **새 줄을 만들었을 때만**(`createdCount > 0`) 돈다. 돌 때는 화면 저장과 같은 전체 자동
  // 연결이라 이 캠페인 매핑 전부를 다시 채점한다 — 새 줄만이 아니라 이미 있던 줄의 판매 딜 연결이 바뀌거나
  // 판매 캠페인 연결이 끊길 수 있다(D7 화면 저장과 같은 동작 · 결재함 미리보기가 승인 전에 알린다).
  // 고치기만 한 기안은 update 로 기존 행(과 `campaignDealId`)을 유지하고 연결할 새 줄이 없으므로 돌리지 않는다.
  effects: (result) => ({
    revalidate: [],
    calendarCampaignId: null,
    ...((result.createdCount ?? 0) > 0 ? { autoMapOrderCampaignId: result.refId } : {}),
  }),
};
