import { isRemoteDatabaseUrl } from "../src/lib/prisma-client";

/**
 * mock 수집을 켜는 검증 스크립트의 사전 점검.
 *
 * 왜: 이 스크립트들은 임시 셀러를 만든 뒤 수집기를 돌리는데, 수집기는 **모니터링
 * 대상 셀러 전원**을 훑는다. 레포 `.env` 의 `DATABASE_URL` 은 프로덕션 Supabase 이므로
 * (AGENTS.md P0) `set -a; source .env` 후 그냥 실행하면 실 셀러 전원에게 난수 팔로워가
 * 적립된다 — 실측 오염(`SellersHistory.source="MOCK"` 14건·셀러 8명)의 경로다.
 *
 * 수집기·쓰기 경로에는 이제 가드가 있어 오염 자체는 막히지만(`mockCollectBlockedReason`),
 * 그 상태로 실행하면 "팔로워가 갱신되지 않았다"는 **엉뚱한 실패 메시지**로 끝난다.
 * 그래서 여기서 먼저 사유를 밝히고 멈춘다(P0 No Silent Failure — 원인을 오독하게 만드는
 * 실패도 삼킴이다).
 */
export function assertLocalDbForMockRun(scriptLabel: string): void {
  if (!isRemoteDatabaseUrl()) return;
  throw new Error(
    `[${scriptLabel}] DATABASE_URL 이 원격 DB(비-sqlite)입니다 — mock 수집 검증은 프로덕션 DB 에서 돌릴 수 없습니다.\n` +
      `  로컬 sqlite 로 실행하세요: DATABASE_URL=file:./dev.db npx tsx scripts/<이 스크립트>.ts`,
  );
}
