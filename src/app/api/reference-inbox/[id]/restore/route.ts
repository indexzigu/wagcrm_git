import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";

type Context = {
  params: Promise<{ id: string }>;
};

/**
 * POST /api/reference-inbox/[id]/restore — 기각 실행 취소(DISMISSED → PENDING).
 * 기각(DELETE)이 소프트 전이라 되돌리기가 상태 복원으로 끝난다.
 * 기각 아이콘 상시 노출로 오클릭 가능성이 커진 것에 대한 안전장치(확인창 대신 undo 토스트).
 * DISMISSED가 아니면(이미 복원됐거나 배정으로 삭제) 404를 반환한다(no silent).
 */
export async function POST(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await context.params;
  const prisma = getPrisma();

  const item = await prisma.referenceInboxItem.findUnique({ where: { id } });
  if (!item || item.status !== "DISMISSED") {
    return NextResponse.json(
      { error: "복원할 수 있는 항목이 아닙니다." },
      { status: 404 },
    );
  }

  const restored = await prisma.referenceInboxItem.update({
    where: { id },
    data: { status: "PENDING" },
  });

  return NextResponse.json({ ok: true, item: restored });
}
