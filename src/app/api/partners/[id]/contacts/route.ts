import { NextResponse } from "next/server";
import { PartnerService } from "@/services/partnerService";
import { createContactSchema } from "@/lib/validations/partner-contact";

type Context = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const body = await request.json();
    const parsed = createContactSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const contact = await PartnerService.createContact(id, {
      partnerId: id,
      ...parsed.data,
    });

    return NextResponse.json(contact, { status: 201 });
  } catch (error: any) {
    console.error("Contact creation failed:", error);
    const status = error.message?.includes("찾을 수 없습니다") ? 404 : 500;
    return NextResponse.json(
      { error: error.message || "담당자 추가에 실패했습니다." },
      { status },
    );
  }
}
