import type { Prisma } from "@prisma/client";
import { getPrisma } from "./prisma";

type CampaignActivityInput = {
  campaignId: string;
  action: string;
  label: string;
  details?: string | null;
  actor?: string;
};

/**
 * @param tx 호출부가 연 트랜잭션(선택). 에이전트 `update_record` 가 캠페인 저장과 이력을 한
 *           트랜잭션으로 묶으려고 넘긴다. 생략하면 종전과 같다(순수 추가 파라미터).
 */
export async function recordCampaignActivity(input: CampaignActivityInput, tx?: Prisma.TransactionClient) {
  return (tx ?? getPrisma()).campaignActivity.create({
    data: {
      campaignId: input.campaignId,
      action: input.action,
      label: input.label,
      details: input.details ?? null,
      actor: input.actor ?? "SYSTEM",
    },
  });
}

export function describeChangedFields(changes: string[]) {
  if (changes.length === 0) return null;
  return changes.join(", ");
}
