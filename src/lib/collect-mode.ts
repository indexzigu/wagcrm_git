/**
 * 수집 모드(`*_COLLECT_MODE`) 해석 SSOT.
 *
 * 왜 있는가: 예전에는 각 호출부가 `process.env.X_COLLECT_MODE || "mock"` 으로
 * 읽었다. 이건 **변수를 켰을 때가 아니라 없을 때** mock 으로 떨어지는 fail-open
 * 이었고, mock 은 출처만 가짜일 뿐 저장 경로는 실제라 난수 팔로워가 프로덕션
 * DB 까지 도달했다(실측: `SellersHistory.source="MOCK"` 14건·셀러 8명).
 * 로컬 `.env` 에 이 키가 없어 **아무것도 설정하지 않은 세션이 가장 위험**했다.
 *
 * 그래서 mock 을 **명시 opt-in** 으로 되돌린다 — 미설정은 mock 이 아니라
 * "미설정" 이고, 호출부는 그걸 각자의 방식으로 거부한다:
 *  - 사용자 트리거 라우트 → 에러 응답(조용히 스킵하면 안 됨)
 *  - 크론 수집기 → 사유를 남기고 skip(throw 하면 크론 전체가 죽는다)
 *
 * ⚠️ **미인식 값은 여기서 거르지 않는다.** `mock|apify|api` 외에
 * `instagram`·`youtube` 도 수집기에서 쓰이는 정상 값이고(`instagram-collector`
 * 의 `getSnapshotSource`), 프로덕션 설정값을 직접 확인할 수 없는 상태라
 * 화이트리스트로 막으면 프로덕션을 깨뜨릴 수 있다. `resolveCollectMode` 의 계약은
 * "설정됐는가" 하나뿐이다 — DB 안전 판정은 아래 `mockCollectBlockedReason` 이
 * 별도 함수로 담당한다(같은 `null` 이 "미설정"과 "거부됨"을 동시에 뜻하면 호출부가
 * 사유를 잘못 보고한다).
 */

import { isRemoteDatabaseUrl } from "@/lib/prisma-client";

export type CollectPlatform = "INSTAGRAM" | "YOUTUBE" | "X";

const ENV_KEY: Record<CollectPlatform, string> = {
  INSTAGRAM: "INSTAGRAM_COLLECT_MODE",
  YOUTUBE: "YOUTUBE_COLLECT_MODE",
  X: "X_COLLECT_MODE",
};

/** 해당 플랫폼의 수집 모드. **미설정(빈 문자열 포함)이면 `null`** — mock 으로 떨어지지 않는다. */
export function resolveCollectMode(platform: CollectPlatform): string | null {
  const raw = process.env[ENV_KEY[platform]]?.trim();
  return raw ? raw : null;
}

/** 미설정 사유 문구 — 라우트 에러 응답과 수집기 skip 로그가 같은 문장을 쓴다. */
export function collectModeUnsetReason(platform: CollectPlatform): string {
  return `${ENV_KEY[platform]} 미설정: 수집 모드가 지정되지 않았습니다(로컬 예행은 값을 명시하세요).`;
}

/**
 * mock 모드가 **쓰기를 해도 되는 DB 인가** — 아니면 거부 사유, 괜찮으면 `null`.
 *
 * 왜 필요한가(2026-07-30, 서술만 있고 가드가 없어 재발한 사고): mock 은 **출처만
 * 가짜고 저장 경로는 실제**다. 팔로워 수집기의 mock 은 no-op 이 아니라 난수를 만들어
 * `recordSellerMetricsSnapshot(..., "MOCK")` + `Seller.currentFollowers` 까지 쓴다.
 * 그런데 이 레포 `.env` 의 `DATABASE_URL` 은 **프로덕션 Supabase** 라, 로컬에서
 * `INSTAGRAM_COLLECT_MODE=mock` 으로 dev 서버·수집 스크립트를 돌리면 가짜 팔로워가
 * 프로덕션 셀러 추이에 그대로 적립된다 — 위 문단의 오염이 그 경로이고, 로컬 세션
 * 유입으로 판정돼 오너 승인 후 삭제됐다.
 * "prod DB 에 붙은 채로 켜지 말 것"이 문서에만 있었기 때문에 재발했다 — 이제 코드가 막는다.
 *
 * 판정은 **DB 연결 문자열**로 한다(`isRemoteDatabaseUrl`). 모드 이름이나 `NODE_ENV`
 * 가 아니라 "이 쓰기가 어디로 가는가"가 위험의 실체이고, 워크트리·CI·크론이 전부
 * 같은 코드를 돌리므로 환경 이름으로는 구분되지 않는다.
 *
 * 반환은 throw 가 아니다 — 호출부의 거부 방식이 서로 다르다(크론 수집기는
 * `result.errors` + skip, 사용자 트리거 라우트는 에러 응답). 문구는 한 곳에서 나온다.
 */
export function mockCollectBlockedReason(
  platform: CollectPlatform,
  mode: string | null,
): string | null {
  if (mode !== "mock") return null;
  if (!isRemoteDatabaseUrl()) return null;
  // ⛔ DATABASE_URL 자체는 문구에 담지 않는다(자격증명 포함 — P0 시크릿 노출).
  return (
    `${ENV_KEY[platform]}=mock 인데 DATABASE_URL 이 원격 DB(비-sqlite)를 가리킵니다. ` +
    `난수 데이터를 실 DB 에 적립할 수 없어 거부합니다. 로컬 예행은 sqlite(\`npm run dev:local\`)에서 하세요.`
  );
}
