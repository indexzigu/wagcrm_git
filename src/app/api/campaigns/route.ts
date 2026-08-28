import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { toCampaignRow } from "@/lib/campaign-row";
import { getAuthContext } from "@/lib/auth-context";
import { requireAuth } from "@/lib/api-auth";
import { revalidateCampaignCaches } from "@/lib/cache-tags";
import { campaignService } from "@/services/campaignService";
import { syncCampaignToCalendar } from "@/lib/google-calendar-sync";

export async function GET(request: NextRequest) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { searchParams } = request.nextUrl;

  const status = searchParams.get("status");
  const workspace = searchParams.get("workspace");
  const assignedTo = searchParams.get("assignedTo");
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const sortBy = searchParams.get("sortBy");
  const sortDir = searchParams.get("sortDir") as "asc" | "desc" | null;

  try {
    const campaigns = await campaignService.getCampaignsList({
      status,
      workspace,
      assignedTo,
      startDate,
      endDate,
      sortBy,
      sortDir,
    });
    return NextResponse.json({ campaigns: campaigns.map((campaign) => toCampaignRow(campaign)) });
  } catch (error) {
    console.error("GET Campaigns error:", error);
    return NextResponse.json({ error: "Failed to fetch campaigns" }, { status: 500 });
  }
}

const createCampaignSchema = z.object({
  dealId: z.string().min(1),
  sellerId: z.string().min(1),
  campaignName: z.string().trim().min(1).max(100).optional(),
  startDate: z.string().date(),
  endDate: z.string().date(),
  salesChannel: z.enum([
    "UNSPECIFIED",
    "OWN_MALL",
    "OWN_MALL_NAVER",
    "OWN_MALL_KAKAO",
    "SELLER_MALL",
    "BRAND_MALL",
  ]),
  baseNaverLink: z.string().url(),
  status: z
    .enum([
      "PROPOSAL",
      "PREPARATION",
      "ACTIVE",
      "CLOSED",
      "SETTLEMENT_WAIT",
      "SETTLEMENT_IN_PROGRESS",
      "COMPLETED",
      "DROPPED",
    ])
    .default("PROPOSAL"),
  isManualMargin: z.boolean().default(false),
  totalMarginRate: z.coerce.number().optional(),
  sellerMarginRate: z.coerce.number().optional(),
  campaignDeals: z.array(z.object({
    dealId: z.string(),
    quantity: z.coerce.number().int().nonnegative().default(0),
    actualSales: z.coerce.number().nonnegative().default(0),
    feeRate: z.coerce.number().nonnegative().nullable().optional(),
    sellerMarginRate: z.coerce.number().nonnegative().nullable().optional(),
    costPrice: z.coerce.number().nonnegative().nullable().optional(),
    sellingPrice: z.coerce.number().nonnegative().nullable().optional(),
  })).optional(),
});

export async function POST(request: Request) {
  const authContext = await getAuthContext();
  if (!authContext) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = createCampaignSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const responseCampaign = await campaignService.createCampaign(parsed.data, {
      userId: authContext.userId,
      email: authContext.email,
    });
    
    revalidateCampaignCaches();

    // 구글 캘린더 자동 등록 — 저장 응답을 막지 않도록 after()로 백그라운드 처리(멱등·best-effort).
    // 캘린더 미연결/구글 오류여도 캠페인 생성은 이미 성공한 상태다.
    after(() =>
      syncCampaignToCalendar(responseCampaign.id).catch((calendarError) =>
        console.error("[calendar-sync] 캠페인 생성 훅 실패:", calendarError),
      ),
    );

    return NextResponse.json(toCampaignRow(responseCampaign), { status: 201 });
  } catch (error: any) {
    console.error("POST Campaigns error:", error);
    if (error.message === "Deal or seller not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
