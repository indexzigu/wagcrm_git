import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { CHANNEL_FEE_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";

export async function GET() {
  const channels = await getPrisma().channelFeeConfig.findMany({
    orderBy: { channel: "asc" },
  });
  return NextResponse.json({ channels });
}

const updateSchema = z.object({
  channel: z.string(),
  feeRate: z.number().min(0),
  paymentRate: z.number().min(0),
  notes: z.string().optional(),
});

export async function PATCH(request: Request) {
  const body = await request.json();
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { channel, feeRate, paymentRate, notes } = parsed.data;

  const updated = await getPrisma().channelFeeConfig.update({
    where: { channel },
    data: { feeRate, paymentRate, notes },
  });

  revalidateCrmTags(CHANNEL_FEE_INVALIDATION_TAGS);

  return NextResponse.json(updated);
}
