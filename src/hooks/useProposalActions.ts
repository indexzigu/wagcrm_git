import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";

/**
 * ActionProposal 승인/반려 공용 훅 (청사진 §3-#3).
 *
 * useApprovalInbox에 있던 approve/reject를 추출한 것 — M1 Promise 계약(호출부가
 * await하고 finally에서 pending을 해제)을 그대로 상속한다: 이 훅의 approve/reject는
 * fetch 완료(성공/실패 불문)까지 이어지는 Promise를 반환하고, 실패 시 reject한다
 * (fire-and-forget 금지 — approval-inbox.tsx M1 회귀 방지 주석 참조).
 *
 * 성공/실패 어느 경로든 자기 자신의 상세 쿼리(["action-proposal", id] — proposal-card가
 * 구독)와 인박스 목록 쿼리(actionProposals("PENDING_APPROVAL"))를 함께 invalidate한다.
 * 인박스에서 승인한 카드가 채팅 탭에서 stale PENDING으로 남지 않게 하기 위함(§1-1).
 *
 * §6-1 v1.2 추가: 인박스가 상태 탭(대기/완료/실패/반려)으로 파라미터화되며 각 탭이
 * queryKeys.actionProposals(status)로 별도 캐시를 갖는다. 실패 탭에서 재시도(승인)하면
 * 그 항목이 FAILED 탭 캐시에서 사라지고 완료/대기 탭 캐시에 나타나야 하므로, 특정 status
 * 하나만 invalidate하면 안 된다 — queryKey 프리픽스("action-proposals") invalidate로
 * 모든 상태 탭 캐시를 함께 갱신한다(TanStack Query는 prefix match). 기존
 * PENDING_APPROVAL 정확 키 invalidate는 하위 호환을 위해 그대로 유지한다(이미
 * 프리픽스 invalidate에 포함되므로 중복이지만 기존 테스트 계약을 보존한다).
 */
export function useProposalActions() {
  const queryClient = useQueryClient();

  const invalidate = React.useCallback(
    (id: string) => {
      queryClient.invalidateQueries({ queryKey: ["action-proposal", id] });
      queryClient.invalidateQueries({ queryKey: queryKeys.actionProposals("PENDING_APPROVAL") });
      // 프리픽스 invalidate — status 무관하게 모든 인박스 탭 캐시 정합(§6-1).
      queryClient.invalidateQueries({ queryKey: ["action-proposals"] });
    },
    [queryClient]
  );

  const approve = React.useCallback(
    async (id: string) => {
      const res = await fetch(`/api/action-proposals/${id}/approve`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      invalidate(id);
      if (!res.ok) {
        throw new Error(body?.error || `승인 처리에 실패했습니다 (status=${res.status})`);
      }
      return body;
    },
    [invalidate]
  );

  const reject = React.useCallback(
    async (id: string) => {
      const res = await fetch(`/api/action-proposals/${id}/reject`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      invalidate(id);
      if (!res.ok) {
        throw new Error(body?.error || `반려 처리에 실패했습니다 (status=${res.status})`);
      }
      return body;
    },
    [invalidate]
  );

  return { approve, reject };
}
