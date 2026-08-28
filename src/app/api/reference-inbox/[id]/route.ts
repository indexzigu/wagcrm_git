import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * DELETE /api/reference-inbox/[id] — 기각(소프트 전이).
 * 물리 삭제가 아니라 status=DISMISSED로 두어 재수집 시 중복 판단 근거를 남긴다(R2a §1).
 * 이미 PENDING이 아니면(배정으로 삭제됐거나 이미 기각) 404를 반환한다(no silent).
 */
export async function DELETE(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();

  const item = await prisma.referenceInboxItem.findUnique({ where: { id } });
  if (!item || item.status !== "PENDING") {
    return NextResponse.json(
      { error: "해당 인박스 항목을 찾을 수 없습니다." },
      { status: 404 },
    );
  }

  await prisma.referenceInboxItem.update({
    where: { id },
    data: { status: "DISMISSED" },
  });

  return NextResponse.json({ ok: true });
}
