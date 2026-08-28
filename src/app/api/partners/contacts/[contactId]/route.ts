import { NextResponse } from "next/server";
import { PartnerService } from "@/services/partnerService";
import { updateContactSchema } from "@/lib/validations/partner-contact";

type Context = {
  params: Promise<{ contactId: string }>;
};

export async function PATCH(request: Request, context: Context) {
  const { contactId } = await context.params;

  try {
    const body = await request.json();
    const parsed = updateContactSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const updated = await PartnerService.updateContact(contactId, parsed.data);
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Contact update failed:", error);
    const status = error.message?.includes("찾을 수 없습니다") ? 404 : 500;
    return NextResponse.json(
      { error: error.message || "담당자 수정에 실패했습니다." },
      { status },
    );
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { contactId } = await context.params;

  try {
    const result = await PartnerService.deleteContact(contactId);
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Contact deletion failed:", error);
    const status = error.message?.includes("찾을 수 없습니다") ? 404 : 500;
    return NextResponse.json(
      { error: error.message || "담당자 삭제에 실패했습니다." },
      { status },
    );
  }
}
