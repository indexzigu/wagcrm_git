import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { changeCampaignDeal } from "@/lib/link-manager";
import { linkCampaignRequestSchema } from "@/lib/validations/link";

/**
 * PATCH /api/links/campaign/[campaignId]
 *
 * Changes the deal linked to a campaign by updating SalesCampaign.dealId.
 * Requirements: 7.5, 7.6, 8.4, 11.2, 11.4, 11.6
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ campaignId: string }> },
) {
  // 1. Authenticate
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { campaignId } = await params;

  // 2. Validate campaignId path param
  if (!campaignId || campaignId.trim() === "") {
    return NextResponse.json(
      { error: "유효하지 않은 캠페인 ID입니다" },
      { status: 400 },
    );
  }

  // 3. Parse and validate request body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "요청 본문이 유효한 JSON이 아닙니다" },
      { status: 400 },
    );
  }

  const parsed = linkCampaignRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }

  const { dealId } = parsed.data;

  // 4. Call LinkManager service
  try {
    const result = await changeCampaignDeal(
      campaignId,
      dealId,
      auth.context.userId,
    );

    // 5. Return updated campaign data + logWarning if any
    return NextResponse.json({
      ...result.data,
      logWarning: result.logWarning,
    });
  } catch (err: unknown) {
    // Handle Prisma "not found" errors
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2025"
    ) {
      return NextResponse.json(
        { error: "캠페인 또는 딜을 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    // Handle Prisma FK constraint violation (invalid dealId reference)
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "P2003"
    ) {
      return NextResponse.json(
        { error: "유효하지 않은 딜 ID입니다" },
        { status: 400 },
      );
    }

    // Generic server error
    console.error("[PATCH /api/links/campaign] Error:", err);
    return NextResponse.json(
      { error: "서버 오류가 발생했습니다" },
      { status: 500 },
    );
  }
}
