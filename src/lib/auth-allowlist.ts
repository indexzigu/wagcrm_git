/**
 * 인가 신원(authorization identity)의 SSOT.
 *
 * 인증(Google OAuth 성공)과 인가(이 앱을 쓸 수 있는 계정인가)는 별개다. 인가는
 * Supabase `app_metadata` 두 필드가 결정한다 — `status`(승인 여부)와 `role`(권한).
 * 오너는 `/settings/accounts` 화면에서 이 둘을 관리한다.
 *
 * ⛔ **env 로 되돌리지 말 것.** 종전에는 `ALLOWED_LOGIN_EMAILS`(로그인 가능)와
 * `ADMIN_LOGIN_EMAILS`(admin)라는 env 두 개가 이 판정을 쥐고 있었다. env 는 아래
 * 소스 상수를 **병합이 아니라 치환**해서, 목록에서 운영자를 빼먹으면 운영자 본인이
 * 잠겼다(2026-08-07 실사고: 신규 계정 3건이 카톡 화면에만 갇힘). 게다가 값을 바꾸려면
 * Vercel 대시보드 + 재배포가 필요했고 누가 언제 줬는지도 남지 않았다. 두 env 는
 * 2026-08-08 에 삭제됐다.
 *
 * 아래 오너 상수는 그 사고의 재발 방지 장치다 — env 와 달리 **치환되지 않고 항상
 * 더해지는 바닥**이라, UI 조작으로도 오너가 스스로 잠길 수 없다.
 *
 * 공개 레포 제약: 이 상수에는 **운영자 계정만** 둔다 — 두 주소는 git 커밋 author
 * 메타데이터로 이미 공개된 값이라 신규 노출이 없다. 그 외 팀원 계정은 소스에 적지
 * 않는다(계정 관리 화면에서 승인한다).
 */
import { parseRole, type UserRole } from "@/lib/auth-roles";

// ⚠️ 이 선언 4줄은 **의도적으로 원문 그대로 둔다.** 커밋 가드가 diff 의 추가 줄에서
// 이메일을 차단하므로, 이름을 바꾸거나 위치를 옮기면 이미 레포에 있던 이 두 줄이
// "새로 추가된 이메일" 로 잡혀 --no-verify 우회가 필요해진다. 이름이 지금 의미와
// 어긋나는 것(allowed=로그인 허가는 사라졌다)은 아래 별칭이 보완한다.
const DEFAULT_ALLOWED_EMAILS = [
  "zigoo1218@gmail.com", // 운영자
  "indexzigu@gmail.com", // 운영자
] as const;

/**
 * 오너 바닥 — 이 두 계정은 `app_metadata` 가 무엇이든 항상 approved + admin 이고
 * UI 에서 회수할 수 없다.
 *
 * export 하는 이유: 테스트가 "역할 미지정 오너는 admin 을 유지한다"를 단언하려면 실제
 * 오너 주소가 필요한데, 그 값을 테스트 파일에 다시 적으면 커밋 가드(공개 레포 이메일
 * 차단)에 걸리고 상수가 두 곳으로 갈라진다. 여기서 읽어 쓴다.
 */
export const DEFAULT_ADMIN_EMAILS = DEFAULT_ALLOWED_EMAILS;

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * 오너 바닥 계정인지 — 인가 판정에서 "회수 불가"를 뜻하는 **유일한 술어**다.
 * 이메일이 없는 세션은 바닥이 아니다(fail-closed).
 */
export function isOwnerFloorEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalize(email);
  return DEFAULT_ADMIN_EMAILS.some((owner) => normalize(owner) === normalized);
}

/**
 * 이메일만으로 admin 인지 — env 가 사라진 지금 이것은 오너 바닥과 같은 집합이다.
 * 별도 이름을 남겨 두는 이유는 호출 맥락이 다르기 때문이다: 여기는 "역할을 못 정했을
 * 때의 폴백"이고, `isOwnerFloorEmail` 은 "회수 불가 여부"다.
 *
 * ⛔ 이 함수에 env 목록을 다시 물리지 말 것 — 그러면 env 로 지정된 계정이 UI 에서
 * 내릴 수 없는 바닥으로 조용히 승격된다.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  return isOwnerFloorEmail(email);
}

/**
 * 세션의 실효 역할 — 인증된 사용자의 역할을 결정하는 **유일한 경로**다.
 *
 * 순서: ① Supabase **`app_metadata.role`** 이 유효한 값이면 그대로(오너가 명시 지정한 것)
 *      ② 없거나 알 수 없는 값이면 **이메일로 판정** — admin 목록이면 admin, 아니면 operator.
 *
 * ⛔ **`user_metadata.role` 을 읽지 말 것 — 그 필드는 사용자 본인이 쓸 수 있다.**
 * 리뷰에서 잡힌 실제 구멍이다(2026-08-06, 착지 전 수정). `user_metadata` 는
 * `auth.users.raw_user_meta_data` 이고 `supabase.auth.updateUser({ data: … })` 로
 * **본인 세션 + 공개 anon key** 만으로 갱신된다(`@supabase/auth-js` 타입:
 * `UserAttributes.data` → "maps to the `auth.users.raw_user_meta_data` column").
 * 즉 그것을 역할 출처로 쓰면 operator 가 브라우저 콘솔에서 `{"role":"admin"}` 을 써 넣어
 * **스스로 admin 이 된다** — 미들웨어 화이트리스트를 아무리 잘 짜도 우회된다.
 * `app_metadata` 는 같은 타입 파일이 **"Only a service role can modify"** 라고 못박은
 * 필드라 승격은 서버 권한(대시보드·service_role 키)으로만 가능하다.
 *
 * ⛔ **②를 `"admin"` 기본값으로 되돌리지 말 것.** 그러면 승인만 된 계정이 곧바로
 * **admin 으로 로그인**한다. ②가 operator 로 떨어져야 오너가 역할을 명시 지정하기 전까지
 * 최소 권한이 유지된다(운영자 2인은 오너 바닥이라 영향받지 않는다).
 */
export function resolveUserRole(
  appMetadataRole: unknown,
  email: string | null | undefined,
): UserRole {
  return parseRole(appMetadataRole) ?? (isAdminEmail(email) ? "admin" : "operator");
}

export type AccessStatus = "approved" | "rejected" | "pending";

export interface AccessDecision {
  approved: boolean;
  status: AccessStatus;
  role: UserRole;
}

function parseStatus(value: unknown): AccessStatus | null {
  return value === "approved" || value === "rejected" ? value : null;
}

/**
 * 접근 판정 — "이 앱에 들어올 수 있는가"와 "어떤 역할인가"를 한 번에 답한다.
 *
 * 순서:
 *  ① 오너 바닥(`DEFAULT_ADMIN_EMAILS`)이면 metadata 와 무관하게 approved + admin.
 *     env 와 달리 이 바닥은 치환되지 않고 항상 더해진다 — 오너가 UI 조작으로 스스로
 *     잠기는 경로를 구조적으로 없앤다.
 *  ② `app_metadata.status` 가 "approved" 면 통과, "rejected" 면 차단.
 *  ③ status 가 없으면 **대기**(fail-closed) — 오너가 계정 관리 화면에서 승인해야 들어온다.
 *
 * ⛔ ③에 "기존 env 허가목록에 있으면 승인" 같은 폴백을 다시 넣지 말 것. 전환기에는
 * 그런 폴백이 있었지만(백필 전 배포에도 아무도 잠기지 않게 하는 장치), env 와 함께
 * 걷어냈다. 되살리면 삭제된 env 가 다시 인가 경로가 된다.
 *
 * ⛔ 첫 인자는 반드시 `app_metadata` 다. `user_metadata` 는 사용자 본인이 쓸 수 있다.
 */
export function resolveAccess(
  appMetadata: Record<string, unknown> | null | undefined,
  email: string | null | undefined,
): AccessDecision {
  if (isOwnerFloorEmail(email)) {
    return { approved: true, status: "approved", role: "admin" };
  }

  const status = parseStatus(appMetadata?.status);
  const role = resolveUserRole(appMetadata?.role, email);

  if (status === "approved") {
    return { approved: true, status, role };
  }
  if (status === "rejected") {
    return { approved: false, status, role };
  }
  return { approved: false, status: "pending", role };
}
