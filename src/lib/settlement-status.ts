/**
 * 정산 상태기계 (Phase 5 HITL WRITE — confirm_settlement 청사진 §2).
 *
 * SalesCampaign의 정산 완료 플래그가 만드는 상태를 pending/confirmed/paid로 라벨링하고,
 * 에이전트 도구(confirm_settlement)가 상태를 전진시킬 때의 유효성(전진 전용)과 status
 * 자동전이를 순수 함수로 제공한다.
 *
 * ⛔ **어느 플래그가 이 채널의 정산을 구성하는지는 이 파일이 정하지 않는다** —
 * `resolveCampaignMoneySlots`(슬롯 SSOT)가 정한다. 종전 이 모듈은 「입금 → 지급」 두
 * 플래그를 상수처럼 박아 뒀고, 2026-08-25 에 자사몰이 [공급사 지급, 셀러 지급]로 바뀌면서
 * 세 함수가 전부 같은 이유로 어긋났다(입금 플래그가 영원히 false 라 상태가 pending 에
 * 고정되고 전진 검증이 항상 거부했다).
 *
 * 범위(청사진 §2, plan-critic #5): 이 모듈은 write-executor가 READ 도구/리포트와
 * "동일한 정산 상태 판정 함수(deriveSettlementState)"를 공유하도록 하는 코드 이동이다.
 * campaignService 등의 인라인 파생까지 통합하는 전면 단일 진실원천은 목표가 아니다.
 *
 * status 자동전이(computeAutoStatus)는 정본 토글 경로
 * (src/app/api/campaigns/[id]/settlement-status/route.ts:60-67)의 로직을 그대로
 * 미러링한다 — 에이전트 경로와 버튼 경로가 동일한 최종 상태를 만들도록 하기 위함.
 */

import { resolveCampaignMoneySlots, resolveSettlementCompletionFlags } from "./tax-filing-board";

/** 캠페인별 정산 상태 라벨. 채널 슬롯 순서의 완료 진척도에서 파생. */
export type SettlementStateLabel = "pending" | "confirmed" | "paid";

/**
 * confirm_settlement 가 전진시킬 대상 축.
 *
 * ⚠️ **자사몰의 공급사 지급 레그는 일부러 여기 없다.** 그 레그에는 담을 금액 컬럼이 없어
 * (표시·게이트가 함께 읽는 `settlementSales`·`actualPayoutAmount` 는 각각 **입금 축**과
 * **셀러 지급 축**이라 어느 쪽도 공급사 지급액이 아니다) 아래 write-executor 의
 * **금액 무결성 하드 게이트**(security-reviewer H1 — 금액 미입력·0 이하 확정 거부)를
 * 만족시킬 방법이 없다. 게이트를 자사몰만 면제하면 LLM 기안 경로에서 「유령 완료」를
 * 막는 장치가 그 채널에서만 사라진다. 공급사 지급은 사람이 금액을 보며 누르는 **버튼
 * 경로(정산 카드 체크박스) 소유**로 남긴다 — 아래 `isValidSettlementAction` 은 그 레그의
 * 완료 여부를 **선행 조건으로 읽기만** 한다.
 *
 * ℹ️ 표시(캘린더·대시보드)와 이 쓰기 게이트는 **같은 두 컬럼**을 읽는다(2026-08-25 통일).
 * 컬럼 선택 근거와 죽은 컬럼 이력은 `calendar-entities.MONEY_AMOUNT_FIELD` 주석이 정본이다.
 * ⛔ 한쪽만 옛 컬럼으로 되돌리지 말 것 — 그 어긋남이 게이트를 조용히 영구 차단했다.
 */
export type SettlementTarget = "deposit" | "payout";

/** `SettlementTarget` → 완료 플래그 필드. 슬롯의 `flagField` 어휘와 같은 축이다. */
const TARGET_FLAG: Record<SettlementTarget, keyof SettlementCompletionFlags> = {
  deposit: "isDepositReceived",
  payout: "isPayoutCompleted",
};

/**
 * 슬롯 라벨("공급사 지급" 등) — 사유 문구가 채널마다 정확한 상대를 말하도록.
 * ⛔ 문자열을 손으로 조립하지 말 것: 상대·동사 모두 슬롯이 소유한다.
 */
function slotLabel(salesChannel: string, flagField: keyof SettlementCompletionFlags): string {
  const slot = resolveCampaignMoneySlots(salesChannel).find((s) => s.flagField === flagField);
  return slot ? `${slot.counterpartLabel} ${slot.verb}` : "정산";
}

/**
 * 정산 상태 라벨을 **채널 슬롯 순서**에서 파생한다.
 *
 * - 마지막 레그(그 채널의 최종 지급) 완료 → `paid`
 * - 선행 레그 중 하나라도 완료 → `confirmed`
 * - 그 외 → `pending`
 *
 * 브랜드몰·셀러몰은 슬롯이 [입금, 지급]이라 종전 식(`지급 완료 → paid`, `입금 → confirmed`)과
 * **바이트 단위로 같은 결과**를 낸다. 바뀌는 것은 자사몰뿐이다 — 슬롯이 [공급사 지급,
 * 셀러 지급]이라 종전 코드에서는 `isDepositReceived` 가 영원히 false 여서 `confirmed`
 * 단계가 아예 존재할 수 없었다(공급사에게 지급을 마쳐도 화면은 「예정」이었다).
 */
export function deriveSettlementState(campaign: {
  salesChannel: string;
} & SettlementCompletionFlags): SettlementStateLabel {
  const legs = resolveSettlementCompletionFlags(campaign.salesChannel);
  if (legs.length === 0) return "pending";
  if (campaign[legs[legs.length - 1]]) return "paid";
  if (legs.slice(0, -1).some((flag) => campaign[flag])) return "confirmed";
  return "pending";
}

/**
 * 정산 상태를 target 방향으로 전진시키는 것이 유효한지 검증한다(전진 전용).
 * 판정 축은 **채널 슬롯 순서**다 — 역행·중복·건너뛰기를 모두 거부한다.
 *
 * 브랜드몰·셀러몰(슬롯 [입금, 지급])에서는 종전과 동일하다:
 *   pending  + deposit → OK · pending + payout → 거부(입금 선행)
 *   confirmed + deposit → 거부(이미 완료) · confirmed + payout → OK
 *   최종 레그 완료 → 무엇이든 거부
 *
 * 자사몰(슬롯 [공급사 지급, 셀러 지급])에서는:
 *   - `deposit` → **거부**(이 채널엔 입금 절차가 없다). 종전에는 이 검증을 통과해
 *     아무 의미 없는 `isDepositReceived` 를 켜고, 그 값이 데이터 점검·모바일 순차
 *     게이트에 흘러들었다.
 *   - `payout`(= 셀러 지급) → 공급사 지급이 선행돼야 OK. 종전에는 `isDepositReceived`
 *     가 영원히 false 라 **어시스턴트로는 자사몰 지급 완료를 아예 못 했다**(오너 확정
 *     2026-08-25: 슬롯 순서로 일반화).
 */
export function isValidSettlementAction(
  campaign: { salesChannel: string } & SettlementCompletionFlags,
  target: SettlementTarget,
): { ok: true } | { ok: false; reason: string } {
  const legs = resolveSettlementCompletionFlags(campaign.salesChannel);
  const targetFlag = TARGET_FLAG[target];

  // 최종 레그가 이미 끝났으면 이 정산은 종결이다 — 앞 레그 보정도 이 함수로 하지 않는다
  // (전진 전용 계약, 종전 `state === "paid"` 분기와 같은 자리).
  if (legs.length > 0 && campaign[legs[legs.length - 1]]) {
    return { ok: false, reason: "이미 지급 완료된 정산입니다. 더 이상 전진할 수 없습니다." };
  }

  const index = legs.indexOf(targetFlag);
  if (index < 0) {
    return {
      ok: false,
      reason: `이 판매채널에는 ${target === "deposit" ? "입금 확정" : "지급 완료"} 절차가 없습니다.`,
    };
  }
  if (campaign[targetFlag]) {
    return { ok: false, reason: `이미 ${target === "deposit" ? "입금 확정" : "지급 완료"}된 정산입니다.` };
  }

  const blocking = legs.slice(0, index).filter((flag) => !campaign[flag]);
  if (blocking.length > 0) {
    const names = blocking.map((flag) => slotLabel(campaign.salesChannel, flag)).join(" · ");
    return { ok: false, reason: `${names} 완료가 선행되어야 처리할 수 있습니다.` };
  }
  return { ok: true };
}

/** 채널별 완료 판정에 들어가는 세 플래그의 스냅샷(pre-write 기준 새 값). */
export type SettlementCompletionFlags = {
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  isSupplierPayoutCompleted: boolean;
};

/**
 * status 자동전이를 계산한다(순수 함수) — **이 함수가 세 쓰기 경로(PATCH 본 라우트 ·
 * settlement-status 토글 · 에이전트 confirm_settlement)의 유일한 판정이다.**
 * pre-write 스냅샷(prevStatus + 새 플래그 값)에서 평가해야 한다(plan-critic Minor 1).
 *
 * 요구 플래그 집합은 채널이 정한다(`resolveSettlementCompletionFlags`, 슬롯 SSOT):
 * 자사몰 = [공급사 지급, 셀러 지급](입금 칸 없음 — 몰 정산금이 일별 입금이라 실효 없음,
 * 오너 확정 2026-08-25), 그 외 채널 = [입금, 지급](현행 유지).
 *   - 요구 플래그 전부 true → "COMPLETED"
 *   - 일부만 true 인데 이전 status가 "COMPLETED"였다면 → "SETTLEMENT_WAIT" (강등)
 *   - 그 외 → undefined (status 무변경)
 *
 * ⛔ 호출부가 `입금 && 지급` 을 다시 손으로 쓰지 말 것 — 자사몰 완료가 표면마다 갈린다.
 */
export function computeAutoStatus(
  prevStatus: string | null | undefined,
  salesChannel: string,
  flags: SettlementCompletionFlags,
): string | undefined {
  const legs = resolveSettlementCompletionFlags(salesChannel).map((flag) => flags[flag]);
  if (legs.every(Boolean)) {
    return "COMPLETED";
  }
  if (legs.some(Boolean) && prevStatus === "COMPLETED") {
    return "SETTLEMENT_WAIT";
  }
  return undefined;
}
