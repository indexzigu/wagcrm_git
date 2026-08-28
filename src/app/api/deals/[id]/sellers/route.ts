import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/deals/[id]/sellers
 * Returns sellers linked to a deal via SalesTask or SalesCampaign.
 */
export async function GET(_request: Request, context: Context) {
  const { id } = await context.params;
  const prisma = getPrisma();

  // Verify deal exists
  const deal = await prisma.deal.findUnique({ where: { id }, select: { id: true } });
  if (!deal) {
    return NextResponse.json({ error: "딜을 찾을 수 없습니다" }, { status: 404 });
  }

  // Fetch sellers from SalesTask
  const salesTasks = await prisma.salesTask.findMany({
    where: { dealId: id },
    include: {
      seller: { select: { id: true, name: true, alias: true, snsHandle: true, snsType: true, fitLevel: true, currentFollowers: true } },
    },
  });

  // Fetch sellers from SalesCampaign
  const campaigns = await prisma.salesCampaign.findMany({
    where: { dealId: id },
    include: {
      seller: { select: { id: true, name: true, alias: true, snsHandle: true, snsType: true, fitLevel: true, currentFollowers: true } },
    },
  });

  // Merge and deduplicate by seller ID
  const sellerMap = new Map<string, {
    id: string;
    name: string;
    snsHandle: string;
    snsType: string;
    source: "outreach" | "campaign";
    status?: string;
    fitLevel?: string | null;
    followers?: number;
  }>();

  for (const task of salesTasks) {
    sellerMap.set(task.seller.id, {
      id: task.seller.id,
      name: task.seller.alias || task.seller.name,
      snsHandle: task.seller.snsHandle,
      snsType: task.seller.snsType,
      source: "outreach",
      status: task.status,
      fitLevel: task.seller.fitLevel,
      followers: task.seller.currentFollowers,
    });
  }

  for (const campaign of campaigns) {
    if (!sellerMap.has(campaign.seller.id)) {
      sellerMap.set(campaign.seller.id, {
        id: campaign.seller.id,
        name: campaign.seller.alias || campaign.seller.name,
        snsHandle: campaign.seller.snsHandle,
        snsType: campaign.seller.snsType,
        source: "campaign",
        status: "ACTIVE",
        fitLevel: campaign.seller.fitLevel,
        followers: campaign.seller.currentFollowers,
      });
    }
  }

  return NextResponse.json({ sellers: Array.from(sellerMap.values()) });
}
