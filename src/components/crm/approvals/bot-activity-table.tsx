import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Toggle } from "@/components/ui/toggle";
import type { AgentJobListItem } from "@/lib/agent-jobs/list-item";
import { OPERATION_LABELS } from "./approvals-tabs";
import { formatShortDateTime } from "./format-time";

type BadgeVariant = React.ComponentProps<typeof Badge>["variant"];

/**
 * 봇 작업 상태 → 운영자가 읽는 라벨·배지.
 *
 * 9개 상태가 7개 라벨로 접힌다 — 큐에 있든 실행 중이든 운영자가 할 일은 같으므로
 * ("기다린다") 같은 라벨을 준다. 색은 심각도 축만 탄다(P8 §1): 손이 필요한 것만
 * 유채색이고 진행·보류는 무채색 `outline` 이다. 전부 칠하면 실패가 안 보인다.
 */
export const STATUS_BADGE: Record<string, { label: string; variant: BadgeVariant }> = {
  SUCCEEDED: { label: "완료", variant: "status-success" },
  QUEUED: { label: "진행 중", variant: "outline" },
  CLAIMED: { label: "진행 중", variant: "outline" },
  RUNNING: { label: "진행 중", variant: "outline" },
  NEEDS_EXTERNAL_EXECUTOR: { label: "보류", variant: "outline" },
  RESOURCE_DEFERRED: { label: "보류", variant: "outline" },
  NEEDS_APPROVAL: { label: "승인 대기", variant: "status-pending" },
  FAILED_RETRYABLE: { label: "재시도 중", variant: "status-caution" },
  FAILED_FINAL: { label: "실패", variant: "destructive" },
  FAILED_SECURITY: { label: "차단됨", variant: "destructive" },
};

/** 모르는 상태는 원문을 그대로 보여준다 — 조용히 빈 칸이 되면 무슨 일인지 알 수 없다. */
function resolveStatus(status: string): { label: string; variant: BadgeVariant } {
  return STATUS_BADGE[status] ?? { label: status, variant: "outline" };
}

const COLUMNS = ["시각", "작업", "상태", "요약", "결과"] as const;

/**
 * 「완료 포함」 토글. 표와 빈 상태가 **같은 토글**을 써야 한다 — 빈 목록일 때 토글이
 * 사라지면 성공만 있는 구간에서 운영자가 필터를 풀 방법이 없어진다(빈 화면을
 * 고장으로 읽는 자리).
 *
 * ⛔ 평범한 `Button` 으로 되돌리지 말 것 — `aria-pressed` 만 붙은 ghost 버튼은 켜져
 * 있어도 **눈에는 꺼진 것과 똑같이** 보인다(화면낭독기만 상태를 안다). `Toggle` 은
 * 눌린 상태에 배경(`aria-pressed:bg-muted`)을 주므로 켜진 필터가 보인다.
 */
export function SucceededToggle({
  includeSucceeded,
  onToggle,
}: {
  includeSucceeded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-end">
      <Toggle
        size="sm"
        variant="outline"
        pressed={includeSucceeded}
        onPressedChange={() => onToggle()}
      >
        완료 포함
      </Toggle>
    </div>
  );
}

/**
 * BotActivityTable — 결재함 「봇 활동」 표 (Plan 2 Task 4).
 *
 * 이 표가 답하는 질문은 "봇이 무엇을 하다 막혔나"다. 그래서 기본 목록은 성공을
 * 제외하고, 성공까지 보고 싶을 때만 「완료 포함」을 켠다(토글 상태는 `aria-pressed`
 * 가 알린다 — 켜진 필터가 보이지 않으면 빈 목록을 고장으로 읽는다).
 */
export function BotActivityTable({
  items,
  includeSucceeded,
  onToggleSucceeded,
}: {
  items: AgentJobListItem[];
  includeSucceeded: boolean;
  onToggleSucceeded: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <SucceededToggle includeSucceeded={includeSucceeded} onToggle={onToggleSucceeded} />

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left">
          {/* 표에 이름을 준다 — 화면낭독기는 표에 들어설 때 이 말로 어디인지 안다. */}
          <caption className="sr-only">봇 활동 내역</caption>
          <thead>
            <tr className="border-b border-border/70">
              {COLUMNS.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="px-2 py-2 text-[11px] font-medium uppercase tracking-[0.05em] text-slate-500"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const status = resolveStatus(item.status);
              const operationLabel = item.payloadUnreadable
                ? "알 수 없음"
                : OPERATION_LABELS[item.operation] ?? item.operation;
              const summary = item.resultSummary ?? item.failureCode;

              return (
                <tr key={item.id} className="border-b border-border/40 last:border-b-0">
                  <td className="px-2 py-2 text-xs tabular-nums text-muted-foreground">
                    {formatShortDateTime(item.createdAt)}
                  </td>
                  <td className="px-2 py-2 text-[13px] font-semibold text-foreground">
                    {operationLabel}
                  </td>
                  <td className="px-2 py-2">
                    <Badge variant={status.variant}>{status.label}</Badge>
                  </td>
                  <td className="px-2 py-2">
                    {summary ? (
                      <span className="block max-w-[32rem] truncate text-xs text-muted-foreground">
                        {summary}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs">
                    {item.actionProposalId ? (
                      <Link
                        href={`/approvals/${item.actionProposalId}`}
                        aria-label={`${operationLabel} 결과 보기`}
                        className="text-primary underline-offset-4 hover:underline"
                      >
                        결과
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
