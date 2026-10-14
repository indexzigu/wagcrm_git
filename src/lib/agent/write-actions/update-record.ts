import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { recordActivityMemo } from "@/lib/activity-log";
import { updateRecordArgsSchema } from "@/lib/agent-worker/contracts";
import {
  RECORD_ENTITY_LABELS,
  formatRecordValue,
  recordFieldLabel,
} from "@/lib/record-update-labels";
import {
  applyRecordChanges,
  currentValueOf,
  lockRecordRows,
  readRecordSnapshot,
  recordUpdateEffects,
  sameComparable,
  toComparableValue,
  validateRecordChanges,
} from "../record-update-entities";
import { isAutomatedActor } from "./update-settlement-amount";
import type { WriteActionDefinition, WriteActionResult } from "./types";

/**
 * 실행기의 argsSchema — 계약 모양(`updateRecordArgsSchema`) 위에 **그 엔티티의 화면 PATCH 스키마** 검사를
 * 얹는다. 기안 단계(작업 실행기 `createActionProposal` 이 같은 스키마로 거른다)와 승인 단계가 같은 판정이다.
 */
export const updateRecordActionArgsSchema = updateRecordArgsSchema.superRefine((value, context) => {
  const validation = validateRecordChanges(value.entityType, value.changes);
  if (!validation.ok) {
    context.addIssue({ code: "custom", path: ["changes"], message: validation.message });
  }
});

export type UpdateRecordArgs = z.infer<typeof updateRecordArgsSchema>;

/** 결재함·결과 요약에 싣는 「칸 지금 → 바꿀」 한 줄들. */
export function describeRecordChanges(args: Pick<UpdateRecordArgs, "entityType" | "changes" | "expected">): string {
  return Object.keys(args.changes)
    .map(
      (field) =>
        `${recordFieldLabel(args.entityType, field)} ${formatRecordValue(args.entityType, field, args.expected[field])} → ` +
        formatRecordValue(args.entityType, field, args.changes[field]),
    )
    .join(" · ");
}

/**
 * 엔티티 기록을 화면 저장과 **같은 본체**로 고친다 — 기안자가 본 값이 그대로일 때만, 사람이 승인했을 때만.
 * 승인 라우트가 연 tx(기안 EXECUTED 전이와 같은 트랜잭션) 안에서 돈다.
 *
 * 가드 순서:
 *  ① 사람 승인만 — 시스템 실행자(`SYSTEM_*`)는 거부한다. 이 기안은 자동 실행 대상이 아니다
 *     (`approval-policy.ts` 수동 고정 · 정산 자동 실행기는 `update_settlement_amount` 만 집는다).
 *  ② 값 검사 — 그 엔티티의 PATCH 스키마(argsSchema 가 이미 했지만, 정규화된 값을 다시 얻으려고 한 번 더).
 *  ③ 지금 값 대조 — 칸마다 저장값(화면 모양: 묶음 캠페인이면 묶음 행, 날짜는 KST 날짜) = `expected`.
 *  ④ 잠금 — 읽은 `updatedAt` 그대로인 행만 잠근다(묶음이면 묶음 행 → 멤버 행). 그 사이 다른 저장이
 *     있었으면 실패, 이후 다른 저장은 우리 커밋을 기다린다.
 *  ⑤ 반영 — 화면 PATCH 의 본체를 같은 tx 로 부른다. 그 함수가 거절하면 기안이 실패로 남고 전부 롤백된다.
 */
async function handleUpdateRecord(
  args: UpdateRecordArgs,
  actor: string,
  tx: Prisma.TransactionClient,
): Promise<WriteActionResult> {
  const entityLabel = RECORD_ENTITY_LABELS[args.entityType];

  // ①
  if (isAutomatedActor(actor)) {
    throw new Error(`기록 수정 불가: 이 기안은 사람이 결재함에서 승인해야 반영됩니다(실행자 ${actor}).`);
  }

  // ②
  const validation = validateRecordChanges(args.entityType, args.changes);
  if (!validation.ok) {
    throw new Error(`기록 수정 불가: ${validation.message}`);
  }

  // ③
  const snapshot = await readRecordSnapshot(tx, args.entityType, args.entityId);
  if (!snapshot) {
    throw new Error(`대상 ${entityLabel}(${args.entityId})를 찾을 수 없습니다. 이미 삭제되었거나 잘못된 대상입니다.`);
  }
  const stale = Object.keys(args.changes).filter(
    (field) => !sameComparable(currentValueOf(args.entityType, snapshot, field), args.expected[field]),
  );
  if (stale.length > 0) {
    const detail = stale
      .map(
        (field) =>
          `${recordFieldLabel(args.entityType, field)}(기안: ${formatRecordValue(args.entityType, field, args.expected[field])} · ` +
          `현재: ${formatRecordValue(args.entityType, field, toComparableValue(currentValueOf(args.entityType, snapshot, field)))})`,
      )
      .join(", ");
    throw new Error(`기록 수정 불가: 지금 값이 기안 때와 다릅니다: ${detail}. 최신 값을 확인한 뒤 다시 기안하세요.`);
  }

  // ④
  if (!(await lockRecordRows(tx, args.entityType, args.entityId, snapshot))) {
    throw new Error("기록 수정 실패: 확인한 직후 다른 수정이 먼저 반영되었습니다. 최신 값을 확인한 뒤 다시 기안하세요.");
  }

  // ⑤
  await applyRecordChanges(tx, args.entityType, args.entityId, validation.data, actor);

  if (args.memo) {
    await recordActivityMemo(args.entityType, args.entityId, `기록 수정 기안 메모: ${args.memo}`, actor, tx);
  }

  return {
    refType: args.entityType,
    refId: args.entityId,
    summary: `${entityLabel} 기록 수정: ${describeRecordChanges(args)}`,
  };
}

export const updateRecordAction: WriteActionDefinition<UpdateRecordArgs> = {
  argsSchema: updateRecordActionArgsSchema,
  handler: handleUpdateRecord,
  // 무효화·캘린더 판정은 엔티티별로 `recordUpdateEffects` 가 소유한다(화면 PATCH 와 같은 태그 묶음 —
  // 캠페인 revalidate: CAMPAIGN_INVALIDATION_TAGS, 그 밖 revalidate: MASTER_DATA_INVALIDATION_TAGS).
  effects: (result) => recordUpdateEffects(result.refType, result.refId),
};
