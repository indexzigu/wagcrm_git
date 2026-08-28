import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import type { DesktopDashboardData } from "@/lib/desktop-dashboard";

/**
 * 홈 "리스크 신호" 카드 — 모바일 홈 재구성 안 C (오너 승인 2026-07-15).
 *
 * 판단 지원(P3): 사람이 손봐야 할 명백한 신호만 홈에 띄운다. 이슈가 0건이면
 * 카드 자체를 렌더하지 않는다(P2 Decision-Value — "이상 없음" 장식 카드 금지).
 *
 * 신호 구성:
 * - dataIntegrityIssues(휴먼에러 게이트, src/lib/data-integrity.ts) 유형별 건수
 *   + 심각도순 상위 3건 목록. 색·심각도 위계는 데스크톱 DataIntegrityCard 와 동일
 *   (음수 매출 > 정산 불일치 > 실매출 미입력).
 * - exceptions(리마인더 지연·승인 대기 = 영업 후속 액션 신호) 전량.
 *   ⛔ **대금** 신호를 이 카드에 추가하지 말 것: 입금 대기는 바로 위 "정산 대기" 카드가
 *   소유하고, 정산 불일치는 위 dataIntegrityIssues 의 SETTLEMENT_INCOMPLETE 가 소유한다
 *   (이중 표기 방지). 종전 desktop-dashboard 의 exceptions.pendingDeposits ·
 *   settlementMismatches 를 여기서 "의도적 제외"로 걸러냈으나, 그 필드들은 멤버 행
 *   플래그로 판정해 그룹 SoT(CampaignGroup 스칼라)를 위반하고 있어 소스에서 제거됐다.
 *   경위는 docs/handoff/group-campaign-dashboard-fold.md.
 *   ⚠️ 그 금지는 **대금(입금·지급) 축 전용**이다 — 「정산 미착수」(SETTLEMENT_NOT_STARTED)는
 *   돈이 아니라 **절차**를 묻는 신호라 dataIntegrityIssues 로 들어온다(오너 확정 2026-08-27,
 *   T-062). 이중 표기가 아닌 이유: 정산 대기 카드의 모집단은 정산 단계 캠페인이고 이쪽은
 *   **아직 정산 단계가 아닌** 캠페인이라 두 집합이 정의상 겹치지 않는다.
 * 색은 상태 토큰(--status-*) 계열만 사용(hex 하드코딩 금지, P8).
 */

type IntegrityIssue = DesktopDashboardData["dataIntegrityIssues"][number];
type DashboardExceptions = DesktopDashboardData["exceptions"];

const INTEGRITY_META: Record<
  IntegrityIssue["type"],
  { chipLabel: string; variant: "status-urgent" | "status-caution" | "outline"; dot: string }
> = {
  NEGATIVE_SALES: { chipLabel: "매출 음수", variant: "status-urgent", dot: "bg-status-urgent" },
  SETTLEMENT_INCOMPLETE: { chipLabel: "정산 불일치", variant: "status-caution", dot: "bg-status-caution" },
  // 「반품기간까지 끝났는데 정산을 시작 안 함」(T-062). 데스크톱 데이터 점검 카드와 같은
  // 판정·같은 색을 쓴다 — 판정은 `computeDataIntegrityIssues` 한 곳이므로 두 화면이 갈릴 수 없다.
  SETTLEMENT_NOT_STARTED: { chipLabel: "정산 미착수", variant: "status-caution", dot: "bg-status-caution" },
  // 최저 심각도(입력 누락)는 데스크톱 정본과 동일하게 뉴트럴 슬레이트로 낮춰 표기
  MISSING_SALES: { chipLabel: "실매출 미입력", variant: "outline", dot: "bg-slate-400" },
};

/** 상위 항목 노출 수 — 얇은 경고 카드 유지(전량 나열 금지) */
const MAX_ITEMS = 3;

export function MobileHomeRiskCard({
  issues,
  exceptions,
}: {
  issues: IntegrityIssue[];
  exceptions: DashboardExceptions;
}) {
  const outreachSignals = [
    { key: "overdueReminders", label: "리마인더 지연", count: exceptions.overdueReminders, variant: "status-caution" as const },
    { key: "pendingApprovals", label: "승인 대기", count: exceptions.pendingApprovals, variant: "status-pending" as const },
  ].filter((signal) => signal.count > 0);

  const totalCount = issues.length + outreachSignals.reduce((sum, s) => sum + s.count, 0);
  if (totalCount === 0) return null;

  // 유형별 건수 (issues 는 이미 심각도순 정렬 — computeDataIntegrityIssues 계약)
  const integrityChips: { key: string; label: string; count: number; variant: "status-urgent" | "status-caution" | "status-pending" | "outline" }[] = [];
  for (const issue of issues) {
    const meta = INTEGRITY_META[issue.type];
    const existing = integrityChips.find((chip) => chip.key === issue.type);
    if (existing) existing.count += 1;
    else integrityChips.push({ key: issue.type, label: meta.chipLabel, count: 1, variant: meta.variant });
  }

  const chips = [
    ...integrityChips,
    ...outreachSignals.map((s) => ({ key: s.key, label: s.label, count: s.count, variant: s.variant })),
  ];

  return (
    <Card className="border-black/5 bg-white shadow-soft-sm p-0">
      <CardContent className="px-4 py-4">
        <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
          <AlertTriangle className="size-4 shrink-0 text-status-caution" />
          <p className="text-sm font-semibold tracking-tight text-[var(--primary)]">리스크 신호</p>
          <Badge variant="status-caution" className="ml-auto tabular-nums">
            {totalCount}건
          </Badge>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <Badge key={chip.key} variant={chip.variant} className="tabular-nums">
              {chip.label} {chip.count}
            </Badge>
          ))}
        </div>

        {issues.length > 0 && (
          <ul className="mt-2">
            {issues.slice(0, MAX_ITEMS).map((issue, i) => {
              const meta = INTEGRITY_META[issue.type];
              return (
                <li
                  key={`${issue.campaignId}-${issue.type}-${i}`}
                  className="flex items-center justify-between gap-3 border-b border-slate-100 py-1.5 last:border-0 last:pb-0"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden="true" />
                    <span className="truncate text-[13px] font-medium text-slate-800" title={issue.campaignName}>
                      {issue.campaignName}
                    </span>
                  </div>
                  {/* 데스크톱 자매 카드와 같은 규약 — 라벨도 이름과 같이 줄어든다.
                      ⛔ `shrink-0` 으로 되돌리지 말 것: 긴 라벨이 자기 폭을 다 가져가면
                      **어느 캠페인인지가 대신 잘린다**(실측 근거는 `data-integrity-card` 주석). */}
                  <span
                    className="min-w-0 truncate text-[11px] text-muted-foreground"
                    title={issue.label}
                  >
                    {issue.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {issues.length > MAX_ITEMS && (
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground/60">
            + {issues.length - MAX_ITEMS}건 더: 데스크톱 대시보드에서 확인
          </p>
        )}
      </CardContent>
    </Card>
  );
}
