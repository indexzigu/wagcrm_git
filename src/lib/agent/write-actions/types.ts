/**
 * WRITE 액션 실행기 공용 타입 + 엔티티 존재 검증(§0-6).
 *
 * 화이트리스트 등록(`WriteActionDefinition`)과 실행 결과(`WriteActionResult`)는
 * 모든 핸들러가 공유하는 계약이라 여기 한곳에 둔다 — 핸들러별 파일(`./add-entity-memo`
 * 등)은 이 타입만 import 하고 서로를 참조하지 않는다(`create-deal.ts` 가 `create-partner.ts`
 * 의 `createPartnerRow` 를 재사용하는 것 1건만 예외).
 */
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import type { ActivityEntityType } from "@/lib/activity-log";
import type { CrmCacheTag } from "@/lib/cache-tags";

export type WriteActionResult = {
  refType: string;
  refId: string;
  summary: string;
};

export type WriteActionHandler<TArgs> = (
  args: TArgs,
  actor: string,
  tx: Prisma.TransactionClient
) => Promise<WriteActionResult>;

/**
 * 쓰기가 **커밋된 뒤** 라우트가 수행해야 하는 후속 처리 명세(순수 데이터).
 *
 * ⛔ 여기서 직접 무효화·캘린더를 부르지 말 것 — 이 모듈은 트랜잭션 **안**에서 도는
 * 실행기다. 실행이 롤백돼도 캐시가 깨지고 캘린더가 갱신되는 반쪽 반영이 생긴다.
 * 실제 집행은 `write-action-effects.ts` 가 커밋 뒤에 한다(외부 IO 는 라우트 소유 —
 * `docs/agents/codebase-map.md`).
 */
export type WriteActionEffectSpec = {
  /**
   * 커밋 직후 무효화할 캐시 태그.
   * ⚠️ **빈 배열은 "아직 안 채운 구멍"이 아니라 판정 결과다** — 그 액션이 바꾸는 데이터를
   * 읽는 `use cache` 표면이 하나도 없다는 뜻이고, 태그를 채우면 신선도 이득 없이
   * ISR 쓰기만 늘어난다(`src/lib/cache-policy.ts` fan-out 축소 주석).
   */
  readonly revalidate: readonly CrmCacheTag[];
  /** 구글 캘린더를 재동기화할 캠페인 id. null = 캘린더에 실리는 값이 바뀌지 않는다. */
  readonly calendarCampaignId: string | null;
};

export type WriteActionDefinition<TArgs = any> = {
  argsSchema: z.ZodType<TArgs>;
  handler: WriteActionHandler<TArgs>;
  /**
   * **필수 필드다.** 신규 WRITE 액션을 등록하면 컴파일러가 후속 처리 판정을 강제한다 —
   * 이 필드가 선택이었다면 "DB 는 바뀌는데 화면은 그대로"가 조용히 재발한다.
   */
  effects: (result: WriteActionResult) => WriteActionEffectSpec;
};

/**
 * entityType별로 대상 엔티티가 실재하는지 확인한다(§0-6). 존재하지 않으면 throw —
 * 호출부(approve 라우트)가 이를 잡아 ActionProposal을 APPROVED→FAILED로 전이시킨다.
 */
export async function assertEntityExists(
  entityType: ActivityEntityType,
  entityId: string,
  tx: Prisma.TransactionClient
): Promise<void> {
  const entityLabel: Record<ActivityEntityType, string> = {
    PARTNER: "거래처",
    SELLER: "셀러",
    DEAL: "딜",
    CAMPAIGN: "캠페인",
  };

  let found: unknown = null;
  switch (entityType) {
    case "PARTNER":
      found = await tx.partner.findUnique({ where: { id: entityId } });
      break;
    case "SELLER":
      found = await tx.seller.findUnique({ where: { id: entityId } });
      break;
    case "DEAL":
      found = await tx.deal.findUnique({ where: { id: entityId } });
      break;
    case "CAMPAIGN":
      found = await tx.salesCampaign.findUnique({ where: { id: entityId } });
      break;
  }

  if (!found) {
    throw new Error(
      `대상 ${entityLabel[entityType]}(${entityId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`
    );
  }
}
