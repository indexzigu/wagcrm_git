import { NextResponse } from "next/server";
import { SettlementService } from "@/services/settlementService";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const campaignId = searchParams.get("campaignId");

  if (!campaignId) {
    return NextResponse.json(
      { error: "campaignId query parameter is required" },
      { status: 400 }
    );
  }

  try {
    const checklist = await SettlementService.getOrCreateChecklist(campaignId);
    return NextResponse.json(checklist);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

