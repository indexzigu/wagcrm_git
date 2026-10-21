/**
 * 대금 칸 날짜 판정 — 의존 없는 모듈. `tax-filing-board.ts` 에서 옮겨 왔고 그 파일이
 * 다시 내보낸다(기존 import 경로 유지).
 *
 * 따로 둔 이유: 셀러에게 가는 정산 명세서(`settlement-statement.ts`)도 정산 카드 칸과
 * **같은 날짜**를 실어야 하는데, `tax-filing-board.ts` 는 달별 계산서 모듈을 참조해서
 * 명세서가 그 파일을 import 하면 셀러 대면 격리 계약
 * (`seller-facing-monthly-settlement-isolation.contract.test.ts`)에 걸린다. 판정을 복제하지
 * 않고 공유하려면 이 함수가 그 의존 밖에 있어야 한다.
 */

/** 대금 칸 하나가 날짜를 읽는 세 필드 — `CampaignMoneySlot` 의 같은 이름 필드와 같은 값 범위. */
export type MoneySlotDateFields = {
  expectedField: "expectedDepositDate" | "expectedPayoutDate" | "expectedSupplierPayoutDate";
  completedAtField: "depositReceivedAt" | "payoutCompletedAt" | "supplierPayoutCompletedAt";
  flagField: "isDepositReceived" | "isPayoutCompleted" | "isSupplierPayoutCompleted";
};

/**
 * `payout` 칸(판정표 키)의 필드 — 채널과 무관하게 항상 이 셋이다. 상대는 채널이 정한다
 * (브랜드몰·자사몰 = 셀러, 셀러몰 = 공급사). 판정표와의 일치는 `money-slot-date.test.ts` 가 고정한다.
 */
export const PAYOUT_SLOT_DATE_FIELDS = {
  expectedField: "expectedPayoutDate",
  completedAtField: "payoutCompletedAt",
  flagField: "isPayoutCompleted",
} as const satisfies MoneySlotDateFields;

/**
 * 대금 칸 하나의 **날짜 근거** — 예정일·완료일·완료 플래그. 날짜 타입은 호출부가 정한다
 * (서버 경로는 `Date`, 페이로드 경로는 ISO 문자열) — 변환은 이 함수의 일이 아니다.
 */
export type MoneySlotDateSource<T extends string | Date = string | Date> = Partial<
  Record<MoneySlotDateFields["expectedField"] | MoneySlotDateFields["completedAtField"], T | null>
> &
  Partial<Record<MoneySlotDateFields["flagField"], boolean>>;

/**
 * 대금 칸이 **일정 표면에 서는 날짜** — 완료됐으면 실제로 오간 날, 아니면 예정일.
 *
 * 오너 지적(2026-07-15): *"20일이 지급예정인데 15일에 지급되었으면 예정일정은 캘린더에서
 * 없어지고 지급일정으로 변경돼야 하는 거 아니야?"* 돈이 실제로 오간 사건은 예정일이 아니라
 * 그날 일어난 것이므로, 완료된 칸을 예정일에 남겨 두면 캘린더가 **일어나지 않은 날의 사건**을
 * 그리게 된다.
 *
 * ⚠️ **이 규칙은 구글 캘린더가 먼저 갖고 있었다** — `syncMoneyEvents` 가 `완료일 ?? 예정일`
 * 로 이벤트를 옮기고 메모에 `(실제 지급 완료)` 를 달아 왔다(#459). 앱 안 표면(데스크톱
 * 캘린더 도트·모바일 일정탭 링·날짜 목록·홈 다가올 일정)만 예정일에 고정돼 있어서 **같은
 * 캠페인이 두 캘린더에서 다른 날에 떴다.** 그 사본을 여기로 모은다.
 *
 * ⛔ **소비처가 `slot.expectedField` 를 직접 읽지 말 것** — 그 순간 이 판정의 두 번째
 * 인코딩이 생기고, 표면마다 하나씩 빠뜨리면서 원래 상태로 되돌아간다(이 레포가 금액
 * 컬럼에서 이미 겪은 형태다). `money-slot-effective-date.contract.test.ts` 가 일정 표면을
 * 소스 스캔으로 막는다.
 *
 * **완료의 정본은 플래그다**(`resolveSettlementCompletionFlags` 와 같은 축). 쓰기 경로
 * (`resolveSettlementSync`)가 완료 취소 시 완료일을 함께 지우므로 둘이 어긋난 행은 생기지
 * 않지만, 판정 기준을 하나로 못 박아 둔다.
 *
 * ⛔ **완료인데 완료일이 비어 있다고 날짜를 `null` 로 만들지 말 것** — 완료일 컬럼이 없던
 * 시절의 행과 그룹 스칼라가 비어 있는 행이 실재한다. 그것들이 캘린더에서 통째로 사라지면
 * 크래시 없는 침묵형 소실이라 아무도 모른다. 예정일에 그대로 남긴다.
 */
export function resolveMoneySlotEffectiveDate<T extends string | Date>(
  slot: MoneySlotDateFields,
  source: MoneySlotDateSource<T>,
): { date: T | null; isActual: boolean } {
  const completed = source[slot.flagField] ? source[slot.completedAtField] ?? null : null;
  if (completed) return { date: completed, isActual: true };
  return { date: source[slot.expectedField] ?? null, isActual: false };
}
