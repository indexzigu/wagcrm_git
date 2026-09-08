/**
 * 크론의 **실질 실패 선언** 공용 판정 — `withSystemTaskStatus` 의 `CronOutcomeBody` 계약
 * (`src/lib/system-task-status.ts`)에서 핸들러가 답해야 하는 질문 하나를 재사용 가능한
 * 형태로 둔다: **"이번 실행이 통째로 헛돌았는가."**
 *
 * ⚠️ **판정 기준은 산출량이 아니라 「시도했는데 하나도 성공하지 못했는가」다.** 대상이 없던
 * 날은 산출도 0이지만 정상이므로, 산출량으로 재면 조용한 날마다 빨강이 되어 습관화로 신호를
 * 잃는다(P7·P6 이 반복 경고하는 실패 모드). 그래서 **`attempted === 0` 은 언제나 정상**이다.
 *
 * ⛔ **개별 항목 실패를 승격하지 않는다** — 썸네일 1건, 셀러 1명 실패는 상시 노이즈다.
 * 승격은 "전량"일 때만 일어난다. 되돌리지 말 것(`CronOutcomeBody` 주석의 실사고).
 *
 * **무엇이 `attempted`·`succeeded` 인가는 잡마다 다르고 호출부가 정한다** — 멱등 게이트로
 * 건너뛴 대상(`skipped`)은 시도가 아니고, 데드라인 이월분도 실패가 아니다. 이 함수는 그
 * 정의를 대신 내려 주지 않는다(도메인 지식은 핸들러에 있다는 것이 계약의 전제다).
 *
 * ℹ️ `capture-stories` 의 `declareStoryCaptureOutcome`(`src/lib/story-capture.ts`)은 이 함수로
 * 접지 않는다 — 그쪽은 **로컬 러너와 공유하는 도메인 SSOT** 라 결과 타입까지 함께 들고 있고,
 * 여기로 옮기면 두 레인이 공유하던 지점이 흩어진다.
 */
export function declareTotalFailure(input: {
  /** 이번 실행이 실제로 손을 댄 대상 수(멱등 스킵·이월분 제외) */
  attempted: number;
  /** 그중 성공한 수 */
  succeeded: number;
  /** 대상의 단위 — "명" · "건" 등. 사유 문구에 그대로 들어간다 */
  unit: string;
  /** 무엇을 하다 실패했는가 — "인스타 지표 수집" 등 */
  what: string;
}): { failed: boolean; failureReason?: string } {
  const { attempted, succeeded, unit, what } = input;
  if (attempted > 0 && succeeded === 0) {
    return { failed: true, failureReason: `${what} 대상 ${attempted}${unit} 전량 실패(성공 0)` };
  }
  return { failed: false };
}
