"use client";

import { Badge } from "@/components/ui/badge";
import {
  campaignStatusLabels,
  type CampaignStatus,
} from "@/lib/crm-types";
import { cn } from "@/lib/utils";

// 서비스 팔레트 status 토큰 매핑 (globals.css @theme). 색=의미 + a11y AA(≥4.5:1) 확보.
//
// ⛔ **한 축 규칙 — 테두리는 8개 전부 `border-transparent`, 의미는 채움만 진다**
// (오너 결정 2026-07-30). P8 §3 이 캐리어를 이름으로 나열할 때 *"배지 fill · 아이콘 ·
// 바 fill · 행 tint · 도트"* 로 **테두리가 없다** — 이 규칙은 새 발명이 아니라 그 문서를
// 코드에 맞춘 것이다. 새 상태를 추가할 때도 테두리로 구분하지 말 것.
//
// 배경 3-tier(설계 의도, 임의 통일 금지):
//   ① opacity-tint 계열(active·info) = 순색 /10 스케일 — 얕게 깔아도 톤이 깨끗.
//   ② dedicated-tint 계열(caution·success·urgent) = 전용 -bg 토큰(urgent는 텍스트에 -text) —
//      순색을 그대로 스케일하면 대비/색감이 부족해 별도 페어링을 둠.
//   ③ 중립(세팅대기·마감) = 무채색 채움 2단(slate-100/700 · slate-200/800).
//      ⛔ 종전 "채움 대신 outline(border-border + 투명 bg)"은 **SUPERSEDED**(2026-07-30).
//      그 근거였던 *"muted-fg/muted가 4.34로 AA 미달"* 은 실측 정확하나(#64748B on #F1F5F9
//      = 4.34) **그 한 조합**이 막힌 것이고, 글자를 slate-700 으로 내리면 같은 채움에서
//      9.45:1 로 통과한다 — 축을 바꿀 이유가 아니었다. 2단인 이유는 두 중립이 칸반
//      DEAL_EXECUTION 컬럼에 인접하기 때문(slate-200/800 = 11.87:1).
// 소형 배지 텍스트(12px)라 밝은 톤(status-pending #F59E0B·기본 urgent #BF5050)은 텍스트에 쓰지 않고
// 어두운 변형 사용(caution #B45309·4.84, success #047857·5.21, urgent-text #8F3C3C·6.42, info·4.94).
const statusClassName: Record<CampaignStatus, string> = {
  PROPOSAL: "border-transparent bg-status-active/10 text-status-active",
  PREPARATION: "border-transparent bg-slate-100 text-slate-700",
  ACTIVE: "border-transparent bg-status-active/10 text-status-active",
  CLOSED: "border-transparent bg-slate-200 text-slate-800",
  SETTLEMENT_WAIT: "border-transparent bg-status-caution-bg text-status-caution",
  SETTLEMENT_IN_PROGRESS: "border-transparent bg-status-info/10 text-status-info",
  COMPLETED: "border-transparent bg-status-success-bg text-status-success",
  DROPPED: "border-transparent bg-status-urgent-bg text-status-urgent-text",
};

// 캘린더 바 전용 상태 클래스 (SSOT는 계속 이 파일 — 바가 배지 파일을 참조하되 역참조 없음).
// 배지(작은 pill)는 8개 중 4쌍이 클래스가 겹쳐도 무해하지만, 캘린더 바는 그리드의
// 주인공이라 생애주기 위계가 읽혀야 한다. 그래서 hue는 위 statusClassName과 동일 계열을
// 쓰되 "채움강도"(tint=대기 / solid+흰글씨=진행·확정) 축을 얹어 대기↔진행을 분리한다.
// 전 조합 흰텍스트/텍스트 대비 AA(≥4.5:1) 검증(ss-ux-designer 감사):
//   PROPOSAL 9.47 · PREPARATION 6.92(slate-600, slate-500는 4.35로 미달이라 교체) ·
//   ACTIVE 11.31 · CLOSED 8.40 · SETTLEMENT_WAIT 4.84 · SETTLEMENT_IN_PROGRESS 5.65 ·
//   COMPLETED 5.48 · DROPPED 4.69(여유 최소 — font-medium 유지 필수).
export const statusBarClassName: Record<CampaignStatus, string> = {
  PROPOSAL: "border border-status-active/30 bg-status-active/10 text-status-active",
  PREPARATION: "border border-dashed border-slate-400/70 bg-slate-100 text-slate-600",
  ACTIVE: "bg-status-active text-white",
  CLOSED: "border border-slate-400 bg-slate-200 text-slate-700",
  SETTLEMENT_WAIT: "border border-status-caution/30 bg-status-caution-bg text-status-caution",
  SETTLEMENT_IN_PROGRESS: "bg-status-info text-white",
  COMPLETED: "bg-status-success text-white",
  DROPPED: "bg-status-urgent text-white",
};

export function StatusBadge({ status, className }: { status: CampaignStatus; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "rounded-2xl px-2.5 font-medium shadow-none",
        statusClassName[status],
        className,
      )}
    >
      {campaignStatusLabels[status]}
    </Badge>
  );
}
