import Link from "next/link";
import { ChevronRightIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ReadRecordItem } from "@/hooks/useReadRecords";
import { SourceBadge } from "./source-badge";
import { OPERATION_LABELS } from "./approvals-tabs";
import { formatShortDateTime } from "./format-time";

/**
 * ReadRecordCard — 결재함 「조회 결과」 한 건 (Plan 2 Task 4).
 *
 * 이 탭에서 운영자가 하는 판단은 하나다: **이 조회를 열어볼 가치가 있는가.** 그래서
 * 카드는 세 줄(무엇을·무엇에 대해·어떤 결과였나)만 담고, 카드 전체가 상세로 가는
 * 링크다 — 별도의 「자세히」 버튼은 클릭 표적을 카드보다 작게 만들 뿐이다.
 *
 * ⛔ 작업 종류(operation)에 색을 주지 말 것 — 좋고 나쁨이 없는 **범주**라 P8 §4
 * ("범주는 색을 받지 않는다")의 대상이다. 여기서 색이 필요한 자리는 없다.
 */
export function ReadRecordCard({ item }: { item: ReadRecordItem }) {
  const operation = item.structuredResult?.operation;
  const operationLabel = operation ? OPERATION_LABELS[operation] ?? operation : "조회";
  // 요약은 여러 줄일 수 있다 — 목록에서는 첫 줄만 쓴다(나머지는 상세에서 본다).
  const summaryFirstLine = item.resultSummary?.split("\n").find((line) => line.trim().length > 0);

  return (
    <li>
      <Link
        href={`/approvals/${item.id}`}
        className="flex items-center gap-3 rounded-lg border border-border p-4 shadow-soft-sm transition-shadow hover:shadow-soft-md focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{operationLabel}</Badge>
            <SourceBadge createdBy={item.createdBy} />
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatShortDateTime(item.createdAt)}
            </span>
          </div>
          <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
          {summaryFirstLine && (
            <p
              data-slot="read-record-summary"
              className="line-clamp-1 text-xs text-muted-foreground"
            >
              {summaryFirstLine}
            </p>
          )}
        </div>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}
