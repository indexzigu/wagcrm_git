import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";

const conversionSchema = z.object({
  campaignId: z.string().optional(),
  nt_source: z.string().optional(),
  nt_medium: z.string().optional(),
  nt_detail: z.string().optional(),
  landingUrl: z.string().optional(),
  conversionEvent: z.string().min(1).default("lead_submit"),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: Request) {
  const body = await request.json();
  const parsed = conversionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const attribution = await getPrisma().trackingAttribution.create({
    data: {
      campaignId: parsed.data.campaignId,
      ntSource: parsed.data.nt_source,
      ntMedium: parsed.data.nt_medium,
      ntDetail: parsed.data.nt_detail,
      landingUrl: parsed.data.landingUrl,
      conversionEvent: parsed.data.conversionEvent,
      payload: parsed.data.payload ? JSON.stringify(parsed.data.payload) : undefined,
    },
  });

  return NextResponse.json(attribution, { status: 201 });
}
