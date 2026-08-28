import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import { containsSearch, normalizedForms } from "@/lib/prisma-search";

/**
 * GET /api/search/sellers?q=keyword
 *
 * Searches sellers by name or snsHandle (case-insensitive contains).
 * Returns up to 20 results.
 * Supports excludeIds to filter out already-linked sellers.
 *
 * Requirements: 10.4
 */
export async function GET(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";
  const excludeIds = (searchParams.get("excludeIds") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const prisma = getPrisma();

  // When no query: return recent sellers (최근 등록순)
  // When query < 2 chars: return empty (avoid partial matches)
  // When query >= 2 chars: search by name/handle
  if (!query) {
    const sellers = await prisma.seller.findMany({
      where: excludeIds.length > 0 ? { id: { notIn: excludeIds } } : undefined,
      take: 20,
      orderBy: [
        { isMonitored: "desc" },
        { createdAt: "desc" }
      ],
      select: {
        id: true,
        name: true,
        snsType: true,
        snsHandle: true,
        agencyId: true,
        isMonitored: true,
        fitLevel: true,
        alias: true,
        agency: {
          select: { id: true, name: true },
        },
      },
    });
    return NextResponse.json({ results: sellers });
  }

  if (query.length < 2) {
    return NextResponse.json({ results: [] });
  }

  const sellers = await prisma.seller.findMany({
    where: {
      AND: [
        {
          OR: normalizedForms(query).flatMap((f) => [
            { name: containsSearch(f) },
            { snsHandle: containsSearch(f) },
            { alias: containsSearch(f) },
          ]),
        },
        ...(excludeIds.length > 0 ? [{ id: { notIn: excludeIds } }] : []),
      ],
    },
    take: 20,
    orderBy: [
      { isMonitored: "desc" },
      { createdAt: "desc" }
    ],
    select: {
      id: true,
      name: true,
      snsType: true,
      snsHandle: true,
      agencyId: true,
      isMonitored: true,
      fitLevel: true,
      alias: true,
      agency: {
        select: { id: true, name: true },
      },
    },
  });

  return NextResponse.json({ results: sellers });
}
