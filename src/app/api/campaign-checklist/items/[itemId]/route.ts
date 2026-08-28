import { NextResponse } from "next/server";
import { setChecklistItemChecked } from "@/lib/campaign-checklist";
import { getPrisma } from "@/lib/prisma";
import { updateCampaignChecklistItemSchema } from "@/lib/validations/campaign-checklist";

type Context = {
  params: Promise<{ itemId: string }>;
};

export async function PATCH(request: Request, context: Context) {
  const { itemId } = await context.params;
  const parsed = updateCampaignChecklistItemSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const prisma = getPrisma();

  try {
    if (parsed.data.isChecked !== undefined) {
      const result = await setChecklistItemChecked(
        prisma,
        itemId,
        parsed.data.isChecked,
      );

      return NextResponse.json(result);
    }

    const item = await prisma.campaignChecklistItem.update({
      where: { id: itemId },
      data: {
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.sortOrder !== undefined
          ? { sortOrder: parsed.data.sortOrder }
          : {}),
        ...(parsed.data.isRequired !== undefined
          ? { isRequired: parsed.data.isRequired }
          : {}),
      },
    });

    return NextResponse.json({ item, transitioned: false });
  } catch (error) {
    if (error instanceof Error && error.message === "CHECKLIST_ITEM_NOT_FOUND") {
      return NextResponse.json(
        { error: "체크리스트 항목을 찾을 수 없습니다" },
        { status: 404 },
      );
    }
    throw error;
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { itemId } = await context.params;
  const prisma = getPrisma();

  try {
    const item = await prisma.campaignChecklistItem.delete({
      where: { id: itemId },
    });
    return NextResponse.json({ item });
  } catch {
    return NextResponse.json(
      { error: "체크리스트 항목을 찾을 수 없습니다" },
      { status: 404 },
    );
  }
}
