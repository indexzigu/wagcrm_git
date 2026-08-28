import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { EvidenceTable } from "./evidence-table";
import { ProposalCard } from "./proposal-card";
import { TOOL_RESULT_RENDERERS } from "./tool-result-views";
import type { AssistantMessage } from "./types";

function MessageBubble({
  message,
  onQuickAction,
}: {
  message: AssistantMessage;
  onQuickAction?: (text: string) => void;
}) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-lg px-3.5 py-2.5 text-sm leading-relaxed",
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-card text-foreground"
        )}
      >
        {message.text}
      </div>

      {!isUser && message.isClarification && (
        <Badge variant="status-pending" className="ml-0.5">
          추가 정보 필요
        </Badge>
      )}

      {!isUser && message.lintWarnings && message.lintWarnings.length > 0 && (
        <div className="max-w-[85%] rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          이 답변에 확정 단정 표현이 포함되었을 수 있습니다. 예정/확정/지급완료 상태를 다시 확인해 주세요.
        </div>
      )}

      {/* 청사진 §1-1/§3-#6: model 메시지에 이번 턴 생성된 기안이 있으면 말풍선 아래
          ID별 ProposalCard를 렌더한다. toolCalls 유무와 무관한 독립 경로(§4 상호독립). */}
      {!isUser && message.actionProposalIds && message.actionProposalIds.length > 0 && (
        <div className="flex w-full max-w-[85%] flex-col gap-2">
          {message.actionProposalIds.map((proposalId) => (
            <ProposalCard key={proposalId} id={proposalId} />
          ))}
        </div>
      )}

      {!isUser && message.toolCalls && message.toolCalls.length > 0 && (
        <div className="w-full max-w-[85%]">
          {/* 청사진 §2-1/§3-#6/§7-2: ok && data가 있고 레지스트리에 있는 toolCall만 EvidenceTable
              위에 리치 블록을 추가로 렌더한다. EvidenceTable(근거 표시)은 항상 그대로 유지된다 —
              truncated(data 제거) 메시지는 data가 없으므로 자동으로 리치 렌더가 스킵된다.
              onQuickAction은 정산 리포트 행 액션(§7-2) 등 리치 뷰의 콘텍스트 퀵액션에 쓰인다. */}
          {message.toolCalls.map((call, idx) => {
            if (!call.ok || !call.data) return null;
            const RichView = TOOL_RESULT_RENDERERS[call.toolName];
            if (!RichView) return null;
            return (
              <RichView
                key={`${call.toolName}-${idx}-rich`}
                data={call.data}
                onQuickAction={onQuickAction}
              />
            );
          })}
          <EvidenceTable toolCalls={message.toolCalls} />
          {/* ts-review Minor-2 / 청사진 §1-2: 저장 캡 초과로 결과 데이터가 제거된 재수화 메시지 안내 */}
          {message.toolCallsTruncated && (
            <div className="mt-1 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
              결과 데이터는 저장 용량(64KB) 초과로 요약 저장되었습니다. 근거(도구·조건)만 표시됩니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  onQuickAction,
}: {
  messages: AssistantMessage[];
  // 청사진 §7-2: assistant-client의 sendMessage를 관통시키는 콜백. ToolResultView(리치
  // 렌더 블록)까지 전달되어 정산 리포트 행 액션 등 콘텍스트 퀵액션에 쓰인다.
  onQuickAction?: (text: string) => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        정산, 딜, 파이프라인, 캠페인 재무, 주문 현황을 자연어로 물어보세요.
        <br />
        예: &quot;이번 달 정산 현황 알려줘&quot;, &quot;OO 셀러 캠페인 파이프라인 상태는?&quot;
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      {messages.map((message) => (
        <MessageBubble key={message.id} message={message} onQuickAction={onQuickAction} />
      ))}
    </div>
  );
}
