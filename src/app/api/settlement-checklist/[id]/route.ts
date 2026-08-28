import { NextResponse } from "next/server";
import { SettlementService } from "@/services/settlementService";
import { toggleChecklistItemSchema } from "@/lib/validations/settlement";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const checklist = await SettlementService.getOrCreateChecklist(id);
    return NextResponse.json(checklist);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context) {
  await context.params;
  const parsed = toggleChecklistItemSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { itemId, isChecked } = parsed.data;

  try {
    const result = await SettlementService.toggleChecklistItem(itemId, isChecked);
    return NextResponse.json(result);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

