import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import {
  ClaimExtractError,
  extractClaimCandidates,
  MAX_SOURCE_CHARS,
} from "@/lib/claims/claim-extractor";
import { getPrisma } from "@/lib/prisma";

type Context = { params: Promise<{ id: string }> };

/**
 * 상품자료 → 클레임 후보 추출 (C1 M3).
 *
 * **DB에 아무것도 쓰지 않는다.** 후보를 반환할 뿐이고, 등록은 운영자가 고른 것만
 * 기존 POST `/api/deals/[id]/claims`로 PROPOSED 등록된다 — AI가 레지스트리를
 * 직접 채우는 경로를 만들지 않는 것이 C1 §2-3의 요지다.
 */

const schema = z.object({
  // 상한을 넘겨도 거부하지 않고 추출기가 잘라 보낸 뒤 truncated 로 알린다.
  source: z.string().trim().min(1, "상품자료를 입력하세요").max(200_000),
});

export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력이 올바르지 않습니다" },
      { status: 400 },
    );
  }

  const prisma = getPrisma();
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    select: { id: true, category: true, parentDealId: true },
  });
  if (!deal) {
    return NextResponse.json(
      { error: "딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }
  // 카테고리는 옵션 딜이면 부모 값을 물려받는다(GET 과 같은 규약).
  const parent = deal.parentDealId
    ? await prisma.deal.findUnique({
        where: { id: deal.parentDealId },
        select: { category: true },
      })
    : null;

  try {
    const result = await extractClaimCandidates(
      parsed.data.source,
      deal.category ?? parent?.category ?? null,
    );
    return NextResponse.json({ ...result, maxSourceChars: MAX_SOURCE_CHARS });
  } catch (error) {
    // 실패를 삼키지 않는다 — 사용자에게 사유를 그대로 보여준다.
    const message =
      error instanceof ClaimExtractError
        ? error.message
        : "클레임 추출에 실패했습니다";
    console.error("[deals/[id]/claims/extract] error:", error);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
