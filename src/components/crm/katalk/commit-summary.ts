/**
 * 카톡 업로드 「확정」 결과를 토스트 한 줄로 요약한다.
 *
 * 종전에는 개별 파일 실패와 무관하게 무조건 「업로드 확정이 완료되었습니다」를 띄웠다 —
 * 일부가 실패해도 성공처럼 읽혀 실패 파일을 그냥 두고 넘어가게 된다(interfaces 점검 #10).
 * 실패가 하나라도 있으면 오류 토스트(닫을 때까지 유지)로 올려 몇 건이 남았는지 말한다.
 */
export type CommitSummary =
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; description: string };

// ⚠️ 「다시 확정하세요」라고 쓰지 말 것 — 확정 버튼은 미리보기가 끝난 파일만 보내서 실패한
// 파일은 다시 확정할 길이 없다. 실재하는 복구 경로는 같은 파일을 다시 올리는 것이다(겹치는
// 기간은 서버가 중복으로 건너뛴다 — 이 탭의 업로드 안내문과 같은 사실).
const FAILED_FILE_HINT = "목록에서 실패 원인을 확인한 뒤 그 파일을 다시 올려 주세요.";

export function summarizeCommitResult(committed: number, failed: number): CommitSummary {
  if (failed === 0) {
    return { kind: "success", message: `${committed}건 업로드를 확정했습니다.` };
  }
  if (committed === 0) {
    return { kind: "error", message: `${failed}건 모두 확정하지 못했습니다.`, description: FAILED_FILE_HINT };
  }
  return {
    kind: "error",
    message: `${committed}건 확정, ${failed}건 실패했습니다.`,
    description: FAILED_FILE_HINT,
  };
}
