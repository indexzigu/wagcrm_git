import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

export async function DELETE(_request: Request, context: Context) {
  const { id } = await context.params;

  const template = await getPrisma().campaignTemplate.findUnique({
    where: { id },
  });

  if (!template) {
    return NextResponse.json(
      { error: "해당 템플릿을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  await getPrisma().campaignTemplate.delete({ where: { id } });

  return NextResponse.json({ ok: true });
}
