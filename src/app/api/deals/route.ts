import { NextRequest, NextResponse } from "next/server";
import { createDealSchema } from "@/lib/validations/deal";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { dealService } from "@/services/dealService";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;

  const status = searchParams.get("status");
  const partnerId = searchParams.get("partnerId");
  const dealType = searchParams.get("dealType");
  const parentDealId = searchParams.get("parentDealId");
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") as "asc" | "desc" | null;

  try {
    const deals = await dealService.getDealsList({
      status,
      partnerId,
      dealType,
      parentDealId,
      sortBy,
      sortDir,
    });
    return NextResponse.json({ deals });
  } catch (error) {
    console.error("[GET /api/deals] Error:", error);
    return NextResponse.json({ error: "조회 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const body = await request.json();
  const parsed = createDealSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  try {
    const deal = await dealService.createDeal(parsed.data, actor);
    revalidateMasterDataCaches();
    return NextResponse.json(deal, { status: 201 });
  } catch (error) {
    console.error("[POST /api/deals] Error:", error);
    return NextResponse.json({ error: "생성 중 오류가 발생했습니다." }, { status: 500 });
  }
}
