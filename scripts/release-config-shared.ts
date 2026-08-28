// ⛔ `DATABASE_URL`·`DIRECT_URL` 을 2026-08-13 에 뺐다. release-preflight 는 더 이상
// 프로덕션 DB 로 빌드하지 않고 **잡 안에서만 사는 일회용 Postgres**(`services:`)를 쓴다
// — 그 값은 워크플로에 리터럴로 있으므로 시크릿 매핑을 요구하면 오히려 검사가 실패한다.
// 전환 이유는 그 워크플로 상단 주석 참고(P1001 무관 PR 실패 · P2022 컬럼 추가 차단 ·
// 자체호스팅 이관 후 클라우드 강등 시 모든 PR 차단).
export const requiredCiSecrets = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "NEXT_PUBLIC_APP_URL",
  // 폴백 기본 키를 없앴으므로(2026-07-23) 이 변수가 없으면 주민등록번호 암·복호화가
  // 런타임에 실패한다 — 배포 전 게이트에서 필수로 잡는다.
  "ENCRYPTION_KEY",
] as const;

export const optionalCiSecrets = [
  "SUPABASE_ASSET_BUCKET",
  "NEXT_PUBLIC_SITE_URL",
  "GOOGLE_DRIVE_CLIENT_ID",
  "GOOGLE_DRIVE_CLIENT_SECRET",
  "GOOGLE_DRIVE_REDIRECT_URI",
  "GOOGLE_DRIVE_ROOT_FOLDER_ID",
  "ASSET_TOKEN_ENCRYPTION_KEY",
  // 키 교체 전환 기간에만 설정한다(재암호화 완료 후 제거) — 상시 필수가 아니라 optional.
  "ENCRYPTION_KEY_PREVIOUS",
  // 유입추적 단축링크의 베이스 origin. 미설정이면 코드가 https://go.ygrd.kr 로 폴백하므로
  // 필수가 아니다 — 도메인을 바꿀 때만 설정한다(`src/lib/short-link.ts`).
  "NEXT_PUBLIC_SHORT_LINK_BASE_URL",
] as const;

export type ReleaseSecretName =
  | (typeof requiredCiSecrets)[number]
  | (typeof optionalCiSecrets)[number];
