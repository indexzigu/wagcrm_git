import { RECORD_ENTITY_LABELS } from "@/lib/record-update-labels";
import {
  describeRecordChanges,
  updateRecordActionArgsSchema,
  type UpdateRecordArgs,
} from "@/lib/agent/write-actions/update-record";
import type { AgentTool, ToolResult, WriteIntent } from "./types";
import { missingParam, ok } from "./types";

export type UpdateRecordData = {
  writeIntent: WriteIntent;
};

/**
 * 기록 수정의 **기안 의도**만 만든다 — 대상을 조회하지도, 값을 바꾸지도 않는다(`update-settlement-amount.ts`
 * 도구와 같은 계약). 칸 검사는 입력 스키마(그 엔티티의 화면 PATCH 스키마)가 이미 했고, 지금 값 대조·반영은
 * 승인 시점에 `write-actions/update-record.ts` 가 한다.
 *
 * 요약 줄은 결재함 카드 제목이 된다 — 칸마다 「지금 → 바꿀」을 싣는다(승인자가 판단할 값이 제목에 있어야 한다).
 */
async function execute(input: UpdateRecordArgs): Promise<ToolResult<UpdateRecordData>> {
  const { entityType, entityId, changes, expected, memo } = input;
  if (!entityId || !entityId.trim()) {
    return missingParam("고칠 대상의 ID가 필요합니다.", { entityType, entityId });
  }

  const args = {
    entityType,
    entityId,
    changes,
    expected,
    ...(memo !== undefined ? { memo } : {}),
  } satisfies UpdateRecordArgs;

  const writeIntent: WriteIntent = {
    action: "update_record",
    args,
    summary: `${RECORD_ENTITY_LABELS[entityType]}(${entityId}) 기록 수정: ${describeRecordChanges(args)}`,
    targetEntityType: entityType,
    targetEntityId: entityId,
  };

  // 실조회가 없으므로 dataSources 는 비어 있다(승인 전에는 아무것도 읽거나 바꾸지 않았다).
  return ok({ writeIntent }, [], { entityType, entityId, fields: Object.keys(changes) });
}

export const updateRecordTool: AgentTool<UpdateRecordArgs, UpdateRecordData> = {
  name: "update_record",
  description:
    "캠페인·딜·거래처·셀러 기록의 칸을 화면에서 고치듯 고치는 기안을 올립니다. changes 에 칸 이름과 바꿀 값, " +
    "expected 에 같은 칸의 지금 보이는 값(비어 있으면 null, 날짜는 YYYY-MM-DD)을 넣어야 하며, 승인 시점의 " +
    "실제 값이 다르면 실행되지 않습니다. 칸 이름과 값 규칙은 그 엔티티의 화면 저장과 같습니다. " +
    "실제로 바꾸지 않고 승인 대기 기안만 만들며, 관리자가 직접 승인한 뒤에만 반영됩니다(자동 실행 없음).",
  inputSchema: updateRecordActionArgsSchema,
  execute,
};
