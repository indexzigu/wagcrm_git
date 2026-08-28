import { NextResponse } from "next/server";
import { SettlementService } from "@/services/settlementService";
import { addChecklistItemSchema } from "@/lib/validations/settlement";

type Context = {
  params: Promise<{ id: string }>;
};

// POST /api/settlement-checklist/[id]/items — 커스텀 항목 추가
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const parsed = addChecklistItemSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 }
    );
  }

  try {
    const newItem = await SettlementService.addChecklistItem(id, parsed.data.label);
    return NextResponse.json(newItem, { status: 201 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

