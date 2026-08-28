// prisma-errors — Prisma 에러 코드 판정 가드(순수 함수).
// sqlite/postgres 생성 클라이언트가 달라 instanceof 대신 code 문자열로 판정한다
// (promote-content의 기존 isSerializationConflict 선례를 공용 lib으로 승격 — H1).

function hasPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

/**
 * unique 제약/인덱스 위반(P2002) 판정.
 * H1 부분 유니크 인덱스(Asset_entity_externalUrl_active_key) 위반 시 동시 요청의 진 쪽이
 * 이 에러를 받으므로, 라우트는 기존 활성 Asset을 재조회해 alreadyExists로 폴백한다.
 */
export function isUniqueViolation(error: unknown): boolean {
  return hasPrismaErrorCode(error, "P2002");
}

/** Prisma 직렬화 충돌(P2034) 판정 — Serializable 트랜잭션 경쟁 패배 폴백용. */
export function isSerializationConflict(error: unknown): boolean {
  return hasPrismaErrorCode(error, "P2034");
}
