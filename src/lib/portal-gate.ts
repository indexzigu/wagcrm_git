// 전용 주소 포털(/<slug>)의 접근 판정 — 슬러그 페이지와 카드 페이지가 공유한다.
// 서버 전용(next/headers·prisma) — 클라이언트/edge에서 import 금지.
import { cookies } from "next/headers";
import { getPrisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { resolveAccess } from "@/lib/auth-allowlist";
import { isValidPortalSlug } from "@/lib/portal-slug";
import { PORTAL_SESSION_COOKIE, verifyPortalSessionValue } from "@/lib/portal-auth";

export type PortalGateSeller = {
  id: string;
  name: string;
  alias: string | null;
  currentFollowers: number;
  portalPasswordHash: string | null;
  portalAuthLockedUntil: Date | null;
};

/** 슬러그 → 셀러. 형식 불량·미등록이면 null(페이지에서 404). */
export async function resolvePortalSeller(slug: string): Promise<PortalGateSeller | null> {
  if (!isValidPortalSlug(slug)) return null;
  return getPrisma().seller.findUnique({
    where: { portalSlug: slug },
    select: {
      id: true,
      name: true,
      alias: true,
      currentFollowers: true,
      portalPasswordHash: true,
      portalAuthLockedUntil: true,
    },
  });
}

/**
 * 열람 자격 판정. 둘 중 하나면 통과:
 *  1) CRM 관리자 세션(허가목록 통과) — 소유자가 "열기"로 셀러 화면을 그대로 확인하는 경로.
 *  2) 포털 세션 쿠키 — 비밀번호 인증 성공 후 발급된 HMAC 서명 쿠키(비밀번호 재발급 시 무효).
 * 의도적으로 DEV_AUTH_BYPASS 우회는 두지 않는다 — 게이트는 dev에서도 prod와 동일하게 동작해야
 * 검증 가능하고, 우회 분기 자체가 보안 표면이 된다.
 */
export async function isPortalAuthorized(seller: PortalGateSeller): Promise<boolean> {
  // 1) CRM 관리자 세션
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    // 종전 판정은 `isEmailAllowed`(env 허가목록)였다. env 제거로 `resolveAccess` 로 옮기면서
    // **admin 으로 좁힌다** — 이 분기는 셀러 포털의 비밀번호 게이트를 건너뛰는 경로이고,
    // operator(카톡 업로드 전담)는 애초에 셀러 데이터를 보면 안 된다.
    if (user) {
      const access = resolveAccess(user.app_metadata, user.email);
      if (access.approved && access.role === "admin") return true;
    }
  } catch {
    // supabase env 미구성 등 — 관리자 경로만 포기하고 비밀번호 게이트로 진행
  }

  // 2) 포털 세션 쿠키
  const jar = await cookies();
  const value = jar.get(PORTAL_SESSION_COOKIE)?.value;
  return verifyPortalSessionValue(value, seller.id, seller.portalPasswordHash);
}
