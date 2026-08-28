import { NextResponse } from "next/server";
import {
  ensureCampaignChecklistForCurrentStatus,
  summarizeChecklist,
} from "@/lib/campaign-checklist";
import { getPrisma } from "@/lib/prisma";
import type { CampaignStatus } from "@/lib/crm-types";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();

  await ensureCampaignChecklistForCurrentStatus(prisma, id);

  const campaign = await prisma.salesCampaign.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const items = await prisma.campaignChecklistItem.findMany({
    where: { campaignId: id },
    orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
  });

  return NextResponse.json({
    campaignId: id,
    status: campaign.status,
    summary: summarizeChecklist(items, campaign.status as CampaignStatus),
    items,
  });
}
