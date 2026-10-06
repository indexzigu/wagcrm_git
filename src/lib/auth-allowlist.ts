/**
 * 인가 신원(authorization identity)의 SSOT.
 *
 * 인증(Google OAuth 성공)과 인가(이 앱을 쓸 수 있는 계정인가)는 별개다. 인가는
 * Supabase `app_metadata` 두 필드가 결정한다 — `status`(승인 여부)와 `role`(권한).
 * 오너는 `/settings/accounts` 화면에서 이 둘을 관리한다.
 *
 * 오너가 스스로 잠기지 않게 하는 장치는 **계정 변경 규칙**이 맡는다(`account-mutation.ts`:
 * 자기 계정 변경 금지 + 마지막 승인 관리자 강등·거절 금지). 특정 계정을 이메일로 지목하지
 * 않는다.
 *
 * ⛔ **이메일·계정 ID 를 소스에 다시 적지 말 것.** 종전에는 오너 이메일 2개를 「항상 admin,
 * 회수 불가」 바닥으로 이 파일에 고정했다. 이 레포는 공개라 그 목록이 곧 개인정보 노출이었고,
 * 오너 지시(2026-10-06)로 걷어냈다 — 같은 보호를 이메일 없이 규칙으로 얻는다.
 *
 * ⛔ **env 허용목록도 되살리지 말 것.** 그보다 앞서 `ALLOWED_LOGIN_EMAILS`·`ADMIN_LOGIN_EMAILS`
 * env 가 이 판정을 쥐었는데, 목록을 **치환**해서 운영자를 빼먹으면 본인이 잠겼다(2026-08-07
 * 실사고). 2026-08-08 삭제됐다.
 */
import { parseRole, type UserRole } from "@/lib/auth-roles";

/**
 * 세션의 실효 역할 — 인증된 사용자의 역할을 결정하는 **유일한 경로**다.
 *
 * 순서: ① Supabase **`app_metadata.role`** 이 유효한 값이면 그대로(오너가 명시 지정한 것)
 *      ② 없거나 알 수 없는 값이면 **operator**(최소 권한). 이메일로 승격하지 않는다.
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
 * 최소 권한이 유지된다.
 */
export function resolveUserRole(
  appMetadataRole: unknown,
): UserRole {
  return parseRole(appMetadataRole) ?? "operator";
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
 *  ① `app_metadata.status` 가 "approved" 면 통과, "rejected" 면 차단.
 *  ② status 가 없으면 **대기**(fail-closed) — 오너가 계정 관리 화면에서 승인해야 들어온다.
 *
 * ⛔ ②에 "기존 env 허가목록에 있으면 승인" 같은 폴백을 다시 넣지 말 것. 전환기에는
 * 그런 폴백이 있었지만(백필 전 배포에도 아무도 잠기지 않게 하는 장치), env 와 함께
 * 걷어냈다. 되살리면 삭제된 env 가 다시 인가 경로가 된다.
 *
 * ⛔ 이메일로 통과시키는 바닥을 다시 넣지 말 것 — 오너 잠김 방지는 `account-mutation.ts`
 * 의 마지막 관리자 보호가 맡는다(파일 머리 주석).
 *
 * ⛔ 인자는 반드시 `app_metadata` 다. `user_metadata` 는 사용자 본인이 쓸 수 있다.
 */
export function resolveAccess(
  appMetadata: Record<string, unknown> | null | undefined,
): AccessDecision {
  const status = parseStatus(appMetadata?.status);
  const role = resolveUserRole(appMetadata?.role);

  if (status === "approved") {
    return { approved: true, status, role };
  }
  if (status === "rejected") {
    return { approved: false, status, role };
  }
  return { approved: false, status: "pending", role };
}
