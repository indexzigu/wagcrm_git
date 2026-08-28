import { Badge } from "@/components/ui/badge";
import { DeepLink } from "./deep-link";
import type { AssistantToolCallView } from "./types";

const TOOL_LABELS: Record<string, string> = {
  get_settlement_report: "정산 리포트",
  search_deals: "딜 검색",
  get_pipeline_status: "파이프라인 현황",
  get_campaign_financials: "캠페인 재무",
  get_order_snapshot: "주문 스냅샷",
};

const ERROR_LABELS: Record<string, string> = {
  MISSING_PARAM: "정보 부족",
  NOT_FOUND: "데이터 없음",
  QUERY_FAILED: "조회 실패",
};

/**
 * 이번 턴에 실행된 도구 호출들의 근거(evidence)를 표로 보여준다.
 * 데이터 소스, 조회 파라미터, 성공/실패, 딥링크를 한눈에 확인할 수 있도록 한다.
 */
export function EvidenceTable({ toolCalls }: { toolCalls: AssistantToolCallView[] }) {
  if (toolCalls.length === 0) return null;

  return (
    <div className="mt-2 overflow-hidden rounded-lg border border-border">
      <table className="w-full text-left text-xs">
        <thead className="bg-muted text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">도구</th>
            <th className="px-3 py-2 font-medium">근거 데이터</th>
            <th className="px-3 py-2 font-medium">상태</th>
            <th className="px-3 py-2 font-medium">바로가기</th>
          </tr>
        </thead>
        <tbody>
          {toolCalls.map((call, idx) => (
            <tr key={`${call.toolName}-${idx}`} className="border-t border-border">
              <td className="px-3 py-2 font-medium">{TOOL_LABELS[call.toolName] ?? call.toolName}</td>
              <td className="px-3 py-2 text-muted-foreground">
                {call.evidence?.dataSources?.join(", ") || "-"}
              </td>
              <td className="px-3 py-2">
                {/* 성공/실패 이분 판정이라 완료는 `status-success` — 실패 쪽 destructive 와 한 축이다.
                    ⛔ `status-active`(네이비)로 되돌리지 말 것: 근거 정본은 proposal-card
                    `StatusChip` 주석(P8 §4 는 네이비 틴트의 판정 용법을 금지한다). */}
                {call.ok ? (
                  <Badge variant="status-success">조회 완료</Badge>
                ) : (
                  <Badge variant="destructive">
                    {call.error ? ERROR_LABELS[call.error.code] ?? call.error.code : "실패"}
                  </Badge>
                )}
              </td>
              <td className="px-3 py-2">
                <DeepLink toolCall={call} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
