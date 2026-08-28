import { NextResponse } from "next/server";
import {
  ensureCampaignChecklistForCurrentStatus,
  summarizeChecklist,
} from "@/lib/campaign-checklist";
import { getPrisma } from "@/lib/prisma";
import type { CampaignStatus } from "@/lib/crm-types";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const idsParam = searchParams.get("ids");
  if (!idsParam) {
    return NextResponse.json({ checklists: {} });
  }

  const ids = idsParam.split(",").filter(Boolean);
  if (ids.length === 0) {
    return NextResponse.json({ checklists: {} });
  }

  const prisma = getPrisma();

  try {
    // 1. Ensure checklist items are created for all campaigns
    await Promise.all(
      ids.map((id) => ensureCampaignChecklistForCurrentStatus(prisma, id))
    );

    // 2. Fetch all campaigns and their items in parallel
    const [campaigns, allItems] = await Promise.all([
      prisma.salesCampaign.findMany({
        where: { id: { in: ids } },
        select: { id: true, status: true },
      }),
      prisma.campaignChecklistItem.findMany({
        where: { campaignId: { in: ids } },
        orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
      }),
    ]);

    // Group items by campaignId
    const itemsByCampaignId = allItems.reduce((acc, item) => {
      if (!acc[item.campaignId]) acc[item.campaignId] = [];
      acc[item.campaignId].push(item);
      return acc;
    }, {} as Record<string, typeof allItems>);

    // Construct response map
    const checklists: Record<string, any> = {};
    for (const campaign of campaigns) {
      const items = itemsByCampaignId[campaign.id] || [];
      checklists[campaign.id] = {
        campaignId: campaign.id,
        status: campaign.status,
        summary: summarizeChecklist(items, campaign.status as CampaignStatus),
        items,
      };
    }

    return NextResponse.json({ checklists });
  } catch (error) {
    console.error("Bulk checklist fetch error:", error);
    return NextResponse.json(
      { error: "Failed to fetch checklists" },
      { status: 500 }
    );
  }
}
