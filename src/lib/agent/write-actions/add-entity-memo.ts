import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { recordActivityMemo } from "@/lib/activity-log";
import { assertEntityExists, type WriteActionDefinition, type WriteActionResult } from "./types";

const ENTITY_TYPES = ["PARTNER", "SELLER", "DEAL", "CAMPAIGN"] as const;

const addEntityMemoArgsSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  entityId: z.string().min(1),
  content: z.string().min(1).max(4000), // security-review L3: 자동승인 경로 스토리지 남용 방지 상한
});

export type AddEntityMemoArgs = z.infer<typeof addEntityMemoArgsSchema>;

async function handleAddEntityMemo(
  args: AddEntityMemoArgs,
  actor: string,
  tx: Prisma.TransactionClient
): Promise<WriteActionResult> {
  await assertEntityExists(args.entityType, args.entityId, tx);

  const log = await recordActivityMemo(args.entityType, args.entityId, args.content, actor, tx);

  return {
    refType: args.entityType,
    refId: args.entityId,
    summary: `${args.entityType} ${args.entityId}에 메모 기록 (ActivityLog ${log.id})`,
  };
}

export const addEntityMemoAction: WriteActionDefinition<AddEntityMemoArgs> = {
  argsSchema: addEntityMemoArgsSchema,
  handler: handleAddEntityMemo,
  // 무효화 대상 없음 — 이 액션은 `ActivityLog`(type=MEMO) 행만 만들고 엔티티 필드는
  // 건드리지 않으며, 그 테이블을 읽는 캐시 표면이 **0건**이다(2026-08-27 전수 확인).
  // 🪤 **문자열 grep 으로 캐시 표면을 세지 말 것** — `"use cache"` 를 grep 하면 파일 4개가
  //    걸리지만 그중 둘(`api/mobile/pulse/route.ts` · `reports/inflow/page.tsx`)은 「`use
  //    cache` 를 **안** 쓴다」고 적은 **주석**이다. 디렉티브를 실제로 가진 파일은
  //    `cached-crm-data.ts` · `cached-portal-data.ts` **둘뿐**이고, 그 둘과 그들이 부르는
  //    데이터 모듈 어디에도 `activityLog` 접근이 없다. `ActivityLog` 가 다른 모델의
  //    relation 으로 include 되는 경로도, `unstable_cache` 사용도 레포 전체에 0건이다.
  //    메모를 실제로 보여주는 `/api/activity-log` 와 세금계산서 보드는 둘 다 동적 라우트다.
  effects: () => ({ revalidate: [], calendarCampaignId: null }),
};
