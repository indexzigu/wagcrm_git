/**
 * 승인 뒤 실행 전에 멈춘 기안 복구 (T-311).
 *
 * ## 무슨 일이 생기나
 * `approveProposal` 은 승인(tx1: →APPROVED)과 실행(tx2: 실행 쓰기 + APPROVED→EXECUTED)을 두 트랜잭션으로 나눈다
 * (`approve-proposal.ts` 헤더). tx1 커밋 뒤 프로세스가 죽거나, tx2 가 실패한 뒤 FAILED 기록까지 실패하면 기안이
 * APPROVED 로 남는다. APPROVED 는 결재함 어느 탭에도 없고(`approvals-tabs.ts`), 승인 본체는 PENDING_APPROVAL·FAILED
 * 만 받으며, 슬랙은 「이미 처리됨」으로 답한다 — 오너가 볼 수도, 다시 시도할 수도 없다. 자동 실행기의 정리
 * (`settlement-auto-execute.ts` 「멈춘 승인 정리」)는 `SYSTEM_AUTO` 승인만, 그것도 스위치가 켜졌을 때만 본다.
 *
 * ## 무엇을 하나
 * 마지막 변경이 `STALE_APPROVED_MS` 보다 오래된 APPROVED 기안을 저장소 CAS 전이(`expectedFrom: "APPROVED"`)로
 * FAILED 로 보낸다. 그러면 결재함 「실패」 탭(배지 포함)에 뜨고, 기존 재시도 경로(FAILED→APPROVED→실행)가 그대로
 * 적용된다. 새 상태·새 탭·새 전이를 만들지 않는다(TRANSITIONS 는 APPROVED→FAILED 를 이미 허용한다).
 *
 * ## 왜 이중 실행이 생기지 않나 (⛔ 이 근거가 깨지면 이 복구를 돌리면 안 된다)
 * ① **APPROVED 이면 실행 쓰기는 커밋되지 않았다.** 실행 쓰기는 tx2 안에서만 일어나고(`WriteActionHandler` 는 `tx`
 *    만 받는다 — 외부 IO 는 커밋 뒤 `write-action-effects.ts` 소관, `write-actions/types.ts`), 같은 tx2 가
 *    APPROVED→EXECUTED 를 함께 커밋한다. 그러니 커밋된 실행은 반드시 EXECUTED 를 동반하고, 행이 APPROVED 라면
 *    그 실행은 롤백됐거나 시작되지 않은 것이다. 가격표 반영(`price-sheet/apply-executor.ts`)도 같은 짝 구조다.
 * ② **아직 실행 중인 tx2 와 겹쳐도 한쪽만 이긴다.** 이 함수의 FAILED 전이와 tx2 의 EXECUTED 전이는 둘 다
 *    「status = APPROVED 일 때만」 갱신하는 조건부 쓰기라 같은 행 잠금에서 직렬화된다. tx2 가 먼저면 여기가 0건
 *    (ConcurrentModificationError → 건너뜀), 여기가 먼저면 tx2 의 EXECUTED 전이가 0건이 되어 tx2 전체(실행 쓰기
 *    포함)가 롤백된다. 문턱 시간(`STALE_APPROVED_MS`)은 정상 실행(tx 시간 상한 최대 30초,
 *    `create-sales-campaign-group-round.ts`)과 겹치지 않게 하는 여유일 뿐, 안전의 근거는 이 CAS 다.
 * ③ **재시도 뒤에도 실행은 한 번뿐이다.** EXECUTED 는 종착 상태(TRANSITIONS: EXECUTED→[])이고 모든 실행은
 *    APPROVED→EXECUTED 조건부 전이와 함께만 커밋되므로, 같은 기안의 실행이 두 번 커밋될 수 없다.
 * 🪤 새 쓰기 액션이 트랜잭션 밖에서 쓰거나(전역 `getPrisma()`) 외부 API 를 tx2 안에서 부르면 ①이 깨진다 —
 *    그때 이 복구는 「실행됐는데 FAILED」를 만들어 재시도 시 이중 반영을 부른다. 그 계약은 `write-actions/types.ts`
 *    의 핸들러 서명과 주석이 지킨다.
 *
 * 자동 실행기의 「멈춘 승인 정리」(`sweepStuckApproved`)는 일부러 남긴다 — 그 회차 함수는 크론 라우트 밖(시험 등)에서도
 * 단독으로 불리고, 거기서는 이 복구가 먼저 돌지 않는다. 크론 라우트에서는 이 복구가 먼저 돌아 그쪽은 대개 0건이다.
 * 문턱 값은 그쪽이 이 파일의 `STALE_APPROVED_MS` 를 그대로 가져다 쓴다(두 값이 갈라지지 않게).
 *
 * 캘린더에서 들어온 기안은 승인 실패 경로(`approveProposal` 의 FAILED 기록)와 같게 수집 행을 재판정 대기로 돌린다.
 */
import { getPrisma } from "@/lib/prisma";
import { parseStoredJson } from "@/lib/stored-json";
import { readCalendarInboundRef, resetInboundForRetry } from "@/lib/calendar-inbound/adopt";
import { ActionProposalRepository, ConcurrentModificationError } from "@/repositories/actionProposalRepository";

/** 이보다 오래 APPROVED 인 기안을 멈춘 것으로 본다(자동 실행기의 `STUCK_APPROVED_MS` 가 이 값을 가져다 쓴다). */
export const STALE_APPROVED_MS = 10 * 60 * 1000;
/**
 * 결재함 「실패」 카드와 이력에 그대로 보이는 문구. 「다시 시도」를 약속하지 않는다 — 가격표 반영 기안
 * (`price_sheet_apply`)은 결재함 재시도가 아니라 가격표 화면에서 다시 반영한다(payload 모양이 다르다).
 */
export const STALE_APPROVED_NOTE = "승인 뒤 실행이 끝나지 않아 실패로 돌렸습니다. 실행 내용은 반영되지 않았습니다.";
export const STALE_APPROVED_ACTOR = "SYSTEM";
/** 한 회차 상한 — 2분마다 도는 크론이라 밀린 건은 다음 회차가 집는다. */
const MAX_PER_PASS = 50;

export type StaleApprovedRecoveryResult = { recovered: number; errors: number };

/** 전이 실패 뒤 — 행이 더는 APPROVED 가 아니면 true. 다시 읽지 못하면 false(오류로 센다). */
async function movedOn(id: string): Promise<boolean> {
  try {
    const current = await ActionProposalRepository.findById(id);
    return current !== null && current.status !== "APPROVED";
  } catch {
    return false;
  }
}

export async function recoverStaleApprovedProposals(now: Date = new Date()): Promise<StaleApprovedRecoveryResult> {
  const cutoff = new Date(now.getTime() - STALE_APPROVED_MS);
  const rows = await getPrisma().actionProposal.findMany({
    where: { status: "APPROVED", updatedAt: { lt: cutoff } },
    select: { id: true, sourceRef: true },
    orderBy: { updatedAt: "asc" },
    take: MAX_PER_PASS,
  });

  let recovered = 0;
  let errors = 0;
  for (const row of rows) {
    try {
      await ActionProposalRepository.transition(row.id, "FAILED", {
        actor: STALE_APPROVED_ACTOR,
        note: STALE_APPROVED_NOTE,
        data: { errorMessage: STALE_APPROVED_NOTE },
        expectedFrom: "APPROVED",
      });
    } catch (error) {
      // 그 사이 실행이 EXECUTED 를 커밋했거나 다른 회차가 먼저 돌렸다 — 위 헤더 ②, 건드리지 않는다.
      // 조건부 쓰기에서 지면 ConcurrentModificationError, 그 전에 읽은 상태가 이미 바뀌었으면 저장소가
      // 「허용되지 않은 전이」로 던진다 — 둘 다 「이미 APPROVED 가 아니다」라 다시 읽어 가른다.
      if (error instanceof ConcurrentModificationError || (await movedOn(row.id))) continue;
      errors += 1;
      console.error(`[stale-approved-recovery] 멈춘 승인 복구 실패 ${row.id}:`, error);
      continue;
    }
    recovered += 1;
    // SQLite 레인은 Json 을 문자열로 돌려준다(`stored-json.ts`) — 필드 단위로 먼저 푼다.
    const inboundRef = readCalendarInboundRef(parseStoredJson<unknown>(row.sourceRef));
    if (inboundRef) {
      try {
        await resetInboundForRetry(inboundRef.inboundId, row.id);
      } catch (error) {
        // 기안은 이미 FAILED 로 돌렸다(판정은 그대로) — 수집 행 표기만 보고한다.
        console.error(`[stale-approved-recovery] ${row.id} 캘린더 수집 행 재판정 대기 표기 실패:`, error);
      }
    }
  }
  return { recovered, errors };
}
