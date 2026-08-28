import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { isValidPortalSlug, RESERVED_PORTAL_SLUGS } from "@/lib/portal-slug";
import { generatePortalPassword, hashPortalPassword } from "@/lib/portal-auth";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * 셀러 전용 주소 포털(crm.ygrd.kr/<slug> + 비밀번호) 관리.
 *
 * GET  → { slug, hasPassword } — 링크 섹션 UI 상태 표시용(해시는 절대 내려주지 않는다).
 * POST → body:
 *   { slug: string }            슬러그 설정/변경(형식·예약어·중복 검증)
 *   { generatePassword: true }  비밀번호 발급/재발급 — 평문은 이 응답에서 딱 1회 노출.
 *                               재발급하면 기존 비밀번호·모든 세션 쿠키가 즉시 무효화된다.
 * 두 동작을 한 요청에 함께 보낼 수도 있다(초기 설정 1클릭).
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const seller = await getPrisma().seller.findUnique({
    where: { id },
    select: { portalSlug: true, portalPasswordHash: true },
  });
  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }
  return NextResponse.json({
    slug: seller.portalSlug,
    hasPassword: !!seller.portalPasswordHash,
  });
}

export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();

  const seller = await prisma.seller.findUnique({
    where: { id },
    select: { id: true, portalSlug: true },
  });
  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  let body: { slug?: unknown; generatePassword?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 필요합니다" }, { status: 400 });
  }

  const data: { portalSlug?: string; portalPasswordHash?: string; portalAuthFailCount?: number; portalAuthLockedUntil?: null } = {};

  if (body.slug !== undefined) {
    const slug = String(body.slug).trim().toLowerCase();
    if (!isValidPortalSlug(slug)) {
      const reason = RESERVED_PORTAL_SLUGS.has(slug)
        ? "사용할 수 없는 예약된 주소입니다"
        : "주소 형식이 올바르지 않습니다 (소문자 영문/숫자로 시작, 3~31자, ._- 허용)";
      return NextResponse.json({ error: reason }, { status: 400 });
    }
    data.portalSlug = slug;
  }

  let plainPassword: string | null = null;
  if (body.generatePassword === true) {
    plainPassword = generatePortalPassword();
    data.portalPasswordHash = await hashPortalPassword(plainPassword);
    // 재발급 시 이전 실패 카운트/잠금도 함께 초기화
    data.portalAuthFailCount = 0;
    data.portalAuthLockedUntil = null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "변경할 항목이 없습니다" }, { status: 400 });
  }

  try {
    const updated = await prisma.seller.update({
      where: { id },
      data,
      select: { portalSlug: true, portalPasswordHash: true },
    });
    return NextResponse.json({
      slug: updated.portalSlug,
      hasPassword: !!updated.portalPasswordHash,
      // 평문 비밀번호는 이 응답 1회만 — 저장은 해시뿐이라 다시 조회할 수 없다
      password: plainPassword,
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return NextResponse.json({ error: "이미 다른 셀러가 사용 중인 주소입니다" }, { status: 409 });
    }
    throw e;
  }
}
