import type { CampaignStatus } from "./crm-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BadgeColorConfig {
  /** Tailwind background class */
  bg: string;
  /** Tailwind text color class */
  text: string;
  /** Korean label for the status */
  label: string;
  // ⛔ `border` 필드는 **의도적으로 없다**(오너 결정 2026-07-30, 한 축 규칙).
  // 테두리는 8개 배지가 같은 값(`border-transparent`)을 쓰고 의미는 채움만 진다 —
  // 소비처가 베이스 클래스에서 한 번 고정하므로 상태별 값이 있을 자리가 아니다.
  // PR #154 가 이 필드를 추가했다가 #168 에서 걷어냈다: 그때는 SSOT 의 중립이
  // outline 이라 테두리가 의미를 졌는데, 그 축 자체가 틀렸다는 게 결론이었다.
  // 다시 추가하려거든 P8 §3 의 캐리어 목록(테두리 없음)부터 볼 것.
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Sub-stage badge color configuration for each CampaignStatus.
 *
 * All color combinations are designed to meet WCAG AA contrast ratio (≥ 4.5:1)
 * between text and background colors.
 *
 * **8개 전부 SSOT `statusClassName`(status-badge.tsx)의 채움·글자 토큰과 문자 그대로 같다**
 * (가드레일 2 정렬 완료, interfaces 점검 묶음 F — 2026-09-24 오너 지시). 종전에는 이 맵이
 * 정본과 **의미축이 달랐다**: 「판매 진행」=초록(success) · 「정산 진행」=주황(caution) ·
 * 「제안」=blue-100 · 「정산 대기」=amber-100 · 「정산 완료」=green-100 리터럴. 그래서 정상
 * 진행 단계가 경고처럼 보였고, 같은 상태가 표(이 맵)와 캘린더·패널(StatusBadge)에서
 * 다른 색이었다. 정렬 계약은 `lib/__tests__/badge-config-guardrail2.test.tsx` 가 **8개 전수**로
 * 고정한다 — 값을 여기서 따로 고르지 말고 SSOT 를 고친 뒤 여기를 맞출 것.
 *
 * 대비(글자 on 채움, 흰 카드 위 알파 틴트는 합성값 · 실측 계산):
 * - PROPOSAL/ACTIVE: status-active #0A3D62 on active/10(#E7ECEF) → 9.50 (slate-50 위 9.06)
 * - PREPARATION:     slate-700 #334155 on slate-100 → 9.45
 * - CLOSED:          slate-800 #1E293B on slate-200 → 11.87
 * - SETTLEMENT_WAIT: status-caution #B45309 on caution-bg #FFFBEB → 4.84
 * - SETTLEMENT_IN_PROGRESS: status-info #4A6B82 on info/10(#EDF0F3) → 4.94 (slate-50 위 4.75)
 * - COMPLETED:       status-success #047857 on success-bg #ECFDF5 → 5.21
 * - DROPPED:         status-urgent-text #8F3C3C on urgent-bg #F9EEEE → 6.42
 *
 * ⚠️ CLOSED: purple 회수 (오너 지시 2026-07-30). P8 가드레일 2 가 이 파일을 이름으로
 * 지목한다 — "상태 배지 색은 StatusBadge 스킴이 유일 정본 — purple 등 신규 hue 도입
 * 금지. 다른 배지 설정(badge-config.ts 등)은 이 스킴에 정렬한다."
 * 당시의 유보(amber/green — 2026-09-24 전수 정렬로 해소)와 달리 purple 은 그 유보 목록에 없었다.
 *
 * ⛔ **한 축 규칙**(오너 결정 2026-07-30): 테두리는 8개 전부 같은 값이고 의미는 채움만
 * 진다. 그래서 이 맵에 `border` 값이 없고 소비처 베이스가 `border-transparent` 로 한 번
 * 고정한다. CLOSED = SSOT `statusClassName.CLOSED`(= `bg-slate-200 text-slate-800`) 그대로.
 *
 * 이 값에 도달하기까지 세 번 왕복했다 — 다음 세션이 같은 길을 다시 돌지 않도록 남긴다:
 *   1. #152: 채움 slate-200/700. 근거는 *"캐리어가 테두리를 못 그린다"* (우회).
 *   2. #154: 중립 outline(`border-border bg-transparent text-foreground`) + `border` 필드
 *      신설로 그 제약을 제거. 가드레일 2 의 "SSOT 에 정렬"은 지켰다.
 *   3. **이 PR**: 정렬 대상이던 SSOT 자체가 두 축이었다(6개는 채움, 2개는 테두리).
 *      P8 §3 의 캐리어 목록에 테두리가 없으므로 SSOT 를 고치고 여기가 따라온다.
 *      결과적으로 값은 #152 쪽으로 돌아왔지만 **이유가 다르다** — 우회가 아니라 축 정리다.
 *
 * ⛔ 되살리지 말 것: `border` 필드 · 중립 outline · "캐리어가 테두리를 못 그린다"는 서술
 * (그건 #154 가 이미 제거했고, 지금은 애초에 테두리를 안 쓴다).
 *
 * 인접 제약은 유지된다 — `ZONE_SUB_STATUS_ORDER.DEAL_EXECUTION` 이
 * PREPARATION·ACTIVE·CLOSED·SETTLEMENT_WAIT 를 한 컬럼에 붙이므로 두 중립은 채움 2단
 * (slate-100 vs slate-200)으로 갈린다.
 *
 * 정렬 계약은 `lib/__tests__/badge-config-guardrail2.test.tsx` 가 고정한다.
 */
export const SUB_STAGE_BADGE_CONFIG: Record<CampaignStatus, BadgeColorConfig> = {
  PROPOSAL: {
    bg: "bg-status-active/10",
    text: "text-status-active",
    label: "셀러 제안 중",
  },
  PREPARATION: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    label: "세팅 대기",
  },
  ACTIVE: {
    bg: "bg-status-active/10",
    text: "text-status-active",
    label: "판매 진행 중",
  },
  CLOSED: {
    // SSOT statusClassName.CLOSED 그대로. PREPARATION(slate-100)과 채움 2단으로 갈린다 —
    // 칸반 DEAL_EXECUTION 컬럼이 둘을 인접 배치하기 때문.
    bg: "bg-slate-200",
    text: "text-slate-800",
    label: "판매 마감",
  },
  SETTLEMENT_WAIT: {
    bg: "bg-status-caution-bg",
    text: "text-status-caution",
    label: "정산 대기",
  },
  SETTLEMENT_IN_PROGRESS: {
    bg: "bg-status-info/10",
    text: "text-status-info",
    label: "정산 진행",
  },
  COMPLETED: {
    bg: "bg-status-success-bg",
    text: "text-status-success",
    label: "정산 완료",
  },
  DROPPED: {
    bg: "bg-status-urgent-bg",
    text: "text-status-urgent-text",
    label: "드랍",
  },
};
