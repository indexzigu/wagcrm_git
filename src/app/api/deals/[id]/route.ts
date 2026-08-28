import { NextResponse } from "next/server";
import { updateDealSchema } from "@/lib/validations/deal";
import { getAuthContext } from "@/lib/auth-context";
import { revalidateMasterDataCaches } from "@/lib/cache-tags";
import {
  dealService,
  DealNotFoundError,
  InvalidStatusTransitionError,
  DealDeletionBlockedError,
} from "@/services/dealService";

type Context = {
  params: Promise<{ id: string }>;
};

export async function GET(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const deal = await dealService.getDealDetail(id);

    if (!deal) {
      return NextResponse.json(
        { error: "해당 딜을 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    return NextResponse.json(deal);
  } catch (error) {
    console.error("[GET /api/deals/[id]] Error:", error);
    return NextResponse.json({ error: "조회 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const body = await request.json();
    const parsed = updateDealSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
    }

    const auth = await getAuthContext();
    const actor = auth?.email ?? "SYSTEM";

    const updatedDeal = await dealService.updateDeal(id, parsed.data, actor);
    revalidateMasterDataCaches();

    return NextResponse.json(updatedDeal);
  } catch (error) {
    if (error instanceof DealNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof InvalidStatusTransitionError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    console.error("[PATCH /api/deals/[id]] Error:", error);
    return NextResponse.json({ error: "수정 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const auth = await getAuthContext();
    const actor = auth?.email ?? "SYSTEM";

    const result = await dealService.deleteDeal(id, actor);
    revalidateMasterDataCaches();

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof DealNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof DealDeletionBlockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[DELETE /api/deals/[id]] Error:", error);
    return NextResponse.json({ error: "삭제 중 오류가 발생했습니다." }, { status: 500 });
  }
}
