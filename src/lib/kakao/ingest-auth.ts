/**
 * 카카오 인제스트 관련 라우트(work-records/ingest, chat-room-mappings*)의 공용 인증 검증.
 * naver-order-sync/route.ts(collect-instagram 패턴 복제)의 verifyCronAuth와 동형이나,
 * 스코프 혼입 방지를 위해 CRON_SECRET이 아닌 별도 INGEST_TOKEN을 사용한다.
 * B4-1 x-agent-key는 비프로덕션 한정이라 프로덕션 카톡 인제스트에는 사용할 수 없다(청사진 §3).
 *
 * INGEST_TOKEN env가 설정되지 않은 경우 무조건 실패(fail-closed) — 토큰 미설정을 "인증 생략"으로
 * 오인하는 사고를 막는다.
 */
export function verifyIngestAuth(request: Request): boolean {
  const authHeader = request.headers.get("authorization");
  const expected = `Bearer ${process.env.INGEST_TOKEN}`;
  return Boolean(process.env.INGEST_TOKEN) && authHeader === expected;
}
