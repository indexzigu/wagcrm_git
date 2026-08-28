"use client";

import { Badge } from "@/components/ui/badge";
import { dealStatusLabels, type DealStatus } from "@/lib/crm-types";
import { cn } from "@/lib/utils";

// 딜 생애주기 배지 — P8 가드레일 2 정렬 + 도달 불가 hue 회수 (오너 결정 2026-07-30).
//
// ⚠️ 이 배지는 P8 §4("범주는 색을 받지 않는다")의 대상이 **아니다** — 딜 상태는 §1 의
// 생애주기 축이라 색 자격이 있다. 걸린 것은 가드레일 2 다: "상태 배지 색은 StatusBadge
// 스킴이 유일 정본 — purple 등 신규 hue 도입 금지. 다른 배지 설정은 이 스킴에 정렬한다."
// 회수 전에는 sky/amber/teal/**violet**/slate 리터럴로 SSOT 어휘 밖에 있었고, violet 은
// 이 레포에 다른 소비처가 없는 신규 hue 였다.
//
// **같은 PR 에서 제거된 것 — 도달 불가 hue 9개(시각 변화 0):**
//   partnerTypeClassName(blue·emerald·purple·orange·slate) — `type="partner"` 호출부 0
//   snsTypeClassName(pink·red·slate-900)                   — `type="seller"`  호출부 0
//   dealStatusClassName.ARCHIVED(green)                    — 아래 리맵이 가로챘다
// 소비처는 deals-grid.tsx 의 `<EntityTypeBadge type="deal" …>` 한 줄뿐이었다. 죽은 색은
// tsc·eslint·vitest 를 전부 통과한다 — `Record<PartnerType, string>` 은 맵이 **채워졌는지**만
// 검사하고 **읽히는지**는 모른다. 되살리려면 호출부를 먼저 만들 것.
//
// 매핑 근거(StatusBadge 의 statusClassName 어휘를 그대로 쓴다):
//   SOURCING(발굴)       = info    — 아직 판단이 아니라 탐색 단계
//   NEGOTIATING(협의)    = caution — 오너의 손이 필요한 진행 상태
//   CONFIRMED(확정)      = success — 딜 성립. ARCHIVED(완료)가 리맵으로 여기 흡수된다
//   SAMPLE_TESTING(샘플) = active  — 진행 중이되 판단 대기는 아님(네이비)
//   DROPPED(보류)        = 무채색 채움 — SSOT 의 중립 정본(PREPARATION 과 같은 값)
//
// 대비 실측(직접 계산, P8 §5 — 표면은 행 실제 배경 `bg-white/60` over `#F8FAFC` = #FCFDFE):
//   info 4.85 · caution 4.84 · success 5.21 · active 9.32 — 전 조합 AA(≥4.5).
//   중립은 불투명 채움이라 표면과 무관하게 한 값이다: slate-700 on slate-100 = **9.45:1**.
//   회수 전 DROPPED(slate-500 on slate-100)는 **4.34 로 AA 미달**이었다 — 글자를 slate-700 으로
//   내린 지금 값이 그 결함을 고친 상태를 유지한다(4.34 → 9.45).
//
// ⚠️ tint 2-tier 는 StatusBadge 헤더 주석의 설계 의도 그대로다(임의 통일 금지):
//   opacity-tint(info·active) = 순색 /10 · dedicated-tint(caution·success) = 전용 -bg 토큰.
//   caution·success 를 /10 으로 깔면 대비가 얕아져 AA 가 무너진다.

/** 리맵을 거쳐 실제로 렌더에 도달하는 상태만. ARCHIVED 에 색을 주는 것이 타입 에러가 된다. */
type RenderedDealStatus = Exclude<DealStatus, "ARCHIVED">;

const dealStatusClassName: Record<RenderedDealStatus, string> = {
  SOURCING: "border-transparent bg-status-info/10 text-status-info",
  NEGOTIATING: "border-transparent bg-status-caution-bg text-status-caution",
  CONFIRMED: "border-transparent bg-status-success-bg text-status-success",
  SAMPLE_TESTING: "border-transparent bg-status-active/10 text-status-active",
  // 중립도 채움이다 — 테두리는 이 맵 5개가 전부 `border-transparent` 로 같고 의미는
  // 채움만 진다(한 축 규칙, 오너 결정 2026-07-30). SSOT 의 PREPARATION 과 같은 값이다.
  //
  // ⛔ 종전 `border-border bg-transparent text-foreground`(중립 outline, #158)는
  // **SUPERSEDED**. 그때 근거는 *"muted-fg/muted 가 4.34 로 AA 미달이라 SSOT 도 채움을
  // 안 쓴다"* 였는데, 4.34 는 실측 정확하지만 **그 한 조합**이 막힌 것이다 — 글자를
  // slate-700 으로 내리면 같은 채움에서 9.45:1 로 통과한다. #158 이 회수로 고쳤던
  // 구 DROPPED(slate-500 on slate-100 = 4.34 ❌)의 결함은 여기서 재발하지 않는다.
  DROPPED: "border-transparent bg-slate-100 text-slate-700",
};

type EntityTypeBadgeProps = { type: "deal"; value: DealStatus };

export function EntityTypeBadge({ value }: EntityTypeBadgeProps) {
  // ARCHIVED("완료")는 라벨까지 CONFIRMED("확정")로 흡수한다 — 회수 이전과 같은 동작.
  const status: RenderedDealStatus = value === "ARCHIVED" ? "CONFIRMED" : value;

  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-2xl px-2.5 font-medium shadow-none",
        dealStatusClassName[status],
      )}
    >
      {dealStatusLabels[status]}
    </Badge>
  );
}
