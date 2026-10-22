// [캘린더수집] 수집 스캔 단일 실행 잠금 — 크론(30분)과 「캘린더에서 가져오기」(수동)가 같은 회차를 겹쳐 돌면
// 둘 다 같은 일정을 「처음 봄」으로 읽어 기안이 두 번 생기고 해석 도우미(Gemini) 호출도 두 번 나간다.
// 그래서 `runCalendarInboundScan` 이 이 잠금 안에서만 돈다 — 겹친 쪽은 아무것도 건드리지 않고 끝난다.
//
// 모양은 정산 자동 실행기(`settlement-auto-execute.ts` 「단일 실행」)를 그대로 따른다:
// - Postgres: `pg_try_advisory_xact_lock(고정 키)` 를 **긴 트랜잭션 하나**가 쥔다. 세션 잠금은 Prisma 연결 풀에서
//   잠금·해제가 다른 연결로 갈 수 있어 쓰지 않는다. 트랜잭션 잠금은 커밋·롤백·연결 끊김에서 반드시 풀린다.
//   회차 본문은 이 트랜잭션이 아니라 일반 클라이언트로 돈다(기안 쓰기가 자기 쓰기를 한다).
//   ⚠️ 트랜잭션 시간 제한(`LOCK_TX_TIMEOUT_MS`)보다 회차 예산(`SCAN_BUDGET_MS`, scan.ts)이 짧아야 한다 —
//   시간 제한이 먼저 오면 잠금이 풀린 채 본문이 돌 수 있다.
// - sqlite·DB 미설정(개발·테스트, 단일 프로세스): 같은 프로세스 안의 플래그로 대신한다(`cron-incident.ts` 가
//   sqlite 에서 자문 잠금을 건너뛰는 것과 같은 판정 `isRemoteDatabaseUrl`).
import { getPrisma } from "@/lib/prisma";
import { isRemoteDatabaseUrl } from "@/lib/prisma-client";

/** 자문 잠금 키 — 정산 자동 실행기(7301, 1)와 겹치지 않는 고정 쌍. */
const LOCK_KEY_CLASS = 7_302;
const LOCK_KEY_OBJECT = 1;
/**
 * 잠금 트랜잭션 시간 제한 — 회차 예산(scan.ts `SCAN_BUDGET_MS` 55초)보다 넉넉히 길다. 모델 호출(로컬·Gemini)은
 * 남은 예산 안으로 시간 제한을 묶어 55초 안에 끝나고, 나머지 여유는 후보 조회와 예산을 넘겨 끝나는 마지막 일정의
 * DB 쓰기 몫이다. 회차 예산 자체는 배포 지침 「Plan Limits」의 60초 이하 규칙을 따른다.
 */
export const LOCK_TX_TIMEOUT_MS = 120_000;

let inProcessBusy = false;

/** 잠금을 잡으면 `work` 를 돌려 그 값을, 못 잡으면 `{ acquired: false }`. */
export async function withScanLock<T>(
  work: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  if (!isRemoteDatabaseUrl()) {
    if (inProcessBusy) return { acquired: false };
    inProcessBusy = true;
    try {
      return { acquired: true, value: await work() };
    } finally {
      inProcessBusy = false;
    }
  }
  return getPrisma().$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${LOCK_KEY_CLASS}::int, ${LOCK_KEY_OBJECT}::int) AS locked`;
      if (rows[0]?.locked !== true) return { acquired: false as const };
      return { acquired: true as const, value: await work() };
    },
    { maxWait: 10_000, timeout: LOCK_TX_TIMEOUT_MS },
  );
}
