import { getPrisma } from "./prisma";
import type { Prisma } from "@prisma/client";

export type ActivityEntityType = "PARTNER" | "SELLER" | "DEAL" | "CAMPAIGN";
export type ActivityType = "CHANGE" | "CREATE" | "DELETE" | "MEMO";

function stringifyActivityValue(value: unknown): string | null {
  return value == null ? null : String(value);
}

/**
 * Records a CHANGE entry in the ActivityLog table.
 *
 * Phase 5(HITL 쓰기 §0-4): optional tx를 받으면 호출부가 이미 열어둔 인터랙티브
 * 트랜잭션 안에서 쓴다 — write-executor가 딜 상태 변경(change_deal_status)과
 * ActionProposal의 APPROVED→EXECUTED 전이를 하나의 원자적 트랜잭션으로 묶을 수
 * 있게 하기 위함이다(recordActivityMemo와 동일 패턴). tx를 넘기지 않는 기존
 * 호출부는 지금까지와 동일하게 getPrisma()를 사용한다(동작 변화 없음 — 순수
 * 추가 파라미터).
 */
export async function recordActivityChange(
  entityType: ActivityEntityType,
  entityId: string,
  fieldName: string,
  previousValue: unknown,
  newValue: unknown,
  actor: string = "SYSTEM",
  tx?: Prisma.TransactionClient,
  /**
   * 변경 사유(선택). 인수인계 CHANGE 가 `content` 에 메모를 싣는 것과 같은 칸이다 —
   * 에이전트 정산 금액 수정(`update_settlement_amount`)이 기안 메모를 여기 남긴다.
   * 생략하면 종전과 같은 행이 써진다(순수 추가 파라미터).
   */
  content?: string | null,
) {
  const client = tx ?? getPrisma();
  return client.activityLog.create({
    data: {
      entityType,
      entityId,
      type: "CHANGE",
      fieldName,
      previousValue: stringifyActivityValue(previousValue),
      newValue: stringifyActivityValue(newValue),
      actor,
      ...(content ? { content } : {}),
    },
  });
}

/**
 * Records a CREATE entry in the ActivityLog table.
 *
 * recordActivityChange/recordActivityMemo와 같은 optional tx 파라미터를 받는다 —
 * write-executor의 생성 액션(create_partner/create_deal)이 엔티티 INSERT와 생성 기록을
 * 한 트랜잭션으로 묶기 위함이다. tx 없이 부르면 그 기록은 롤백돼도 남아, 존재하지 않는
 * 엔티티의 생성행이 감사 로그에 남는다. tx를 넘기지 않는 기존 호출부는 지금까지와 동일
 * (동작 변화 없음 — 순수 추가 파라미터).
 */
export async function recordActivityCreate(
  entityType: ActivityEntityType,
  entityId: string,
  actor: string = "SYSTEM",
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? getPrisma();
  return client.activityLog.create({
    data: {
      entityType,
      entityId,
      type: "CREATE",
      actor,
    },
  });
}

/**
 * Records a DELETE entry in the ActivityLog table.
 */
export async function recordActivityDelete(
  entityType: ActivityEntityType,
  entityId: string,
  actor: string = "SYSTEM",
) {
  return getPrisma().activityLog.create({
    data: {
      entityType,
      entityId,
      type: "DELETE",
      actor,
    },
  });
}

/**
 * Records a MEMO entry in the ActivityLog table.
 *
 * Phase 5(HITL 쓰기 §0-4): optional tx를 받으면 호출부가 이미 열어둔 인터랙티브
 * 트랜잭션 안에서 쓴다 — write-executor가 이 메모 기록과 ActionProposal의
 * APPROVED→EXECUTED 전이를 하나의 원자적 트랜잭션으로 묶을 수 있게 하기 위함이다.
 * tx를 넘기지 않는 기존 호출부는 지금까지와 동일하게 getPrisma()를 사용한다
 * (동작 변화 없음 — 순수 추가 파라미터).
 */
export async function recordActivityMemo(
  entityType: ActivityEntityType,
  entityId: string,
  content: string,
  actor: string = "SYSTEM",
  tx?: Prisma.TransactionClient,
) {
  const client = tx ?? getPrisma();
  return client.activityLog.create({
    data: {
      entityType,
      entityId,
      type: "MEMO",
      content,
      actor,
    },
  });
}

// 표는 클라이언트도 읽는다(결재함 기안 미리보기) — 서버 전용인 이 모듈 대신 `field-labels.ts` 가 소유한다.
export { FIELD_LABELS } from "./field-labels";

/**
 * Decimal 및 복잡한 객체 비교를 위한 직렬화 비교 헬퍼
 */
export function getCompareValue(value: unknown): string {
  if (value == null) return "";
  
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Decimal 객체 및 toString 제공 객체 대응
  if (
    typeof value === "object" &&
    value !== null &&
    "toString" in value &&
    typeof (value as Record<string, unknown>).toString === "function" &&
    (value.constructor.name === "Decimal" || (value as Record<string, unknown>).d !== undefined)
  ) {
    return (value as Record<string, unknown>).toString() as string;
  }

  if (typeof value === "object" && value !== null) {
    try {
      // JSON 객체 정렬화 및 직렬화 비교
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  return String(value);
}
