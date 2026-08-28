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
 * Approximate contrast ratios (computed against Tailwind default palette, or the
 * shared status tokens where noted):
 * - PROPOSAL:        blue-800 (#1e40af) on blue-100 (#dbeafe)  → ~7.0:1
 * - PREPARATION:     slate-700 (#334155) on slate-100 (#f1f5f9) → ~7.5:1
 * - ACTIVE:          status-success (#047857) on status-success-bg (#ECFDF5) → ~5.2:1
 * - CLOSED:          slate-800 (#1e293b) on slate-200 (#e2e8f0) → 11.87:1
 * - SETTLEMENT_WAIT: amber-800 (#92400e) on amber-100 (#fef3c7) → ~5.1:1
 * - SETTLEMENT_IN_PROGRESS: status-caution (#B45309) on status-caution-bg (#FFFBEB) → ~4.8:1
 * - COMPLETED:       green-800 (#166534) on green-100 (#dcfce7) → ~6.0:1
 * - DROPPED:         status-urgent-text (#8F3C3C) on status-urgent-bg (#F9EEEE) → ~6.4:1
 *
 * PALETTE_IMPL_SPEC.md (오너 승인, 2026-07-09): ACTIVE/SETTLEMENT_IN_PROGRESS/DROPPED
 * moved off raw emerald/orange/rose Tailwind classes onto the shared status token set
 * ("one meaning = one color" — same tokens the growth charts and schedule-gap card use).
 * SETTLEMENT_WAIT (amber) and COMPLETED (green) are intentionally left on Tailwind
 * palette classes here: the spec names orange/emerald/rose only, and no
 * status-pending-bg/text (or a second success pairing) is defined yet — flagged for
 * the spec owner rather than guessed at.
 *
 * ⚠️ CLOSED: purple 회수 (오너 지시 2026-07-30). P8 가드레일 2 가 이 파일을 이름으로
 * 지목한다 — "상태 배지 색은 StatusBadge 스킴이 유일 정본 — purple 등 신규 hue 도입
 * 금지. 다른 배지 설정(badge-config.ts 등)은 이 스킴에 정렬한다."
 * 위 유보(amber/green)와 달리 purple 은 그 유보 목록에 없었다.
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
    bg: "bg-blue-100",
    text: "text-blue-800",
    label: "셀러 제안 중",
  },
  PREPARATION: {
    bg: "bg-slate-100",
    text: "text-slate-700",
    label: "세팅 대기",
  },
  ACTIVE: {
    bg: "bg-[var(--status-success-bg)]",
    text: "text-[var(--status-success)]",
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
    bg: "bg-amber-100",
    text: "text-amber-800",
    label: "정산 대기",
  },
  SETTLEMENT_IN_PROGRESS: {
    bg: "bg-[var(--status-caution-bg)]",
    text: "text-[var(--status-caution)]",
    label: "정산 진행",
  },
  COMPLETED: {
    bg: "bg-green-100",
    text: "text-green-800",
    label: "정산 완료",
  },
  DROPPED: {
    bg: "bg-[var(--status-urgent-bg)]",
    text: "text-[var(--status-urgent-text)]",
    label: "드랍",
  },
};
