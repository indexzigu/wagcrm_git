/**
 * WRITE 액션 화이트리스트 레지스트리 + 디스패처.
 *
 * 핸들러 본체는 액션별 파일(`./add-entity-memo` 등)에 있다 — 여기서는 등록·실행만 한다.
 * payload 화이트리스트 디스패치 — ActionProposal.payload = {action, args}에서
 * action 문자열로 이 맵만 조회한다. 임의 {service,method} eval은 절대 금지(R1) —
 * 여기서는 사전에 등록된 핸들러만 호출 가능하다.
 */
import type { Prisma } from "@prisma/client";
import { addEntityMemoAction } from "./add-entity-memo";
import { changeDealStatusAction } from "./change-deal-status";
import { confirmSettlementAction } from "./confirm-settlement";
import { createPartnerAction } from "./create-partner";
import { createDealAction } from "./create-deal";
import type { WriteActionDefinition, WriteActionEffectSpec, WriteActionResult } from "./types";

/**
 * WRITE 액션 화이트리스트. Phase 5 HITL은 add_entity_memo, change_deal_status,
 * confirm_settlement 3종으로 시작했고(청사진 확정 설계), 에이전트가 거래처·딜을
 * 등록할 수 있도록 create_partner, create_deal 2종을 더한 5종이다.
 */
export const WRITE_ACTIONS: Record<string, WriteActionDefinition> = {
  add_entity_memo: addEntityMemoAction,
  change_deal_status: changeDealStatusAction,
  create_partner: createPartnerAction,
  create_deal: createDealAction,
  confirm_settlement: confirmSettlementAction,
};

export type WriteActionName = keyof typeof WRITE_ACTIONS;

/**
 * WRITE 액션을 화이트리스트 경유로 실행한다. 등록되지 않은 action은 즉시 거부한다 —
 * 임의 서비스/메서드를 동적으로 호출하는 경로는 존재하지 않는다(R1).
 */
export async function executeWriteAction(
  action: string,
  args: unknown,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  const definition = WRITE_ACTIONS[action];
  if (!definition) {
    throw new Error(`등록되지 않은 WRITE 액션입니다 (화이트리스트에 없음): ${action}`);
  }

  const parsed = definition.argsSchema.safeParse(args);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`WRITE 액션 args 검증 실패 (${action}): ${issues}`);
  }

  return definition.handler(parsed.data, actor, tx);
}

/**
 * 실행이 커밋된 뒤 수행할 후속 처리 명세를 액션 이름으로 조회한다.
 *
 * `executeWriteAction` 의 반환 타입(`WriteActionResult`)은 `ActionProposal.executionResult`
 * 로 그대로 직렬화되므로 여기에 후속 처리 정보를 얹지 않고 **별도 조회**로 분리한다.
 */
export function resolveWriteActionEffects(
  action: string,
  result: WriteActionResult
): WriteActionEffectSpec {
  const definition = WRITE_ACTIONS[action];
  if (!definition) {
    throw new Error(`등록되지 않은 WRITE 액션입니다 (화이트리스트에 없음): ${action}`);
  }
  return definition.effects(result);
}
