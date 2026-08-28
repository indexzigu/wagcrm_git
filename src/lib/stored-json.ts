// 저장된 Json 필드 읽기 — 단일 진실 원천 (client-safe, 순수. Prisma 무의존).
//
// 🪤 **이 레포의 Json 컬럼은 프로바이더에 따라 모양이 다르다.** 리포지토리들이
// "Postgres 는 객체 그대로, SQLite 는 문자열 직렬화"로 이원화해 저장하기 때문이다
// (`actionProposalRepository` · `priceSheetRepository` · `priceMonitorSnapshotRepository` ·
// `assistantConversationRepository`). **리포지토리를 거치지 않고 raw Prisma 로 읽으면
// 그 문자열이 그대로 올라온다** — 역직렬화는 리포지토리 쪽에만 있다.
//
// 그래서 raw 읽기 경로에서 `value as SomeType` 로 캐스팅하면 **Postgres 에서는 통하고
// SQLite 에서만 조용히 빈 값이 된다.** 타입 시스템도 테스트도 잡지 못한다 — 픽스처를
// 객체(프로덕션 모양)로만 만들면 초록이기 때문이다. 실제로 두 번 발생했다:
//   · 기안 dedup 키가 로컬에서 통째로 뚫렸다(중복 기안 생성)
//   · 가격표 「반영 결과」 카드가 성공한 반영을 "생성 0건"으로 그렸다
//
// ⛔ Json 컬럼을 raw Prisma 로 읽었으면 캐스팅하지 말고 이 함수를 통과시킨다.

/** 저장된 Json 값을 객체로 되돌린다. 문자열이면 파싱하고, 실패하면 null. */
export function parseStoredJson<T = Record<string, unknown>>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      // 깨진 값으로 판정을 흔들지 않는다 — 호출부가 "없음"으로 다루게 한다.
      return null;
    }
  }
  return value as T;
}

/** 객체를 기대하는 자리용 — null·배열·원시값을 빈 객체로 접는다. */
export function parseStoredJsonObject(value: unknown): Record<string, unknown> {
  const parsed = parseStoredJson<unknown>(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
