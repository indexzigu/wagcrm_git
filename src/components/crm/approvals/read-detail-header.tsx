import { InfoIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { OPERATION_LABELS } from "./approvals-tabs";
import { SourceBadge } from "./source-badge";
import { formatShortDateTime } from "./format-time";
import type { ReadEnvelope } from "./read-result-body";

/**
 * 조회 결과 상세의 머리 — **이 표를 믿어도 되는가**에 답하는 자리 (Plan 2 Task 5).
 *
 * 표 자체는 아래 본문이 그린다. 여기 있는 것은 그 표를 읽기 전에 알아야 하는 것들:
 * 무엇을 조회했고(작업 라벨·조건) · 누가 언제 했고(출처·시각) · 결과가 온전한가
 * (행 상한·저장 상한 고지)다.
 *
 * ⛔ 고지 줄에 경고색(destructive)을 쓰지 말 것 — 잘림은 **사고가 아니라 사양**이다.
 * 빨강을 칠하면 운영자가 실패로 읽고 다시 조회하게 된다.
 */

export const TRUNCATED_NOTE = "결과가 커서 표는 저장하지 않았습니다. 요약만 확인할 수 있습니다.";
export const ROW_LIMIT_NOTE = "상위 20건만 표시합니다.";

function DetailNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
      <InfoIcon className="size-3.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}

/** 값이 비어 있는 조건은 칩으로 만들지 않는다 — 「status: 」 는 아무 말도 하지 않는다. */
function conditionChips(query: ReadEnvelope["query"]): [string, string][] {
  if (!query || typeof query !== "object") return [];
  return Object.entries(query)
    .filter(([, value]) => value !== null && value !== undefined && String(value).length > 0)
    .map(([key, value]) => [key, String(value)]);
}

function rowLimitReached(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  return (data as Record<string, unknown>).rowLimitReached === true;
}

export function ReadDetailHeader({
  envelope,
  createdBy,
  createdAt,
  resultSummary,
}: {
  envelope: ReadEnvelope | null;
  createdBy: string;
  createdAt: string;
  resultSummary?: string | null;
}) {
  const operation = envelope?.operation;
  const operationLabel = operation ? OPERATION_LABELS[operation] ?? operation : "조회";
  const chips = conditionChips(envelope?.query);

  return (
    <div className="flex flex-col gap-2 border-b border-border/70 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{operationLabel}</Badge>
        <SourceBadge createdBy={createdBy} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatShortDateTime(createdAt)}
        </span>
        {chips.map(([key, value]) => (
          <Badge key={key} variant="outline" size="compact">
            {key}: {value}
          </Badge>
        ))}
        {envelope?.jobId && (
          // 슬랙 대화와 이 기록을 잇는 유일한 끈이다 — 그래서 한 번 클릭으로 통째로
          // 집히게 둔다(`select-all`). 눈에 띄면 안 되므로 가장 작고 옅은 글이다.
          <span className="ml-auto select-all text-[10px] text-slate-500">{envelope.jobId}</span>
        )}
      </div>

      {envelope?.truncated && <DetailNote>{TRUNCATED_NOTE}</DetailNote>}
      {rowLimitReached(envelope?.data) && <DetailNote>{ROW_LIMIT_NOTE}</DetailNote>}

      {resultSummary && (
        // 봇이 슬랙에 뱉은 글 그대로다. 화면의 주인공은 아래 표이므로 접어 둔다 —
        // 펼치면 원문 줄바꿈을 그대로 보여준다(요약은 줄 단위로 읽는 글이다).
        <details className="text-xs">
          <summary className="w-fit cursor-pointer text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
            봇 요약
          </summary>
          <pre className="mt-1.5 whitespace-pre-wrap text-xs text-muted-foreground">
            {resultSummary}
          </pre>
        </details>
      )}
    </div>
  );
}
