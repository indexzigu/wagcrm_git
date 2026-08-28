// 휴먼에러 게이트 카드 (GROWTH_FLYWHEEL_PLAN.md §F5) — 사람이 손봐야 하는 정산·매출 신호를
// 대시보드에 '확인 필요'로 표면화한다. 기존엔 desktop-dashboard가 계산만 하고 버리던
// 신호(종료됐는데 매출 미입력·정산 상태 불일치)를 실행 가능한 목록으로 노출한다. 읽기 전용.
//
// ⚠️ 이 카드는 이제 **입력 오류만 담지 않는다** — `SETTLEMENT_NOT_STARTED`(반품기간이 끝났는데
// 정산 단계로 안 넘어옴, T-062)는 값이 틀린 게 아니라 **절차가 안 넘어간 것**이고 필요한 조치도
// 다르다(정정이 아니라 진행). 그래서 부제를 「정산·매출 **처리**」로 넓혔다 — 「입력」으로
// 되돌리면 오너가 부제만 보고 값 확인을 기대했다가 다른 종류의 액션을 만난다.
"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";

type Issue = DesktopDashboardData["dataIntegrityIssues"][number];

// 심각도는 **도트 한 캐리어에만** 싣는다(P8 §3 "목록 행 = 저강도", 오너 확정 2026-07-22 —
// 자매 모바일 리스크 카드가 이미 같은 형태다). 라벨을 심각도 색으로 칠하면 도트와 이중
// 인코딩이 되고, 원시 색 시절 red-500(3.71:1)·gray-400(2.50:1)이 그 자리에서 AA 미달이었다.
// 라벨은 전부 muted-foreground(#64748B — 카드 4.70 / 행 hover 4.55).
const TYPE_STYLE: Record<Issue["type"], { dot: string; tagText: string }> = {
  NEGATIVE_SALES: { dot: "bg-status-urgent", tagText: "text-muted-foreground font-medium" },
  // amber-500(#F59E0B)은 이 표면에서 2.13:1 로 비텍스트 3:1 미달이었고, 공교롭게 --status-pending
  // 과 같은 hex 라 "대기" 축과 색이 겹쳤다 → caution 축 토큰으로 이관(도트 4.95:1).
  SETTLEMENT_INCOMPLETE: { dot: "bg-status-caution", tagText: "text-muted-foreground font-medium" },
  // 착수 지연도 caution 이다 — 불일치와 **같은 축(정산 절차가 어긋났다)**이라 P8 §1
  // "같은 값이면 같은 색"이 그대로 걸린다. 두 줄을 가르는 것은 도트가 아니라 라벨이고,
  // 순서는 SEVERITY 가 정한다. ⛔ `--status-pending` 으로 낮추지 말 것: 이 표면에서
  // 2.13:1 로 비텍스트 3:1 미달이다(바로 위 주석의 amber-500 이 같은 hex 라 밀려났다).
  SETTLEMENT_NOT_STARTED: { dot: "bg-status-caution", tagText: "text-muted-foreground font-medium" },
  MISSING_SALES: { dot: "bg-slate-400 opacity-80", tagText: "text-muted-foreground font-medium" },
};

// 카드 목록·더보기 팝업이 공유하는 이슈 행 — 두 곳의 표기가 갈라지지 않게 한 곳에 둔다
function IssueRow({ issue }: { issue: Issue }) {
  const s = TYPE_STYLE[issue.type];
  return (
    <li className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0 hover:bg-gray-50 transition-colors">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} aria-hidden="true" />
        <span className="text-[13px] font-medium text-gray-800 truncate" title={issue.campaignName}>
          {issue.campaignName}
        </span>
      </div>
      {/* 라벨도 이름과 **같이 줄어든다**(둘 다 `min-w-0`+`truncate`+`title`).
          ⛔ 라벨 쪽을 `shrink-0` 으로 되돌리지 말 것 — 그러면 라벨이 자기 폭을 다 가져가고
          **어느 캠페인인지가 대신 잘린다.** 실측(2026-08-27, 243px 폭 카드): 기존 최장 라벨
          `정산완료 처리됐으나 공급사 지급 미확인` 이 169px 를 차지해 이름에 50px 만 남겼고,
          T-062 의 묶음 라벨은 205px 로 이름을 13px 까지 밀어냈다(사실상 소실). 진단이 신원을
          밀어내는 구조였다. 지금은 flex 가 둘로 나누고, 잘린 쪽은 `title` 로 복구된다. */}
      <div className="flex min-w-0 items-center gap-3 text-[11px] tabular-nums ml-2">
        <span className={`truncate ${s.tagText}`} title={issue.label}>
          {issue.label}
        </span>
      </div>
    </li>
  );
}

// bare 표현부 — Card·제목·배지 없이 서브텍스트+빈상태/목록+더보기만. 데이터 점검과
// 최저가를 탭으로 묶을 때(오너 2026-07-24) 탭 패널이 직접 소비한다. 배지(건수)는 탭 배지로
// 옮겨가므로 여기선 안 그린다. showSubtext=false 면 서브텍스트도 생략(탭 헤더가 좁을 때).
export function DataIntegrityBody({ issues, showSubtext = true }: { issues: Issue[]; showSubtext?: boolean }) {
  const [isAllOpen, setIsAllOpen] = useState(false);
  const isClean = issues.length === 0;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {showSubtext && (
        <p className="mb-2 shrink-0 truncate text-[11px] text-muted-foreground/70" title="정산·매출 처리에서 사람이 확인해야 할 항목입니다.">
          정산·매출 처리에서 사람이 확인해야 할 항목입니다.
        </p>
      )}
      {isClean ? (
        <div className="flex-1 flex items-center justify-center rounded-xl border border-dashed border-slate-150 bg-slate-50/30 py-6 text-center">
          <div>
            <p className="text-xs font-semibold text-slate-700">확인이 필요한 항목이 없습니다.</p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-500">정산·매출 처리가 모두 정상입니다.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:bg-slate-200 [&::-webkit-scrollbar-thumb]:rounded-full pr-1">
          <ul>
            {issues.slice(0, 5).map((issue, i) => (
              <IssueRow key={`${issue.campaignId}-${issue.type}-${i}`} issue={issue} />
            ))}
          </ul>
          {issues.length > 5 && (
            <div className="mt-2 text-center">
              {/* 페이지 이동 대신 팝업으로 전체 목록 확인(오너 2026-07-24). 모달 Dialog가 아니라
                  다른 팝업과 같은 경량 Popover(오너 2026-07-24 2차: 강조 불필요, 간단한 정보 수준) */}
              <Popover open={isAllOpen} onOpenChange={setIsAllOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-block text-[11px] font-medium text-muted-foreground/50 hover:text-muted-foreground transition-colors rounded focus-visible:ring-2 focus-visible:ring-focus-ring focus:outline-none"
                  >
                    + {issues.length - 5}건의 무결성 이슈 더보기
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="center"
                  sideOffset={6}
                  collisionPadding={12}
                  className="flex w-[380px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-xl border-slate-200 bg-white p-0 shadow-overlay max-h-[min(480px,var(--radix-popover-content-available-height))]"
                >
                  <div className="shrink-0 border-b border-slate-100 bg-slate-50/70 px-3.5 py-2.5">
                    <p className="text-[12px] font-bold text-slate-700">데이터 점검 전체 {issues.length}건</p>
                    <p className="text-[10px] text-slate-500">정산·매출 처리에서 사람이 확인해야 할 항목</p>
                  </div>
                  <ul className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-3.5 py-1">
                    {issues.map((issue, i) => (
                      <IssueRow key={`all-${issue.campaignId}-${issue.type}-${i}`} issue={issue} />
                    ))}
                  </ul>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DataIntegrityCard({ issues }: { issues: Issue[] }) {
  const isClean = issues.length === 0;

  // 이슈 0건이어도 카드는 렌더한다(오너 2026-07-24) — 카드가 통째로 사라지면 그리드에
  // 빈 공간만 남고, "점검 결과 이상 없음"과 "점검 기능이 없음"을 구분할 수 없다.
  return (
    <Card className="border-black/5 bg-white/85 shadow-soft-sm h-full flex flex-col">
      <CardContent className="px-4 py-3 flex flex-col flex-1 h-full">
        {/* 영문 병행 표기 제거·서브텍스트는 제목 우측에 이어서(오너 2026-07-24) */}
        <div className="flex items-center gap-2 pb-2 border-b border-slate-100 mb-3">
          <AlertTriangle className="size-4.5 shrink-0 text-slate-400" />
          <h3 className="shrink-0 text-sm font-bold text-[var(--primary)] tracking-tight">데이터 점검</h3>
          {/* 배지는 caution 토큰으로 수렴(오너 2026-07-24). 0건이면 success "이상 없음" */}
          {isClean ? (
            <Badge
              variant="outline"
              size="compact"
              className="shrink-0 font-bold bg-status-success-bg text-status-success border-status-success/20"
            >
              이상 없음
            </Badge>
          ) : (
            <Badge
              variant="outline"
              size="compact"
              className="shrink-0 font-bold bg-[var(--status-caution-bg)] text-[var(--status-caution-text)] border-[var(--status-caution-text)]/15"
            >
              {issues.length}건 확인 필요
            </Badge>
          )}
          <p className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70" title="정산·매출 처리에서 사람이 확인해야 할 항목입니다.">
            정산·매출 처리에서 사람이 확인해야 할 항목입니다.
          </p>
        </div>
        <DataIntegrityBody issues={issues} showSubtext={false} />
      </CardContent>
    </Card>
  );
}
