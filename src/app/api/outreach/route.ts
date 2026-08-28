import { NextResponse } from "next/server";
import { createOutreachSchema } from "@/lib/validations/outreach";
import { OutreachService } from "@/services/outreachService";
import { Prisma } from "@prisma/client";
import { OUTREACH_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dealId = searchParams.get("dealId");
    const sellerId = searchParams.get("sellerId");

    const outreaches = await OutreachService.getOutreaches(dealId, sellerId);
    return NextResponse.json({ outreaches });
  } catch (error: unknown) {
    console.error("DEBUG OUTREACH GET ERROR:", error);
    const message = error instanceof Error ? error.message : "Unknown outreach fetch error";
    const stack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json({ error: message, stack }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = createOutreachSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const task = await OutreachService.createOutreach(parsed.data);
    revalidateCrmTags(OUTREACH_INVALIDATION_TAGS);
    return NextResponse.json(task, { status: 201 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "이미 해당 셀러에게 영업 테스크를 생성했습니다" },
        { status: 409 },
      );
    }
    if (error instanceof Error && error.message === "이미 해당 셀러에게 영업 테스크를 생성했습니다") {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    const message = error instanceof Error ? error.message : "Unknown outreach creation error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
