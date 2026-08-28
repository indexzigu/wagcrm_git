import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { equalsSearch } from "@/lib/prisma-search";

/**
 * GET /api/categories
 * 전체 카테고리 옵션 목록 조회
 */
export async function GET() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const categories = await getPrisma().sellerCategory.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ categories });
}

/**
 * POST /api/categories
 * 새 카테고리 생성 (최대 30자, 대소문자 무시 중복 검사)
 * 동일 이름(case-insensitive)이 이미 존재하면 기존 카테고리를 반환한다.
 */
export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json();
  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (!name) {
    return NextResponse.json(
      { error: "카테고리 이름은 필수입니다." },
      { status: 400 },
    );
  }

  if (name.length > 30) {
    return NextResponse.json(
      { error: "카테고리 이름은 최대 30자까지 가능합니다." },
      { status: 400 },
    );
  }

  // Case-insensitive duplicate check
  const existing = await getPrisma().sellerCategory.findFirst({
    where: {
      name: equalsSearch(name),
    },
    select: { id: true, name: true },
  });

  if (existing) {
    return NextResponse.json(existing, { status: 200 });
  }

  const category = await getPrisma().sellerCategory.create({
    data: { name },
    select: { id: true, name: true },
  });

  return NextResponse.json(category, { status: 201 });
}
