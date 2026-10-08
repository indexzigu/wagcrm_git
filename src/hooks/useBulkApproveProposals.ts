import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { runBulkApprove, type BulkApproveResponse } from "@/lib/action-proposal-bulk";

/**
 * 기안 일괄 승인 훅 — 결재함 대기 탭의 「선택한 N건 승인」.
 *
 * 단건 승인·반려(`useProposalActions`)와 파일을 나눈 이유: 그 훅의 모양은 기안 카드
 * (`proposal-card.tsx`)가 `typeof useProposalActions` 로 주입받는 계약이라, 필드를 더하면
 * 일괄 승인과 무관한 카드 테스트 스텁까지 깨진다.
 *
 * 던지지 않는다 — 부분 실패가 정상 결과다(`runBulkApprove`). 끝나면 **한 번** 무효화한다:
 * 건마다 치면 처리 도중 대기 목록이 계속 다시 받아져 진행 중인 화면이 흔들린다. 무효화 키는
 * 단건 경로(`useProposalActions`)와 같은 세 갈래다 — 상세 2종 + 인박스 전 탭(프리픽스).
 */
export function useBulkApproveProposals() {
  const queryClient = useQueryClient();

  return React.useCallback(
    async (
      ids: readonly string[],
      options: { onProgress?: (done: number, total: number) => void } = {}
    ): Promise<BulkApproveResponse> => {
      try {
        return await runBulkApprove(ids, { onProgress: options.onProgress });
      } finally {
        for (const id of ids) {
          queryClient.invalidateQueries({ queryKey: ["action-proposal", id] });
          queryClient.invalidateQueries({ queryKey: ["approval-detail", id] });
        }
        queryClient.invalidateQueries({ queryKey: ["action-proposals"] });
      }
    },
    [queryClient]
  );
}
