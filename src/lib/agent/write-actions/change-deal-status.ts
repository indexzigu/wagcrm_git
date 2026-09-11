import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { recordActivityChange } from "@/lib/activity-log";
import { MASTER_DATA_INVALIDATION_TAGS } from "@/lib/cache-tags";
import { DEAL_STATUSES, isValidTransition, getValidNextStatuses, type DealStatus } from "@/lib/deal-status";
import { assertEntityExists, type WriteActionDefinition, type WriteActionResult } from "./types";

const changeDealStatusArgsSchema = z.object({
  dealId: z.string().min(1),
  newStatus: z.enum(DEAL_STATUSES as [DealStatus, ...DealStatus[]]),
});

export type ChangeDealStatusArgs = z.infer<typeof changeDealStatusArgsSchema>;

/**
 * 딜 상태를 변경한다(Phase 5 HITL WRITE 2종째 — 청사진 확정 설계).
 *
 * add_entity_memo와 달리 값 변경(§실제 필드 mutate)이므로 딜 상태기계 규칙을
 * executor에서 강제한다: 무의미한 자기전이, 역행, DROPPED(terminal) 탈출은 모두
 * throw로 거부한다. dealService.updateDeal은 tx를 지원하지 않아 원자성이 깨지므로
 * 재사용하지 않고, 여기서 직접 tx.deal.update + recordActivityChange(tx)를 호출한다.
 */
async function handleChangeDealStatus(
  args: ChangeDealStatusArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  await assertEntityExists("DEAL", args.dealId, tx);

  const deal = await tx.deal.findUnique({ where: { id: args.dealId } });
  if (!deal) {
    // assertEntityExists가 이미 존재를 확인했으므로 이 분기는 사실상 도달 불가하지만
    // 타입 좁히기 및 방어적 코딩을 위해 남겨둔다.
    throw new Error(`대상 딜(${args.dealId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }

  const currentStatus = deal.status as DealStatus;

  if (currentStatus === args.newStatus) {
    throw new Error(`이미 ${currentStatus} 상태입니다. 동일한 상태로는 변경할 수 없습니다.`);
  }

  if (!isValidTransition(currentStatus, args.newStatus)) {
    const validNext = getValidNextStatuses(currentStatus);
    const validNextLabel = validNext.length > 0 ? validNext.join(", ") : "없음(terminal 상태)";
    throw new Error(
      `${currentStatus}에서 ${args.newStatus}로 변경할 수 없습니다 (딜 상태기계 위반). ` +
        `가능한 다음 상태: ${validNextLabel}`
    );
  }

  await tx.deal.update({
    where: { id: args.dealId },
    data: { status: args.newStatus },
  });

  await recordActivityChange("DEAL", args.dealId, "상태", currentStatus, args.newStatus, actor, tx);

  return {
    refType: "DEAL",
    refId: args.dealId,
    summary: `딜 상태 ${currentStatus}→${args.newStatus} 변경`,
  };
}

export const changeDealStatusAction: WriteActionDefinition<ChangeDealStatusArgs> = {
  argsSchema: changeDealStatusArgsSchema,
  handler: handleChangeDealStatus,
  // 정본 버튼 경로 `PATCH /api/deals/[id]` 와 **같은 집합**(revalidateMasterDataCaches).
  // 집합을 여기서 새로 고르지 말 것 — 정본과 갈리는 순간 두 경로의 화면이 달라진다.
  effects: () => ({ revalidate: MASTER_DATA_INVALIDATION_TAGS, calendarCampaignId: null }),
};
