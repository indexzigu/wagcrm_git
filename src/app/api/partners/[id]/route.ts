import { NextResponse } from "next/server";
import { PartnerService } from "@/services/partnerService";
import { updatePartnerSchema } from "@/lib/validations/partner";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";

type Context = {
  params: Promise<{ id: string }>;
};

export async function PATCH(request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const body = await request.json();
    const parsed = updatePartnerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const auth = await getAuthContext();
    const actor = auth?.email ?? "SYSTEM";

    const updated = await PartnerService.updatePartner(id, parsed.data, actor);
    revalidateMasterDataCaches();
    return NextResponse.json(updated);
  } catch (error: any) {
    console.error("Partner update failed:", error);
    if (error?.code === "P2002") {
      return NextResponse.json({ error: "이미 사용 중인 발주 코드입니다." }, { status: 409 });
    }
    const status = error.message?.includes("찾을 수 없습니다") ? 404 : 500;
    return NextResponse.json({ error: error.message || "수정에 실패했습니다." }, { status });
  }
}

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;

  try {
    const auth = await getAuthContext();
    const actor = auth?.email ?? "SYSTEM";

    const result = await PartnerService.deletePartner(id, actor);
    revalidateMasterDataCaches();
    return NextResponse.json(result);
  } catch (error: any) {
    console.error("Partner deletion failed:", error);
    if (error.message?.includes("찾을 수 없습니다")) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error.message?.includes("연결된 딜이 존재")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "삭제에 실패했습니다." }, { status: 500 });
  }
}
