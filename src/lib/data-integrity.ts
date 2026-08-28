// 휴먼에러 게이트 (GROWTH_FLYWHEEL_PLAN.md §F5) — 정산·매출 데이터의 명백한 정합성 오류를
// 감지해 대시보드에 '확인 필요'로 표면화한다. 소유자 목표: "쫓기며 발생하는 휴먼에러 감소".
//
// 원칙: 오탐(false positive) 제로. actualSales vs 주문 집계의 퍼지 비교는 반품·정산 차이로
// 정당한 편차가 생기므로 쓰지 않는다. 대신 도메인상 "있으면 무조건 사람이 손봐야 하는" 명백한
// 신호만 잡는다 — 기존 desktop-dashboard가 이미 quality로 세던(그러나 화면에 안 보여주던)
// 두 신호 + 논리적으로 불가능한 값(음수).

import { resolveCampaignMoneySlots } from "./tax-filing-board";
import { resolveSettlementStartOverdue } from "./settlement-stage";
import type { SettlementCompletionFlags } from "./settlement-status";

export type IntegrityCampaign = {
  id: string;
  campaignName: string | null;
  dealName: string;
  sellerName: string;
  sellerAlias: string | null;
  endDate: Date | string;
  /**
   * 반품기간 종료일 — 「정산 착수 지연」의 기준일. 미지정(구 호출부)은 판매 종료
   * +14일로 떨어진다(`resolveSettlementStartDueDate`). 실측상 이 컬럼이 채워진
   * 캠페인이 드물어서 **폴백이 판정의 본류**다.
   */
  returnPeriodEndDate?: Date | string | null;
  actualSales: number | null;
  status: string;
  isDepositReceived: boolean;
  isPayoutCompleted: boolean;
  /**
   * 자사몰 공급사 지급 레그. 미지정(구 호출부)은 false 로 본다 — 다른 채널에서는 애초에
   * 완료 판정 집합에 들어가지 않으므로 값이 없어도 판정이 바뀌지 않는다.
   */
  isSupplierPayoutCompleted?: boolean;
  /**
   * 완료 판정에 **어느 플래그가 들어가는지**를 정하는 채널.
   * 미지정(구 호출부)은 판정표의 기본 갈래(셀러몰 = 입금+지급)로 떨어져 종전과 같다.
   */
  salesChannel?: string | null;
  /** CG-1 그룹 멤버십 — 미지정(구 호출부)은 미그룹으로 취급 */
  groupId?: string | null;
  group?: {
    name: string | null;
    isDepositReceived: boolean;
    isPayoutCompleted: boolean;
    isSupplierPayoutCompleted?: boolean;
  } | null;
};

export type IntegrityIssueType =
  | "MISSING_SALES"
  | "SETTLEMENT_INCOMPLETE"
  | "SETTLEMENT_NOT_STARTED"
  | "NEGATIVE_SALES";

export type IntegrityIssue = {
  campaignId: string;
  campaignName: string; // alias 우선 표기 완료
  type: IntegrityIssueType;
  label: string; // 사람이 읽는 문제 설명
};

// 심각도: 금전 이상(NEGATIVE) > 상태 불일치(SETTLEMENT_INCOMPLETE)
//         > 절차 미착수(SETTLEMENT_NOT_STARTED) > 누락(MISSING)
//
// 미착수가 불일치보다 한 단 아래인 이유: 불일치는 **이미 완료로 기록된 거짓말**이라
// 장부가 틀린 상태이고, 미착수는 아직 시작을 안 했을 뿐 기록은 정직하다.
const SEVERITY: Record<IntegrityIssueType, number> = {
  NEGATIVE_SALES: 0,
  SETTLEMENT_INCOMPLETE: 1,
  SETTLEMENT_NOT_STARTED: 2,
  MISSING_SALES: 3,
};

function displayName(c: IntegrityCampaign): string {
  const seller = c.sellerAlias && c.sellerAlias.trim() !== "" ? c.sellerAlias : c.sellerName;
  const raw = c.campaignName && c.campaignName.trim() !== "" ? c.campaignName : `${c.dealName} - ${seller}`;
  return raw.replace(/ · /g, " - ");
}

function toDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * 「반품기간까지 끝났는데 정산 단계로 안 넘어왔다」 라벨. 판정 자체는
 * `settlement-stage.resolveSettlementStartOverdue`(SSOT)가 하고 여기선 문구만 만든다 —
 * ⛔ 상태 목록·경과일 계산을 여기서 다시 쓰지 말 것.
 */
function settlementNotStartedLabel(daysOverdue: number, memberCount: number): string {
  // 형태를 형제 라벨과 맞춘다 — `본문(멤버 N건)`, 괄호는 접미사 자리 하나뿐.
  // ⛔ 본문에 괄호를 다시 넣지 말 것: 초판이 `…(22일 경과)(멤버 2건)` 으로 괄호 두 쌍을
  //    붙여 오타처럼 읽혔다(ss-ux 지적). 경과일은 괄호 없이 본문에 둔다.
  // ⚠️ **길이가 이 라벨의 제약이다.** 소비 행(`data-integrity-card` · `mobile-home-risk-card`)은
  //    라벨 쪽 컨테이너가 `shrink-0` 이고 `truncate` 는 캠페인명에만 걸려 있다 — 라벨이 길수록
  //    **어느 캠페인인지가 대신 잘린다.** 형제 최장 라벨(`정산완료 처리됐으나 셀러 지급 미확인`)
  //    보다 길어지지 않게 유지할 것.
  const suffix = memberCount > 1 ? `(멤버 ${memberCount}건)` : "";
  return `반품기간 종료 ${daysOverdue}일 경과, 정산 미착수${suffix}`;
}

function groupLabel(members: IntegrityCampaign[]): string {
  const storedName = members[0].group?.name;
  if (storedName && storedName.trim() !== "") return storedName;
  return members.length > 1
    ? `${displayName(members[0])} 외 ${members.length - 1}건`
    : displayName(members[0]);
}

/**
 * 정산 완료 상태-플래그 불일치 판정 — **요구 플래그 집합은 채널이 정한다**
 * (`resolveSettlementCompletionFlags`, 슬롯 SSOT).
 *
 * ⛔ `!입금 || !지급` 으로 되돌리지 말 것. 자사몰은 2026-08-25 부터 완료 집합이
 * [공급사 지급, 셀러 지급]이고 **입금 플래그는 영원히 false** 다 — 그 식이면 정상적으로
 * 완료된 자사몰 캠페인이 전부 「입금 미확인」으로 데이터 점검 카드에 상주한다(오탐이
 * 매일 뜨면 카드 자체가 무시당한다). 라벨의 상대 병기도 같은 이유다: 자사몰은 미완
 * 레그가 둘 다 「지급」이라 상대 없이는 어느 쪽인지 말할 수 없다.
 */
function settlementIncomplete(
  campaign: { salesChannel?: string | null } & SettlementCompletionFlags,
): { incomplete: true; label: string } | { incomplete: false } {
  const slots = resolveCampaignMoneySlots(campaign.salesChannel ?? "");
  const missing = slots.filter((slot) => !campaign[slot.flagField]);
  if (missing.length === 0) return { incomplete: false };
  const parts = missing.map((slot) => `${slot.counterpartLabel} ${slot.verb}`);
  return { incomplete: true, label: `정산완료 처리됐으나 ${parts.join("·")} 미확인` };
}

/**
 * 명백한 정합성 오류 목록. 한 캠페인이 복수 문제를 가지면 각각 별도 항목으로 낸다.
 * 심각도 → 캠페인명 순 정렬.
 *
 * 그룹캠페인(CG-1)은 실캠페인 1개의 딜별 분할이므로 멤버별 이슈를 그대로 나열하면
 * 같은 실물 문제 하나가 멤버 수만큼 부풀려진다 — (그룹, 유형)당 1건으로 접는다:
 * - 매출 유형(음수·미입력)은 딜 고유 값이라 판정은 멤버 단위, 표시만 그룹 1건
 *   (해당 멤버 수를 라벨에 병기). campaignId는 첫 해당 멤버.
 * - 정산 플래그 유형은 플래그의 SoT가 그룹이라 판정 자체를 그룹 플래그로 한다
 *   (멤버 낡은 플래그로 인한 오탐 방지).
 */
export function computeDataIntegrityIssues(
  campaigns: IntegrityCampaign[],
  now: Date = new Date()
): IntegrityIssue[] {
  const ref = now.getTime();
  const issues: IntegrityIssue[] = [];

  const grouped = new Map<string, IntegrityCampaign[]>();
  for (const c of campaigns) {
    if (c.groupId != null) {
      const members = grouped.get(c.groupId);
      if (members) members.push(c);
      else grouped.set(c.groupId, [c]);
      continue;
    }
    const name = displayName(c);

    // 1) 음수 매출 — 논리적으로 불가능한 입력 (오타·부호 오류)
    if (c.actualSales != null && c.actualSales < 0) {
      issues.push({ campaignId: c.id, campaignName: name, type: "NEGATIVE_SALES", label: "매출이 음수로 입력됨" });
    }

    // 2) 종료됐는데 매출 미입력 — 마감 후 실매출을 아직 안 넣음(입력 누락)
    //    (종료일이 지난 캠페인만; 아직 진행 중이면 미입력이 정상)
    if (c.actualSales == null && toDate(c.endDate).getTime() < ref) {
      issues.push({ campaignId: c.id, campaignName: name, type: "MISSING_SALES", label: "종료됐으나 실매출 미입력" });
    }

    // 3) 판매도 반품기간도 끝났는데 아직 정산 단계가 아님 — 절차 미착수(T-062)
    const startVerdict = resolveSettlementStartOverdue(c, now);
    if (startVerdict.overdue) {
      issues.push({
        campaignId: c.id,
        campaignName: name,
        type: "SETTLEMENT_NOT_STARTED",
        label: settlementNotStartedLabel(startVerdict.daysOverdue, 1),
      });
    }

    // 4) 정산 완료 처리했는데 채널이 요구하는 대금 레그가 미완 — 상태-플래그 불일치
    if (c.status === "COMPLETED") {
      const verdict = settlementIncomplete({
        salesChannel: c.salesChannel,
        isDepositReceived: c.isDepositReceived,
        isPayoutCompleted: c.isPayoutCompleted,
        isSupplierPayoutCompleted: c.isSupplierPayoutCompleted ?? false,
      });
      if (verdict.incomplete) {
        issues.push({
          campaignId: c.id,
          campaignName: name,
          type: "SETTLEMENT_INCOMPLETE",
          label: verdict.label,
        });
      }
    }
  }

  for (const members of grouped.values()) {
    const name = groupLabel(members);

    const negative = members.filter((m) => m.actualSales != null && m.actualSales < 0);
    if (negative.length > 0) {
      issues.push({
        campaignId: negative[0].id,
        campaignName: name,
        type: "NEGATIVE_SALES",
        label: negative.length > 1 ? `매출이 음수로 입력됨(멤버 ${negative.length}건)` : "매출이 음수로 입력됨",
      });
    }

    const missing = members.filter((m) => m.actualSales == null && toDate(m.endDate).getTime() < ref);
    if (missing.length > 0) {
      issues.push({
        campaignId: missing[0].id,
        campaignName: name,
        type: "MISSING_SALES",
        label:
          missing.length > 1 ? `종료됐으나 실매출 미입력(멤버 ${missing.length}건)` : "종료됐으나 실매출 미입력",
      });
    }

    // 착수 지연은 상태·일정이 **멤버 컬럼**에 산다(그룹 스칼라에 status 가 없다) —
    // 매출 유형과 같은 규약으로 멤버 단위 판정 + 표시만 그룹 1건이다. 대표는 가장 오래
    // 밀린 멤버를 고른다(가장 급한 숫자가 라벨에 서야 목록 정렬이 뜻을 갖는다).
    const notStarted = members
      .map((m) => ({ member: m, verdict: resolveSettlementStartOverdue(m, now) }))
      .filter(
        (x): x is { member: IntegrityCampaign; verdict: { overdue: true; dueDate: Date; daysOverdue: number } } =>
          x.verdict.overdue,
      )
      .sort((a, b) => b.verdict.daysOverdue - a.verdict.daysOverdue);
    if (notStarted.length > 0) {
      issues.push({
        campaignId: notStarted[0].member.id,
        campaignName: name,
        type: "SETTLEMENT_NOT_STARTED",
        label: settlementNotStartedLabel(notStarted[0].verdict.daysOverdue, notStarted.length),
      });
    }

    // 정산 플래그는 그룹이 SoT — 그룹 스칼라가 없으면(구 호출부) 첫 멤버 값으로 폴백.
    const completed = members.filter((m) => m.status === "COMPLETED");
    if (completed.length > 0) {
      const group = members[0].group;
      const verdict = settlementIncomplete({
        // 채널은 대표 멤버 것 — 그룹은 딜 분할이라 실무상 같고, 그룹 스칼라에는 채널이 없다.
        salesChannel: completed[0].salesChannel,
        isDepositReceived: group?.isDepositReceived ?? completed[0].isDepositReceived,
        isPayoutCompleted: group?.isPayoutCompleted ?? completed[0].isPayoutCompleted,
        isSupplierPayoutCompleted:
          group?.isSupplierPayoutCompleted ?? completed[0].isSupplierPayoutCompleted ?? false,
      });
      if (verdict.incomplete) {
        issues.push({
          campaignId: completed[0].id,
          campaignName: name,
          type: "SETTLEMENT_INCOMPLETE",
          label: verdict.label,
        });
      }
    }
  }

  return issues.sort(
    (a, b) => SEVERITY[a.type] - SEVERITY[b.type] || a.campaignName.localeCompare(b.campaignName, "ko")
  );
}
