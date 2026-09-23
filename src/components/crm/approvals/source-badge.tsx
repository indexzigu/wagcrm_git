import { SparklesIcon, UserRoundIcon } from "lucide-react";
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
 *
 * 셋이 **눈으로도** 갈라져야 한다: 슬랙봇은 채운 배지(secondary), 어시스턴트와 직접은
 * 같은 outline 이라 글자만으로 구분되던 자리에 아이콘을 하나씩 준다. 아이콘은 장식이라
 * `aria-hidden` 이고 — 뜻은 옆 글자가 전부 말한다.
 *
 * ⛔ 아이콘에 `size-*` 를 붙이지 말 것: `Badge` 프리미티브의 `[&>svg]:size-3!` 가
 * 언제나 이기므로 소비처의 크기 선언은 **읽히지 않는 죽은 클래스**다(P8 §6-2).
 */
export function SourceBadge({ createdBy }: { createdBy: string }) {
  if (createdBy === "AGENT_WORKER") {
    return <Badge variant="secondary">{sourceLabelOf(createdBy)}</Badge>;
  }
  if (createdBy === "AGENT") {
    return (
      <Badge variant="outline">
        <SparklesIcon aria-hidden />
        {sourceLabelOf(createdBy)}
      </Badge>
    );
  }
  return (
    <Badge variant="outline">
      <UserRoundIcon aria-hidden />
      {sourceLabelOf(createdBy)}
    </Badge>
  );
}

/**
 * 배지에 적히는 그 말 — 배지를 못 쓰는 자리(페이지 설명 줄 같은 평문)가 쓴다.
 * ⛔ 라벨을 그쪽에서 다시 쓰지 말 것: 출처 이름이 바뀌면 한쪽만 낡는다.
 */
export function sourceLabelOf(createdBy: string): string {
  if (createdBy === "AGENT_WORKER") return "슬랙봇";
  if (createdBy === "AGENT") return "어시스턴트";
  return "직접";
}
