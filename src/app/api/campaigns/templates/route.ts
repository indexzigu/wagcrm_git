import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { createTemplateSchema } from "@/lib/validations/campaign-template";

export async function GET() {
  const templates = await getPrisma().campaignTemplate.findMany({
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(templates);
}

export async function POST(request: Request) {
  const parsed = createTemplateSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const template = await getPrisma().campaignTemplate.create({
    data: parsed.data,
  });

  return NextResponse.json(template, { status: 201 });
}
