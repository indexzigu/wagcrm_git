import { UserRoundIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

/**
 * SourceBadge — 기안이 어디서 만들어졌는지 배지로 보여준다 (Plan 2 · Task 3).
 *
 * `createdBy`는 사람 사용자 id 또는 두 시스템 상수 중 하나다:
 * - `AGENT_WORKER`: 슬랙봇(백그라운드 에이전트 워커)이 만든 기안.
 * - `AGENT`: 어시스턴트 채팅(대화 중 인라인 제안)이 만든 기안.
 * - 그 외(사람 사용자 id): 오너가 화면에서 직접 만든 기안.
 *
 * 기존 `기안자: {createdBy}` 텍스트(사용자 id 원문 노출)를 대체한다 — 결재함
 * 화면에서 판단에 필요한 것은 "누가"가 아니라 "어디서"이므로, 출처 3종만 구분한다.
 */
export function SourceBadge({ createdBy }: { createdBy: string }) {
  if (createdBy === "AGENT_WORKER") {
    return <Badge variant="secondary">슬랙봇</Badge>;
  }
  if (createdBy === "AGENT") {
    return <Badge variant="outline">어시스턴트</Badge>;
  }
  return (
    <Badge variant="outline">
      <UserRoundIcon className="size-3" />
      직접
    </Badge>
  );
}
