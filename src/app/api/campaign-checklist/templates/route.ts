import { NextResponse } from "next/server";
import { ensureDefaultChecklistTemplates } from "@/lib/campaign-checklist";
import { getPrisma } from "@/lib/prisma";
import { upsertCampaignChecklistTemplateSchema } from "@/lib/validations/campaign-checklist";

export async function GET() {
  const prisma = getPrisma();
  await ensureDefaultChecklistTemplates(prisma);

  const templates = await prisma.campaignChecklistTemplate.findMany({
    orderBy: [{ status: "asc" }, { sortOrder: "asc" }],
  });

  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const parsed = upsertCampaignChecklistTemplateSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();
  const template = parsed.data.id
    ? await prisma.campaignChecklistTemplate.update({
        where: { id: parsed.data.id },
        data: {
          status: parsed.data.status,
          label: parsed.data.label,
          sortOrder: parsed.data.sortOrder,
          isRequired: parsed.data.isRequired,
          isActive: parsed.data.isActive,
        },
      })
    : await prisma.campaignChecklistTemplate.upsert({
        where: {
          status_label: {
            status: parsed.data.status,
            label: parsed.data.label,
          },
        },
        update: {
          sortOrder: parsed.data.sortOrder,
          isRequired: parsed.data.isRequired,
          isActive: parsed.data.isActive,
        },
        create: parsed.data,
      });

  return NextResponse.json(template, { status: parsed.data.id ? 200 : 201 });
}
