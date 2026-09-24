import { toast } from "@/lib/toast";

/** 원인을 모를 때(Error 가 아닌 거절)의 제목. */
export const DEFAULT_MUTATION_ERROR = "저장하지 못했습니다.";

/**
 * 오류 토스트의 둘째 줄 — 「무엇을 하면 되는가」. 제목(원인)은 서버 메시지가 채우는데 대개
 * 원인만 말하고 할 일은 말하지 않는다(interfaces 점검 #9, 2026-09-24).
 */
export const MUTATION_RETRY_HINT = "연결을 확인하고 다시 시도하세요.";

// 동시 실행되는 mutation 개수 추적
let pendingMutationsCount = 0;

/**
 * Promise를 래핑하여 실행 중일 때 커서를 `progress`로 변경하고,
 * 실패 시에만 `toast.error`를 띄워주는 유틸리티 함수.
 * 
 * CRM 환경에서 매번 성공 토스트가 뜨는 시각적 소음을 방지하고,
 * 가장 자연스러운 피드백(마우스 커서)을 제공합니다.
 * 
 * @param promise 실행할 비동기 작업
 * @param errorMessage Error 가 아닌 값으로 거절됐을 때의 제목 (기본값: `DEFAULT_MUTATION_ERROR`)
 * @param recoveryHint 오류 토스트 둘째 줄의 할 일 (기본값: `MUTATION_RETRY_HINT`)
 * @returns 원본 promise의 결과
 */
export async function withMutationFeedback<T>(
  promise: Promise<T>,
  successMessage?: string,
  errorMessage: string = DEFAULT_MUTATION_ERROR,
  recoveryHint: string = MUTATION_RETRY_HINT
): Promise<T> {
  // 클라이언트 환경에서만 DOM 조작
  if (typeof window === "undefined") return promise;

  // 카운터 증가 및 클래스 추가
  pendingMutationsCount++;
  if (pendingMutationsCount === 1) {
    document.body.classList.add("mutation-pending");
  }

  try {
    const result = await promise;
    if (successMessage) {
      toast.success(successMessage);
    }
    return result;
  } catch (error) {
    // 에러 발생 시 토스트
    const message = error instanceof Error && error.message ? error.message : errorMessage;
    toast.error(message, { description: recoveryHint });
    throw error;
  } finally {
    // 카운터 감소 및 클래스 제거
    pendingMutationsCount--;
    if (pendingMutationsCount === 0) {
      document.body.classList.remove("mutation-pending");
    }
  }
}
