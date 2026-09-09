import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth-context";
import { getPrisma } from "@/lib/prisma";
import { syncCampaignStatusesBySchedule } from "@/lib/campaign-status-sync";

export async function POST(request: Request) {
  const auth = await getAuthContext();
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { dryRun?: boolean; activateStarted?: boolean } = {};
  try {
    const text = await request.text();
    if (text) {
      body = JSON.parse(text);
    }
  } catch {
    // Body is optional
  }

  try {
    const prisma = getPrisma();
    const result = await syncCampaignStatusesBySchedule(prisma, new Date(), {
      dryRun: body.dryRun === true,
      activateStarted: body.activateStarted !== false,
    });

    return NextResponse.json({
      success: true,
      result,
    });
  } catch (error) {
    console.error("[api/campaigns/auto-expire] 자동 상태 전이 실패:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 },
    );
  }
}
