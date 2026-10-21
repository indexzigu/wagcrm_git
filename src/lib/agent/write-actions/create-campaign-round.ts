import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { recordActivityCreate } from "@/lib/activity-log";
import { CAMPAIGN_INVALIDATION_TAGS } from "@/lib/cache-tags";
import { createDraftCampaignInTx } from "@/lib/mobile-draft-campaign";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

/**
 * [캘린더수집] 캘린더에서 들어온 새 회차를 만든다(2026-10-21).
 * 설계 정본: docs/private/specs/2026-10-21-calendar-inbound-sync-design.md §3·§6·§8-b.
 *
 * - 기안은 캘린더 수집(`SYSTEM_CALENDAR_INBOUND`)만 올린다 — 봇 도구(`WRITE_TOOL_NAMES`)가 아니라서
 *   작업 실행기는 이 액션을 기안할 수 없다(`executor.ts` 가 도구 표에 없는 action 을 거절한다).
 * - 상태는 **PREPARATION**(오너 확정 ③) — PROPOSAL 이면 캘린더 비노출 규칙으로 동기화가 넘겨받은
 *   원본 일정을 지운다. 모바일 예비 일정(PROPOSAL)과 본체는 같고 입구만 다르다.
 * - 원본 이벤트 정보는 args 가 아니라 기안 `sourceRef.calendarInbound` 에 있다 — 넘겨받기는 커밋 뒤
 *   `approveProposal` 이 한다(`calendar-inbound/adopt.ts`). 이 핸들러는 캠페인만 만든다.
 */
// 모바일 예비 생성 라우트와 같은 판정 — 형식만이 아니라 실제 달력 날짜인지까지 본다.
const YMD = z.string().date();

const createCampaignRoundArgsSchema = z
  .object({
    dealId: z.string().min(1),
    sellerId: z.string().min(1),
    startDate: YMD,
    endDate: YMD,
  })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    message: "종료일은 시작일보다 빠를 수 없습니다.",
    path: ["endDate"],
  });

export type CreateCampaignRoundArgs = z.infer<typeof createCampaignRoundArgsSchema>;

/**
 * 가드 순서:
 *  ① 사람 승인만 — 시스템 실행자(`SYSTEM_*`)는 DB 를 읽기 전에 거부(없던 캠페인이 생기는 일이다).
 *  ② 생성 — 모바일 예비 캠페인과 같은 본체를 승인 tx 안에서(마진 유도·링크 빈값·회차 재부여).
 *     없는 딜·셀러면 던지고, 승인 tx 가 통째로 롤백돼 기안이 FAILED 로 남는다.
 */
async function handleCreateCampaignRound(
  args: CreateCampaignRoundArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  // ①
  if (isAutomatedActor(actor)) {
    throw new Error(`회차 생성 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ②
  const created = await createDraftCampaignInTx(tx, { ...args, status: "PREPARATION" });
  await recordActivityCreate("CAMPAIGN", created.id, actor, tx);

  const name = created.campaignName ?? `${created.dealName} - ${created.sellerName}`;
  return {
    refType: "CAMPAIGN",
    refId: created.id,
    summary: `캠페인 "${name}" 생성(준비중, ${args.startDate}~${args.endDate})`,
  };
}

export const createCampaignRoundAction: WriteActionDefinition<CreateCampaignRoundArgs> = {
  argsSchema: createCampaignRoundArgsSchema,
  handler: handleCreateCampaignRound,
  // 모바일 예비 생성 라우트의 `revalidateCampaignCaches()`(= CAMPAIGN_INVALIDATION_TAGS) + 캘린더 동기화와 같은 짝.
  // 동기화는 넘겨받기(장부에 원본 id 기록)가 끝난 뒤 `after()` 로 돈다 — 원본을 제자리에서 갱신한다.
  effects: (result) => ({ revalidate: CAMPAIGN_INVALIDATION_TAGS, calendarCampaignId: result.refId }),
};
