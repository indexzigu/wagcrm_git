"use server";

// 전용 주소 포털 비밀번호 로그인 — 공개 경로의 서버 액션이므로 방어를 겹으로 둔다:
// bcrypt 검증(자체 지연) + DB 기반 실패 카운트/잠금(서버리스 인스턴스 간에도 유지) +
// 성공 시 HMAC 서명 세션 쿠키. 실패 사유는 wrong/locked 두 가지로만 노출한다.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getPrisma } from "@/lib/prisma";
import { isValidPortalSlug } from "@/lib/portal-slug";
import {
  PORTAL_LOCK_MINUTES,
  PORTAL_MAX_FAILS,
  PORTAL_SESSION_COOKIE,
  PORTAL_SESSION_MAX_AGE_SEC,
  createPortalSessionValue,
  verifyPortalPassword,
} from "@/lib/portal-auth";

export async function loginToPortal(slug: string, formData: FormData): Promise<void> {
  if (!isValidPortalSlug(slug)) redirect("/login");

  const password = String(formData.get("password") ?? "");
  const prisma = getPrisma();
  const seller = await prisma.seller.findUnique({
    where: { portalSlug: slug },
    select: {
      id: true,
      portalPasswordHash: true,
      portalAuthFailCount: true,
      portalAuthLockedUntil: true,
    },
  });
  // 미등록 슬러그·비밀번호 미설정은 페이지(404/안내)가 담당 — 여기서는 무조건 실패 처리
  if (!seller?.portalPasswordHash || password.length === 0) redirect(`/${slug}?e=wrong`);

  const now = new Date();
  if (seller.portalAuthLockedUntil && seller.portalAuthLockedUntil > now) {
    redirect(`/${slug}?e=locked`);
  }

  const ok = await verifyPortalPassword(password, seller.portalPasswordHash);
  if (!ok) {
    // 잠금이 지나 있었다면 카운트를 1부터 다시 센다
    const lockExpired = !!seller.portalAuthLockedUntil && seller.portalAuthLockedUntil <= now;
    const failCount = lockExpired ? 1 : seller.portalAuthFailCount + 1;
    const locked = failCount >= PORTAL_MAX_FAILS;
    await prisma.seller.update({
      where: { id: seller.id },
      data: locked
        ? {
            portalAuthFailCount: 0,
            portalAuthLockedUntil: new Date(now.getTime() + PORTAL_LOCK_MINUTES * 60_000),
          }
        : { portalAuthFailCount: failCount, portalAuthLockedUntil: null },
    });
    redirect(`/${slug}?e=${locked ? "locked" : "wrong"}`);
  }

  // 성공 — 실패 흔적 정리 후 세션 쿠키 발급
  if (seller.portalAuthFailCount > 0 || seller.portalAuthLockedUntil) {
    await prisma.seller.update({
      where: { id: seller.id },
      data: { portalAuthFailCount: 0, portalAuthLockedUntil: null },
    });
  }
  const jar = await cookies();
  jar.set(PORTAL_SESSION_COOKIE, createPortalSessionValue(seller.id, seller.portalPasswordHash), {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "lax",
    path: "/",
    maxAge: PORTAL_SESSION_MAX_AGE_SEC,
  });
  redirect(`/${slug}`);
}
