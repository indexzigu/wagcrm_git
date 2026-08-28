import { NextResponse } from "next/server";
import { createCampaignChecklistItemSchema } from "@/lib/validations/campaign-checklist";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = createCampaignChecklistItemSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const campaign = await prisma.salesCampaign.findUnique({
    where: { id },
    select: { id: true, status: true },
  });

  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  const status = parsed.data.status ?? campaign.status;
  const latest = await prisma.campaignChecklistItem.findFirst({
    where: { campaignId: id, status },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  const item = await prisma.campaignChecklistItem.create({
    data: {
      campaignId: id,
      status,
      label: parsed.data.label,
      sortOrder: (latest?.sortOrder ?? -1) + 1,
      isRequired: parsed.data.isRequired,
      isChecked: false,
    },
  });

  return NextResponse.json(item, { status: 201 });
}
