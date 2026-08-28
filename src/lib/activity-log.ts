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
    },
  });
}

/**
 * Records a CREATE entry in the ActivityLog table.
 */
export async function recordActivityCreate(
  entityType: ActivityEntityType,
  entityId: string,
  actor: string = "SYSTEM",
) {
  return getPrisma().activityLog.create({
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

export const FIELD_LABELS: Record<string, string> = {
  // 공통
  name: "이름",
  type: "유형",
  status: "상태",
  notes: "메모",
  
  // 파트너
  contactInfo: "연락처 정보",
  bankAccount: "계좌 정보",
  businessNumber: "사업자 번호",
  ceoName: "대표자명",
  address: "사업장 주소",
  bizSyncedAt: "사업자 정보 동기화",
  referredById: "추천인 ID",
  companyStatus: "납세자 상태",
  companyRole: "과세 유형",
  businessType: "업태",
  businessItem: "종목",
  representativeEmail: "대표이메일",
  
  // 셀러
  snsType: "SNS 유형",
  snsHandle: "SNS 핸들",
  currentFollowers: "팔로워 수",
  category: "카테고리",
  agencyId: "소속 에이전시 ID",
  channelUrl: "채널 URL",
  email: "이메일",
  phoneNumber: "전화번호",
  accountNumber: "정산 계좌번호",
  realName: "실명",
  mailingAddress: "주소",
  acquisitionChannel: "유입 경로",
  acquisitionNote: "유입 메모",
  availabilityNote: "가용 일정",
  availabilityUpdatedAt: "가용 일정 확인일",

  // 딜
  dealName: "딜 이름",
  brandName: "브랜드명",
  partnerCompanyName: "파트너 회사명",
  costPrice: "공급가",
  sellingPrice: "판매가",
  listPrice: "정가",
  floorPrice: "최저가",
  baseMarginPolicy: "기본 마진 정책",
  sourcingMemo: "소싱 메모",
  candidateSellers: "후보 셀러",
  partnerId: "파트너 ID",
  isDepositReceived: "정산 입금 여부",
  isPayoutCompleted: "정산 지급 여부",
  depositReceivedAt: "정산 입금 처리 일시",
  payoutCompletedAt: "정산 지급 처리 일시",
};

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
