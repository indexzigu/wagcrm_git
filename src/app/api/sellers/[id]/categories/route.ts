import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/sellers/[id]/categories
 * 셀러에 할당된 카테고리 태그 목록 조회 (매핑이 비어있는 경우 기존 category 필드를 파싱하여 자동 동기화)
 */
export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  let assignments = await getPrisma().sellerCategoryAssignment.findMany({
    where: { sellerId: id },
    include: { category: { select: { id: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });

  // Auto-Sync: If assignments are empty but the seller has a category cache string
  if (assignments.length === 0) {
    const seller = await getPrisma().seller.findUnique({
      where: { id },
      select: { category: true },
    });

    if (seller?.category) {
      const categoryNames = seller.category
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      if (categoryNames.length > 0) {
        // Upsert all categories and prepare assignments
        const categories = await Promise.all(
          categoryNames.map(async (name) => {
            return getPrisma().sellerCategory.upsert({
              where: { name },
              update: {},
              create: { name },
            });
          })
        );

        // Create mapping assignments inside a transaction
        await getPrisma().$transaction(
          categories.map((cat) =>
            getPrisma().sellerCategoryAssignment.upsert({
              where: {
                sellerId_categoryId: {
                  sellerId: id,
                  categoryId: cat.id,
                },
              },
              update: {},
              create: {
                sellerId: id,
                categoryId: cat.id,
              },
            })
          )
        );

        // Fetch the updated assignments
        assignments = await getPrisma().sellerCategoryAssignment.findMany({
          where: { sellerId: id },
          include: { category: { select: { id: true, name: true } } },
          orderBy: { createdAt: "asc" },
        });
      }
    }
  }

  return NextResponse.json({
    categories: assignments.map((a) => a.category),
  });
}

/**
 * PATCH /api/sellers/[id]/categories
 * 셀러의 카테고리 태그 업데이트 (최대 5개)
 * 기존 할당을 모두 삭제하고 새로운 categoryIds로 재생성한다.
 */
export async function PATCH(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;

  const body = await request.json();
  const categoryIds: unknown = body.categoryIds;

  // Validate categoryIds is an array of strings
  if (!Array.isArray(categoryIds) || !categoryIds.every((v) => typeof v === "string")) {
    return NextResponse.json(
      { error: "categoryIds는 문자열 배열이어야 합니다." },
      { status: 400 },
    );
  }

  // Max 5 categories per seller
  if (categoryIds.length > 5) {
    return NextResponse.json(
      { error: "셀러당 최대 5개의 카테고리만 할당할 수 있습니다." },
      { status: 400 },
    );
  }

  // Check seller exists
  const seller = await getPrisma().seller.findUnique({ where: { id } });
  if (!seller) {
    return NextResponse.json(
      { error: "해당 셀러를 찾을 수 없습니다." },
      { status: 404 },
    );
  }

  let categoryNames = "";
  // Verify all categoryIds exist
  if (categoryIds.length > 0) {
    const existingCategories = await getPrisma().sellerCategory.findMany({
      where: { id: { in: categoryIds } },
      select: { id: true, name: true },
    });

    if (existingCategories.length !== categoryIds.length) {
      return NextResponse.json(
        { error: "존재하지 않는 카테고리가 포함되어 있습니다." },
        { status: 400 },
      );
    }

    const categoryMap = new Map(existingCategories.map((c) => [c.id, c.name]));
    categoryNames = categoryIds
      .map((cid) => categoryMap.get(cid))
      .filter((name): name is string => typeof name === "string")
      .join(", ");
  }

  // Delete all existing assignments, create new ones, and update seller category field in a transaction
  await getPrisma().$transaction([
    getPrisma().sellerCategoryAssignment.deleteMany({
      where: { sellerId: id },
    }),
    ...categoryIds.map((categoryId) =>
      getPrisma().sellerCategoryAssignment.create({
        data: { sellerId: id, categoryId },
      }),
    ),
    getPrisma().seller.update({
      where: { id },
      data: { category: categoryNames || null },
    }),
  ]);

  // Return updated assignments
  const assignments = await getPrisma().sellerCategoryAssignment.findMany({
    where: { sellerId: id },
    include: { category: { select: { id: true, name: true } } },
  });

  return NextResponse.json({
    categories: assignments.map((a) => a.category),
  });
}
