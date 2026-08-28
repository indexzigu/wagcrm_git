import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/sellers/[id]/portal-token
 *
 * 셀러 포털(로그인 없는 토큰 URL) 토큰 발급. 기본은 멱등 — 이미 발급된 토큰이 있으면
 * 그대로 반환한다. body { rotate: true }면 재발급(기존 링크 즉시 무효화 — 유출/관계 종료 시).
 * 토큰 자체가 접근 자격이므로 추측 불가 길이(192bit)로 생성한다.
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();

  const seller = await prisma.seller.findUnique({
    where: { id },
    select: { id: true, portalToken: true },
  });
  if (!seller) {
    return NextResponse.json({ error: "해당 셀러를 찾을 수 없습니다" }, { status: 404 });
  }

  let rotate = false;
  try {
    const body = await request.json();
    rotate = body?.rotate === true;
  } catch {
    // body 없음 = 기본 발급(멱등)
  }

  let token = seller.portalToken;
  if (!token || rotate) {
    token = randomBytes(24).toString("base64url");
    await prisma.seller.update({ where: { id }, data: { portalToken: token } });
  }

  return NextResponse.json({ token, path: `/p/${token}`, rotated: rotate });
}
