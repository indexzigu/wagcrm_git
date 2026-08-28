import { toast } from "sonner";

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
 * @param errorMessage 실패 시 출력할 에러 메시지 (기본값: "저장 중 오류가 발생했습니다.")
 * @returns 원본 promise의 결과
 */
export async function withMutationFeedback<T>(
  promise: Promise<T>,
  successMessage?: string,
  errorMessage: string = "저장 중 오류가 발생했습니다."
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
    const message = error instanceof Error ? error.message : errorMessage;
    toast.error(message);
    throw error;
  } finally {
    // 카운터 감소 및 클래스 제거
    pendingMutationsCount--;
    if (pendingMutationsCount === 0) {
      document.body.classList.remove("mutation-pending");
    }
  }
}
