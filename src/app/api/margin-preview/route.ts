import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { parseMarginPolicy, resolveBaseMargin, withNet } from "@/lib/margin";
import type { SalesChannel } from "@/lib/crm-types";

const querySchema = z.object({
  dealId: z.string().min(1),
  salesChannel: z.enum(["UNSPECIFIED", "OWN_MALL", "OWN_MALL_NAVER", "OWN_MALL_KAKAO", "SELLER_MALL", "BRAND_MALL"]),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const deal = await getPrisma().deal.findUnique({
    where: { id: parsed.data.dealId },
    select: { baseMarginPolicy: true },
  });
  if (!deal) {
    return NextResponse.json({ error: "Deal not found" }, { status: 404 });
  }

  const rate = resolveBaseMargin(
    parseMarginPolicy(deal.baseMarginPolicy),
    parsed.data.salesChannel as SalesChannel,
  );
  return NextResponse.json(withNet(rate));
}
