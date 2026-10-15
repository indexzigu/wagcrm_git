/**
 * DB 가 「권한 없음」(SQLSTATE 42501)으로 거절한 오류인가. 워커 role 은 칸·행 단위로 좁게 열려 있어
 * (20261009150000 마이그레이션) 실행기가 허용 밖 칸을 읽으려 하면 여기로 온다. 이것은 다시 해도
 * 같은 결과라 **재시도 대상이 아니다** — 재시도로 돌리면 같은 실패를 세 번 반복하고 원인이 흐려진다.
 * 오류 문구는 접속 대상·표 이름을 담을 수 있어 결과에 싣지 않고 분류만 남긴다.
 *
 * 봇 실행기(`agent-worker/executor.ts`)가 이 판정으로 `DB_PERMISSION_DENIED` 최종 실패를 만든다.
 * 봇이 재사용하는 도구(`agent/tools/*`)는 DB 예외를 `queryFailed` 로 감싸면 Prisma 원시 쿼리 오류의
 * `meta.code` 가 사라지므로, 이 판정에 걸리는 예외는 감싸지 말고 그대로 다시 던진다.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } | null; message?: unknown };
  if (candidate.code === "42501" || candidate.meta?.code === "42501") return true;
  return typeof candidate.message === "string" && /permission denied|\b42501\b/i.test(candidate.message);
}
