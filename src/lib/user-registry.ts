/**
 * User Registry — fetches and caches CRM users from Supabase Auth admin API.
 * Provides user lookup and filtering for autocomplete.
 *
 * Requirements: 11.2, 11.4
 */

import { createClient } from "@supabase/supabase-js";
import { isOwnerFloorEmail, resolveAccess, resolveUserRole, type AccessStatus } from "@/lib/auth-allowlist";
import type { UserRole } from "@/lib/auth-roles";

export interface CrmUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
}

export interface CrmAccount {
  id: string;
  email: string;
  displayName: string;
  status: AccessStatus;
  role: UserRole;
  /** 오너 바닥 계정 — UI 에서 액션을 노출하지 않는다. */
  isOwnerFloor: boolean;
  grantedBy: string | null;
  grantedAt: string | null;
  lastSignInAt: string | null;
}

// In-memory cache for user list
let cachedUsers: CrmUser[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Creates a Supabase admin client using the service role key.
 * This client has access to the Auth admin API (listUsers).
 */
function createAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "Supabase admin client requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY environment variables",
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * listUsers 는 기본 50건씩만 준다 — 페이지를 끝까지 돌지 않으면 51번째부터가 조용히
 * 사라진다. 자동완성이면 검색이 안 되는 계정이 생기고, 계정 관리 화면이면 있는데
 * 안 보이는 계정(= 권한 회수 누락)이 된다. 두 소비자가 이 헬퍼를 공유한다.
 */
const AUTH_USERS_PAGE_SIZE = 200;

type AdminUser = Awaited<
  ReturnType<ReturnType<typeof createAdminClient>["auth"]["admin"]["listUsers"]>
>["data"]["users"][number];

async function listAllAuthUsers(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<AdminUser[]> {
  const collected: AdminUser[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: AUTH_USERS_PAGE_SIZE,
    });
    if (error) {
      throw new Error(`Failed to fetch users: ${error.message}`);
    }
    const users = data.users ?? [];
    collected.push(...users);
    // 마지막 페이지는 요청한 크기보다 적게 온다. 빈 페이지도 같은 조건으로 멈춘다.
    if (users.length < AUTH_USERS_PAGE_SIZE) return collected;
  }
}

/**
 * Fetches all CRM users from Supabase Auth admin API.
 * Caches result for 60 seconds to avoid excessive auth calls.
 */
export async function getCrmUsers(): Promise<CrmUser[]> {
  const now = Date.now();

  if (cachedUsers && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedUsers;
  }

  const supabase = createAdminClient();
  let authUsers: AdminUser[];
  try {
    authUsers = await listAllAuthUsers(supabase);
  } catch (error) {
    // If cache exists but is stale, return stale data on error — this keeps
    // autocomplete degraded-but-alive instead of hard-failing on a transient
    // Auth API hiccup (unlike getCrmAccounts, which is a one-shot admin screen
    // where a stale silent success would be worse than a visible error).
    if (cachedUsers) {
      return cachedUsers;
    }
    throw error;
  }

  const users: CrmUser[] = authUsers.map((user) => ({
    id: user.id,
    email: user.email ?? "",
    displayName:
      (user.user_metadata?.display_name as string) ??
      (user.user_metadata?.displayName as string) ??
      (user.user_metadata?.name as string) ??
      user.email?.split("@")[0] ??
      "Unknown",
    // 역할 판정은 `resolveUserRole` 하나로 모은다 — 여기 기본값이 미들웨어와 어긋나 있으면
    // (종전: 여기 "operator" / 인증 경로 "admin") 사용자 목록에 뜨는 역할과 실제로 집행되는
    // 역할이 달라진다. 오너가 자기 계정을 operator 로 보는 상태가 그 증상이었다.
    role: resolveUserRole(user.app_metadata?.role, user.email),
  }));

  cachedUsers = users;
  cacheTimestamp = now;

  return users;
}

/**
 * 계정 관리 화면용 전체 목록. `getCrmUsers` 와 달리 캐시하지 않는다 — 권한 변경 직후
 * 옛 값을 보여주면 오너가 같은 조작을 두 번 하게 된다.
 */
export async function getCrmAccounts(): Promise<CrmAccount[]> {
  const supabase = createAdminClient();
  const users = await listAllAuthUsers(supabase);

  return users.map((user) => {
    const email = user.email ?? "";
    const appMetadata = (user.app_metadata ?? {}) as Record<string, unknown>;
    const access = resolveAccess(appMetadata, email);
    return {
      id: user.id,
      email,
      displayName:
        (user.user_metadata?.display_name as string) ??
        (user.user_metadata?.name as string) ??
        email.split("@")[0] ??
        "Unknown",
      status: access.status,
      role: access.role,
      isOwnerFloor: isOwnerFloorEmail(email),
      grantedBy: (appMetadata.grantedBy as string) ?? null,
      grantedAt: (appMetadata.grantedAt as string) ?? null,
      lastSignInAt: user.last_sign_in_at ?? null,
    };
  });
}

/**
 * Filters users by query string (case-insensitive substring match on displayName or email).
 * Used for autocomplete.
 */
export function filterUsers(users: CrmUser[], query: string): CrmUser[] {
  if (!query || query.trim() === "") {
    return [];
  }

  const lowerQuery = query.toLowerCase();

  return users.filter(
    (user) =>
      user.displayName.toLowerCase().includes(lowerQuery) ||
      user.email.toLowerCase().includes(lowerQuery),
  );
}

/**
 * Resets the user cache. Useful for testing or when users are known to have changed.
 */
export function resetUserCache(): void {
  cachedUsers = null;
  cacheTimestamp = 0;
}
