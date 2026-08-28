import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { createSellerSchema } from "@/lib/validations/seller";
import { requireAuth } from "@/lib/api-auth";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import { sellerService } from "@/services/sellerService";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;

  const snsType = searchParams.get("snsType");
  const category = searchParams.get("category");
  const agencyId = searchParams.get("agencyId");
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") as "asc" | "desc" | null;

  try {
    const sellers = await sellerService.getSellersList({
      snsType,
      category,
      agencyId,
      sortBy,
      sortDir,
    });
    return NextResponse.json({ sellers });
  } catch (error) {
    console.error("[GET /api/sellers] Error:", error);
    return NextResponse.json({ error: "조회 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const rawBody: unknown = await request.json();
  const candidate =
    rawBody && typeof rawBody === "object"
      ? { ...(rawBody as Record<string, unknown>) }
      : {};

  if (candidate.snsHandle && typeof candidate.snsHandle === "string") {
    candidate.snsHandle = candidate.snsHandle.trim().replace(/^@/, "");
  }

  const channelUrl =
    typeof candidate.channelUrl === "string" ? candidate.channelUrl.trim() : "";
  if (channelUrl.length > 0) {
    candidate.channelUrl = channelUrl;
  }

  // Zod schema parsing is kept in Controller
  const parsed = createSellerSchema.safeParse(candidate);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const authCtx = await getAuthContext();
  const actor = authCtx?.email ?? "SYSTEM";

  try {
    const seller = await sellerService.createSeller(parsed.data, actor);
    revalidateMasterDataCaches();
    return NextResponse.json(seller, { status: 201 });
  } catch (error) {
    const isUniqueConstraintError =
      (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
      (error && typeof error === "object" && "code" in error && (error as { code: string }).code === "P2002");

    if (isUniqueConstraintError) {
      return NextResponse.json(
        { error: "이미 존재하는 셀러입니다" },
        { status: 409 },
      );
    }
    
    const message = error instanceof Error ? error.message : "생성 중 오류가 발생했습니다.";
    // Check if it's the parseChannelUrl validation error
    if (message.includes("지원하지 않는 채널 URL 형식")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }

    console.error("[POST /api/sellers] Error:", error);
    return NextResponse.json({ error: "생성 중 오류가 발생했습니다." }, { status: 500 });
  }
}
