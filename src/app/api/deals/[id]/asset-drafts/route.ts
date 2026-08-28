import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";

// Route segment config "dynamic"은 cacheComponents와 비호환이라 선언하지 않는다.

type Context = { params: Promise<{ id: string }> };

/**
 * 셀러에게 보낸 판매 자료 초안 (C3 M4).
 *
 * **채택분만 저장한다**(오너 결정 §9-Q2) — 생성은 여전히 stateless 고(R4 의
 * "재생성 자유"), 운영자가 "셀러에게 보냄"을 표시한 것만 남는다.
 *
 * ⛔ 발송하지 않는다. 이 라우트는 "보냈다"는 **기록만** 남긴다 — 실제 전달은
 * 운영자가 카톡으로 한다(P0: 외부 부수효과 자동 실행 금지).
 */

const createSchema = z.object({
  body: z.string().trim().min(1, "저장할 내용이 없습니다").max(20000),
  gateVerdict: z.enum(["PASS", "WARN"], {
    // BLOCK 은 애초에 운영자에게 나가지 않으므로 저장 대상이 아니다(C3 §4-2).
    message: "게이트를 통과한 자료만 저장할 수 있습니다",
  }),
  /**
   * 주입된 승인 클레임 id. 상한은 **저장 실패를 막는 안전 상한**이지 정책이 아니다 —
   * 초과 시 전체 요청이 400 이 되어 \"보냄 표시\" 자체가 실패하고, 운영자에게는
   * 형식 오류로만 보인다. 실제 승인 클레임은 딜당 소수라 도달할 일이 드물지만,
   * 감사 흔적 하나 때문에 채택분 기록을 통째로 잃는 쪽이 나쁘다.
   */
  claimIds: z.array(z.string()).max(200).optional(),
  proofCardIncluded: z.boolean().optional(),
  model: z.string().trim().max(100).optional().nullable(),
  kind: z.string().trim().max(40).optional(),
});

export async function POST(request: Request, { params }: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const prisma = getPrisma();

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error:
          parsed.error.issues[0]?.message ?? "요청 형식이 올바르지 않습니다",
      },
      { status: 400 },
    );
  }

  const deal = await prisma.deal.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!deal) {
    return NextResponse.json(
      { error: "딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  const { body, gateVerdict, claimIds, proofCardIncluded, model, kind } =
    parsed.data;

  const draft = await prisma.dealAssetDraft.create({
    data: {
      dealId: id,
      kind: kind ?? "CONTENT_GUIDE",
      body,
      gateVerdict,
      // 감사 흔적이라 문자열로 둔다 — id 역조회 분석은 A/B 실험이 붙는 시점의
      // 과제다(스키마 주석 참고).
      // ⚠️ **빈 배열을 null 로 접지 않는다.** 승인 소구점 0건이어도 생성은 허용되므로
      // (claimGuided 는 차단이 아니라 플래그) 빈 배열은 도달 가능한 정상 상태다. 이걸
      // null 로 접으면 "클레임 없이 자유 생성함"과 "배선이 끊겨 아무것도 안 보냄"이
      // DB 에서 똑같이 보인다 — 두 컬럼이 항상 null 로 쌓이던 결함(#187)과 같은 계열의
      // 관측 불능이다. 빈 문자열 = 보냈고 0건, null = 애초에 안 보냄.
      claimIds: claimIds ? claimIds.join(",") : null,
      proofCardIncluded: proofCardIncluded ?? false,
      model: model ?? null,
    },
    select: { id: true, sentAt: true, kind: true },
  });

  return NextResponse.json({ draft }, { status: 201 });
}

/** 이 딜에서 셀러에게 보낸 이력 — 최신순. */
export async function GET(_request: Request, { params }: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const prisma = getPrisma();

  const drafts = await prisma.dealAssetDraft.findMany({
    where: { dealId: id },
    orderBy: { sentAt: "desc" },
    take: 20,
    select: {
      id: true,
      kind: true,
      gateVerdict: true,
      proofCardIncluded: true,
      sentAt: true,
    },
  });

  return NextResponse.json({ drafts });
}
