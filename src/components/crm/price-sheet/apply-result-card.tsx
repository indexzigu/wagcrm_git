"use client";

/**
 * 반영 결과 카드 — 마지막 반영 시도가 진행중인지·완료됐는지·실패했는지 보여준다.
 *
 * 종전에는 토스트가 유일한 피드백이라 새로고침하면 아무 흔적이 없었다. 특히 실패 시
 * 시트 상태를 이전 값으로 되돌리므로(재시도 가능하게 — 오너 결정) **실패 사실이 시트에
 * 남지 않는다.** 그래서 이 카드가 `ActionProposal` 기록을 읽어 화면으로 끌어올린다.
 *
 * 배치는 헤더 바로 아래다 — "지난번 반영이 어떻게 됐나"는 화면에 들어오자마자 갖는
 * 질문이고, 실패 사유를 검수표 아래까지 스크롤해서 찾게 하면 안 된다. 하단의 "딜 반영
 * 미리보기"(앞으로 일어날 일)와 화면 양 끝에 놓여 시제가 위치로 구분된다.
 *
 * 색 — 실패만 배경 틴트까지 받고 완료·진행중은 배지로만 표시한다. 성공은 매번 뜨는
 * 정상 상태라 카드를 칠하면 색이 흔해져 정작 실패가 안 보인다(P8 §2). 상태 hue 는
 * StatusBadge 스킴을 그대로 쓴다(가드레일 2) — destructive 토큰을 새로 끌어오지 않는다.
 */
import { AlertTriangleIcon, CheckCircle2Icon, ClockIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { ApplySummary } from "@/lib/price-sheet/apply-summary";

function formatFinishedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function ApplyResultCard({ summary }: { summary: ApplySummary | null }) {
  // 한 번도 반영을 시도하지 않은 시트에는 카드를 아예 그리지 않는다 — 빈 리스트가 아니라
  // "아직 사건이 없다"라서 empty-state UI 를 만들 자리가 아니다.
  if (!summary) return null;

  const finishedAt = formatFinishedAt(summary.finishedAt);
  const isFailure = summary.outcome === "FAILED";

  const meta = {
    RUNNING: {
      icon: ClockIcon,
      badge: "status-pending" as const,
      label: "반영 중",
      description: "딜에 반영하는 중입니다. 잠시 후 새로고침하면 결과가 표시됩니다.",
    },
    SUCCEEDED: {
      icon: CheckCircle2Icon,
      badge: "status-success" as const,
      label: "반영 완료",
      description: null,
    },
    FAILED: {
      icon: AlertTriangleIcon,
      badge: "status-urgent" as const,
      label: "반영 실패",
      description: "딜은 하나도 변경되지 않았습니다. 원인을 고친 뒤 다시 반영할 수 있습니다.",
    },
  }[summary.outcome];

  const Icon = meta.icon;

  return (
    <Card className={cn("p-4", isFailure && "bg-status-urgent-bg")}>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Icon
            aria-hidden
            className={cn(
              "size-4 shrink-0",
              isFailure ? "text-status-urgent-text" : "text-muted-foreground"
            )}
          />
          <h3 className="text-sm font-semibold text-foreground">반영 결과</h3>
          <Badge variant={meta.badge}>{meta.label}</Badge>
          {finishedAt && (
            <span className="text-xs text-muted-foreground">{finishedAt}</span>
          )}
        </div>

        {summary.outcome === "SUCCEEDED" && (
          <p className="text-xs text-muted-foreground">
            딜 {summary.createdCount}개 생성
            {summary.updatedCount > 0 && `, ${summary.updatedCount}개 갱신`}
          </p>
        )}

        {meta.description && (
          <p
            className={cn(
              "text-xs",
              isFailure ? "text-status-urgent-text" : "text-muted-foreground"
            )}
          >
            {meta.description}
          </p>
        )}

        {/* 크기는 폼 타이포 사다리의 "도움말·오류" 단(text-xs)을 그대로 쓴다 — 원시
            오류 문자열이라 mono 로만 구분하고 새 크기값을 만들지 않는다. */}
        {summary.errorMessage && (
          <p className="rounded-md bg-card px-3 py-2 font-mono text-xs break-words text-status-urgent-text">
            {summary.errorMessage}
          </p>
        )}
      </div>
    </Card>
  );
}
