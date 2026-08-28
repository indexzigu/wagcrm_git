import { createClient } from "@/lib/supabase/server";
import { TRUSTED_USER_HEADER } from "@/lib/supabase/middleware";
import { DEMO_USER, isDemoMode } from "@/lib/demo-mode";
import { cookies, headers } from "next/headers";
import { resolveUserRole } from "@/lib/auth-allowlist";
import { parseRole, type UserRole } from "@/lib/auth-roles";

export type { UserRole };

export interface AuthContext {
  userId: string;
  email: string;
  role: UserRole;
}

/**
 * Get the authenticated user's context from Supabase session.
 * Returns null if not authenticated.
 * 역할은 `resolveUserRole`(auth-allowlist.ts)이 결정한다 — user_metadata.role 이 있으면
 * 그것을, 없으면 admin 이메일 목록으로 판정한다(그 외는 operator).
 */
export async function getAuthContext(): Promise<AuthContext | null> {
  // 미들웨어가 이미 supabase.auth.getUser()로 검증해 심어둔 신뢰 헤더가 있으면 그대로 쓴다 —
  // 요청당 /auth/v1/user 호출을 2번(미들웨어+라우트) → 1번으로 줄인다. 헤더가 없거나(미들웨어를
  // 못 거친 경로 등) 손상됐으면 무조건 기존 경로(재검증)로 조용히 폴백해 안전하게 유지한다.
  const headerStore = await headers();
  const trustedHeader = headerStore.get(TRUSTED_USER_HEADER);
  if (trustedHeader) {
    try {
      const parsed = JSON.parse(decodeURIComponent(trustedHeader)) as {
        id?: string;
        email?: string;
        role?: UserRole;
      };
      if (parsed?.id) {
        // 헤더의 role 은 미들웨어가 이미 resolveUserRole 로 확정한 값이다. 그래도 값을
        // 검증하는 이유: 손상·구버전 헤더를 조용히 admin 으로 승격시키지 않기 위해서다
        // (알 수 없는 값이면 이메일 기준으로 다시 판정한다 — fail-closed).
        return {
          userId: parsed.id,
          email: parsed.email ?? "",
          role: parseRole(parsed.role) ?? resolveUserRole(null, parsed.email),
        };
      }
    } catch {
      // 손상된 헤더는 무시하고 아래 기존 경로로 폴백한다.
    }
  }

  // 데모 배포: Supabase env 자체가 없어 createClient가 성립하지 않는다 — 헤더가 없는
  // 렌더 경로(프리렌더 셸 등)도 데모 열람 사용자로 통일한다. 쓰기는 미들웨어가 차단한다.
  if (isDemoMode()) {
    return {
      userId: DEMO_USER.id,
      email: DEMO_USER.email,
      role: DEMO_USER.role,
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // In development, allow bypass only when explicitly enabled via env or cookie
    const cookieStore = await cookies();
    const hasDevCookie = cookieStore.get("wag_crm_dev_auth")?.value === "1";

    if (
      process.env.NODE_ENV === "development" &&
      (process.env.DEV_AUTH_BYPASS === "1" || hasDevCookie)
    ) {
      return {
        userId: "dev-user",
        email: "dev@wag-crm.local",
        role: "admin",
      };
    }

    return null;
  }

  const role: UserRole = resolveUserRole(user.app_metadata?.role, user.email);

  return {
    userId: user.id,
    email: user.email ?? "",
    role,
  };
}
