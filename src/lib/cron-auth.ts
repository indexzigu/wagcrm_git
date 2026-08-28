import { timingSafeEqual } from "node:crypto";

/**
 * 크론·웹훅 라우트의 공유 시크릿 인증 SSOT.
 *
 * ## 왜 이 파일이 있나
 *
 * `/api/cron/*` 는 `src/proxy.ts`(Next 16 미들웨어)의 세션 게이트에서 **prefix 로 통째로
 * 면제**된다(`src/lib/supabase/middleware.ts` 의 `pathname.startsWith("/api/cron")`).
 * 크론 발화는 로그인 세션이 없기 때문이다. 그래서 이 경로에서는 **라우트 핸들러의 시크릿
 * 검사가 유일한 인증**이고, 그것이 빠지거나 느슨하면 곧바로 공개 엔드포인트가 된다.
 *
 * 그런데 이 검사가 18개 라우트에 **손으로 복사**돼 있었고, 예상대로 갈라졌다(2026-08-04 감사):
 *
 * - `seller-metrics` — `if (process.env.CRON_SECRET && secret !== …)`. 앞의 truthy 검사 때문에
 *   **CRON_SECRET 이 없으면 조건 전체가 거짓이 되어 인증 없이 통과**했다. 실제로 비인증 GET 이
 *   200 과 함께 큐 적재 응답을 돌려주는 것을 실측했다.
 *   ℹ️ 이 라우트도 그 뒤 **삭제됐다**(2026-08-05 오너 결정). 미등록인 것에 더해, 소비자
 *   워커의 데이터 출처(`getSellerMetricProvider`)가 **분기 없이 mock 만 반환**해 SNS 핸들의
 *   문자 코드 합으로 팔로워 수를 지어내고 있었다 — 켜는 순간 전 셀러(`isMonitored` 필터도
 *   없었다)의 `currentFollowers` 를 가짜 값으로 덮어썼을 것이다. BullMQ·Redis 레인 전체를
 *   함께 걷어냈다. 파일을 찾지 말 것.
 * - `sync-followers` — `if (!process.env.CRON_SECRET) return true`. "개발 환경 편의"로 명시돼
 *   있었으나 개발 환경임을 확인하는 코드가 없어, 환경변수 누락만으로 프로덕션에서도 열린다.
 *   ℹ️ 이 라우트는 그 뒤 **삭제됐다**(2026-08-05 오너 결정) — `vercel.json` crons·`KNOWN_JOBS`·
 *   GHA 폴백 어디에도 없는 미등록 고아였고, 기능은 `collect-instagram`·`collect-youtube` 가
 *   완전히 흡수했다(그쪽은 레이더 관측·캐시 무효화까지 한다). 파일을 찾지 말 것.
 *
 * 나머지 16개는 `Bearer ${process.env.CRON_SECRET}` 와 문자열 비교라 헤더를 **생략**하면
 * 막히지만, 시크릿이 미설정이면 기대값이 문자열 `"Bearer undefined"` 가 되어 **그 리터럴을
 * 그대로 보내면 통과**한다. 즉 "시크릿 미설정"은 어느 사본에서도 안전하지 않았다.
 *
 * ## 계약
 *
 * **CRON_SECRET 이 없으면 아무도 통과하지 못한다(fail-closed).** 환경변수 누락은 인증을
 * 완화할 사유가 아니라 그 자체로 구성 오류다 — 조용히 열리는 것보다 크론이 401 로 시끄럽게
 * 실패하는 편이 낫다(레이더가 지연으로 표면화한다).
 *
 * 비교는 상수 시간으로 한다. 시크릿 대조는 반복 호출이 가능한 원격 표면이라 바이트 단위
 * 조기 종료가 곧 오라클이 된다.
 *
 * 사본 재발은 `api-route-auth-coverage.contract.test.ts` 가 소스 스캔으로 막는다.
 */

/** 길이 노출을 제외하면 내용에 대해 상수 시간인 비교. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // timingSafeEqual 은 길이가 다르면 던진다 — 길이는 애초에 응답 크기로도 새므로 여기서 거른다.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * `Authorization: Bearer <CRON_SECRET>` 헤더 검증 — Vercel cron 과
 * `.github/workflows/scheduled-crons.yml` 폴백이 쓰는 기본 경로.
 */
export function verifyCronAuth(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return false;
  return safeEqual(authHeader, `Bearer ${secret}`);
}

/**
 * `?secret=<CRON_SECRET>` 쿼리 검증 — **헤더를 붙일 수 없는 외부 웹훅 전용**이다
 * (Apify 웹훅 설정은 URL 만 받는다). 쿼리 문자열은 액세스 로그·리퍼러에 남으므로
 * 헤더를 보낼 수 있는 호출자는 반드시 `verifyCronAuth` 를 쓴다 — 새 크론에 이 함수를
 * 쓰지 말 것.
 */
export function verifyCronQuerySecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const provided = new URL(request.url).searchParams.get("secret");
  if (!provided) return false;
  return safeEqual(provided, secret);
}
