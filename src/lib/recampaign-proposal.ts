// F1 기안 연결 (GROWTH_FLYWHEEL_PLAN.md §F1 Phase B) — 재캠페인 적기 알림(읽기 전용)을
// 승인 기반 ActionProposal(기안)으로 승격한다. 승인함에서 승인하면 셀러에 재접촉 결정이
// 메모로 기록되고(add_entity_memo — 화이트리스트 WRITE), 거부하면 dismiss된다.
//
// 왜 메모 write인가: F1의 완성형(이 셀러에게 '이 딜'을 다시 제안)은 딜 매칭(F4/Phase C)이
// 선행돼야 한다. 그 전까지는 '재접촉 검토' 결정을 감사 가능한 형태로 남기는 것이 안전한 최소
// 실행이다. 딜 매칭 완성 시 payload.action을 outreach 생성으로 승격한다.
//
// 정밀도-재현율(승인함 마비) 가드: DUE(적기 도래)만 기안 대상 + 아래 dedup 키로 중복 차단.

import { MATCH_REASON_LABEL, type MatchReason } from "./deal-seller-matching";
import { parseStoredJsonObject } from "./stored-json";
import type { RecampaignAlert } from "./recampaign-timing";

export const RECAMPAIGN_REQUEST_TYPE = "recampaign_suggestion";

// ---------------------------------------------------------------------------
// 중복 제거 키 — 멱등성 4종 세트 ②
// ---------------------------------------------------------------------------

/**
 * 기안 사유 코드. 딜 매칭의 사유(`MatchReason`)에 **케이던스 카드 전용 코드 하나**를 더한
 * 것이다 — 두 생산 경로가 서로 다른 질문에 답하므로 사유가 겹치지 않는다.
 *   · `CADENCE_DUE` : 재캠페인 적기 카드(개인 케이던스, 딜 무관)
 *   · `MatchReason` : 딜↔셀러 양방향 검토(특정 딜과의 조합)
 */
export type ProposalReason = MatchReason | "CADENCE_DUE";

/**
 * 사유가 기록돼 있지 않은 **레거시 행**의 해석.
 *
 * ⚠️ 이 폴백이 없으면 회귀가 난다 — 딜 축 도입 이전에 만들어진 열린 기안은
 * `structuredResult` 에 `reason` 이 없고, 그걸 "사유 미상"으로 흘려보내면 같은 셀러에
 * 케이던스 기안이 **한 건 더** 생긴다(dedup 을 넓히려다 오히려 뚫리는 경우).
 */
export const LEGACY_PROPOSAL_REASON: ProposalReason = "CADENCE_DUE";

/**
 * 중복 제거 키 — **`셀러id + 사유코드 + 딜id`**.
 *
 * 🔴 종전 키는 `셀러id` 단독이었고, 딜 차원이 들어오는 순간 **과차단**이 된다("이 셀러에
 * 열린 기안이 있음" 하나로 서로 다른 딜 제안이 전부 막힌다). 딜이 없는 케이던스 기안은
 * `-` 로 자리를 채워, 딜 기안과 서로를 막지 않는다.
 *
 * ⚠️ **상태 스코프가 있는 dedup 이라 DB 유니크 제약으로 만들 수 없다** — 같은 조합이라도
 * 3개월 뒤에는 다시 기안돼야 하므로 "열린 기안" 안에서만 유일해야 한다. 그래서 호출부가
 * 열린 행을 조회해 이 키로 비교한다(`targetEntityType, targetEntityId` 인덱스가 받쳐준다).
 */
export function buildProposalDedupeKey(input: {
  sellerId: string;
  reason: ProposalReason;
  dealId: string | null;
}): string {
  return `${input.sellerId}|${input.reason}|${input.dealId ?? "-"}`;
}

/** 열린 기안 행에서 dedup 키를 복원한다. 셀러가 없는 행은 이 계열이 아니므로 null. */
export function readProposalDedupeKey(row: {
  targetEntityId: string | null;
  structuredResult: unknown;
}): string | null {
  if (!row.targetEntityId) return null;
  const result = parseStoredJsonObject(row.structuredResult);
  const reason =
    typeof result.reason === "string" ? (result.reason as ProposalReason) : LEGACY_PROPOSAL_REASON;
  const dealId = typeof result.dealId === "string" ? result.dealId : null;
  return buildProposalDedupeKey({ sellerId: row.targetEntityId, reason, dealId });
}

/** 승인함/메모에 보일 사람이 읽는 본문. add_entity_memo content 상한(4000자) 훨씬 이내. */
export function buildRecampaignMemoContent(alert: RecampaignAlert): string {
  const overdue = alert.daysUntilDue <= 0 ? `${-alert.daysUntilDue}일 경과` : `${alert.daysUntilDue}일 후 도래`;
  const base =
    `재캠페인 적기 검토: 지난 ${alert.runCount}회 캠페인, 케이던스 ${alert.medianIntervalDays}일 주기, ` +
    `마지막 캠페인 시작 후 ${overdue}.`;
  const avail = alert.availabilityNote ? ` 가용 일정: ${alert.availabilityNote}.` : "";
  return `${base}${avail} 다음 딜 제안을 검토하세요.`;
}

export function buildRecampaignProposalTitle(alert: RecampaignAlert): string {
  const overdue = alert.daysUntilDue <= 0 ? `${-alert.daysUntilDue}일 경과` : `${alert.daysUntilDue}일 후`;
  return `재캠페인 적기: ${alert.sellerName} (${overdue})`;
}

/**
 * DUE 알림 하나를 ActionProposal 생성 입력으로 변환한다.
 * kind=WRITE + status=PENDING_APPROVAL이므로 반드시 승인 절차를 거친다(canTransition 정책).
 * createdBy는 "SYSTEM"(휴리스틱 감지) — 사람 승인자와 달라 self-approval 게이트를 통과한다.
 */
export function buildRecampaignProposalInput(alert: RecampaignAlert) {
  const content = buildRecampaignMemoContent(alert);
  return {
    requestType: RECAMPAIGN_REQUEST_TYPE,
    kind: "WRITE",
    status: "PENDING_APPROVAL",
    title: buildRecampaignProposalTitle(alert),
    resultSummary: content,
    reviewRequired: true,
    createdBy: "SYSTEM",
    targetEntityType: "SELLER",
    targetEntityId: alert.sellerId,
    structuredResult: {
      // dedup 키의 두 축을 여기에 남긴다 — `readProposalDedupeKey` 가 읽는 자리다.
      reason: "CADENCE_DUE" satisfies ProposalReason,
      dealId: null,
      cadenceDays: alert.medianIntervalDays,
      runCount: alert.runCount,
      lastStartDate: alert.lastStartDate,
      dueDate: alert.dueDate,
      daysUntilDue: alert.daysUntilDue,
      availabilityNote: alert.availabilityNote,
    },
    payload: {
      action: "add_entity_memo",
      args: {
        entityType: "SELLER",
        entityId: alert.sellerId,
        content,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 딜 스코프 기안 (D2 2단계) — "이 셀러에게 **이 딜**"
// ---------------------------------------------------------------------------

/**
 * 딜 매칭 후보 하나를 기안 입력으로 만든다.
 *
 * 위 케이던스 기안과 갈라 두는 이유: 저쪽은 "평소 주기가 돌아왔다"까지만 말할 수 있어
 * 메모가 *"다음 딜 제안을 검토하세요"* 로 끝난다(딜을 특정하지 못한다). 이쪽은 딜이
 * 정해져 있어 승인 시 남는 결정 기록이 실행 가능한 문장이 된다 —
 * `recampaign-proposal` 초판 주석이 적어둔 "F1 의 완성형"이 이것이다.
 */
export type DealMatchProposalInput = {
  sellerId: string;
  /** alias 우선 표기 (P2) */
  sellerName: string;
  dealId: string;
  dealName: string;
  reason: MatchReason;
  /** D3 부스터 — 쌍 매출이 문턱 이상 */
  priority: boolean;
  pairRunCount: number | null;
  /** 이 조합의 마지막 진행 이후 경과일. 접점이 없으면 null */
  pairDaysSinceLastRun: number | null;
  /** null = 매출 미입력(판정 보류). **0 으로 대체하지 말 것** */
  pairSalesTotal: number | null;
};

export function buildDealMatchProposalTitle(input: DealMatchProposalInput): string {
  return `제안 검토: ${input.sellerName} × ${input.dealName} (${MATCH_REASON_LABEL[input.reason]})`;
}

export function buildDealMatchMemoContent(input: DealMatchProposalInput): string {
  const parts = [`${MATCH_REASON_LABEL[input.reason]} 후보로 검토.`];
  if (input.pairRunCount != null && input.pairDaysSinceLastRun != null) {
    parts.push(
      `이 조합으로 ${input.pairRunCount}회 진행했고 마지막 시작 후 ${input.pairDaysSinceLastRun}일 경과.`,
    );
  }
  // 미입력은 문장을 아예 만들지 않는다 — "0원"으로 적으면 실적 없음으로 오독된다.
  if (input.pairSalesTotal != null) {
    parts.push(`누적 매출 ${Math.round(input.pairSalesTotal / 10_000).toLocaleString()}만원.`);
  }
  if (input.priority) parts.push("재진행 적극 검토 대상.");
  return `${parts.join(" ")} 제안 여부를 결정하세요.`;
}

export function buildDealMatchProposalInput(input: DealMatchProposalInput) {
  const content = buildDealMatchMemoContent(input);
  return {
    requestType: RECAMPAIGN_REQUEST_TYPE,
    kind: "WRITE",
    status: "PENDING_APPROVAL",
    title: buildDealMatchProposalTitle(input),
    resultSummary: content,
    reviewRequired: true,
    // 사람 승인자와 달라야 self-approval 게이트를 통과한다(케이던스 기안과 동일).
    createdBy: "SYSTEM",
    targetEntityType: "SELLER",
    targetEntityId: input.sellerId,
    structuredResult: {
      // dedup 키의 두 축 — `readProposalDedupeKey` 가 읽는 자리다.
      reason: input.reason satisfies ProposalReason,
      dealId: input.dealId,
      dealName: input.dealName,
      priority: input.priority,
      pairRunCount: input.pairRunCount,
      pairDaysSinceLastRun: input.pairDaysSinceLastRun,
      pairSalesTotal: input.pairSalesTotal,
    },
    payload: {
      action: "add_entity_memo",
      args: {
        entityType: "SELLER",
        entityId: input.sellerId,
        content,
      },
    },
  };
}
