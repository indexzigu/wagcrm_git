import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { loadDealClaimContext } from "@/lib/claims/deal-claim-context";

// Route segment config "dynamic"은 cacheComponents와 비호환이라 선언하지 않는다
// (라우트 핸들러는 요청별 실행이 기본).

type Context = { params: Promise<{ id: string }> };

/**
 * 딜 클레임 — 승인 소구점 / 딜 전용 금지 표현 / 필수 고지 (C1 M2b).
 *
 * 승인(APPROVED) 전환은 **운영자만** 한다. AI 추출(M3)이 붙어도 그쪽은
 * PROPOSED 까지만 만든다 — 근거 없는 주장이 조용히 승인되지 않게 하는 것이
 * 이 레지스트리의 존재 이유다(C1 §2-3).
 */

const CLAIM_KINDS = [
  "APPROVED_CLAIM",
  "BANNED_PHRASE",
  "REQUIRED_DISCLOSURE",
] as const;
const EVIDENCE_TYPES = ["MEASURED", "USER_PROVIDED", "NEEDS_SOURCE"] as const;
const STATUSES = ["PROPOSED", "APPROVED", "REJECTED", "EXPIRED"] as const;

const createSchema = z.object({
  kind: z.enum(CLAIM_KINDS),
  text: z.string().trim().min(1, "표현을 입력하세요").max(500),
  evidence: z.string().trim().max(1000).optional().nullable(),
  evidenceType: z.enum(EVIDENCE_TYPES).default("NEEDS_SOURCE"),
  reviewBy: z.string().datetime().optional().nullable(),
  source: z.string().trim().max(200).optional().nullable(),
});

const patchSchema = z.object({
  claimId: z.string().min(1),
  status: z.enum(STATUSES).optional(),
  text: z.string().trim().min(1).max(500).optional(),
  evidence: z.string().trim().max(1000).optional().nullable(),
  evidenceType: z.enum(EVIDENCE_TYPES).optional(),
  reviewBy: z.string().datetime().optional().nullable(),
  rejectedNote: z.string().trim().max(500).optional().nullable(),
});

export async function GET(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;
  try {
    // 옵션 딜의 부모 클레임·카테고리 상속(C1 §4)은 `loadDealClaimContext` 가
    // 정본이다. 이 라우트에만 인라인으로 있던 탓에 content-guide 라우트가 같은
    // 규약을 손으로 다시 쓰다 어긋났다(부모 치환·부모 카테고리 우선) — 그래서
    // 함수로 뽑고 양쪽을 수렴시켰다. `inherited` 플래그도 그 함수가 붙인다.
    const claimContext = await loadDealClaimContext(dealId);
    if (!claimContext) {
      return NextResponse.json(
        { error: "딜을 찾을 수 없습니다" },
        { status: 404 },
      );
    }
    return NextResponse.json(claimContext);
  } catch (error) {
    console.error("[deals/[id]/claims] GET error:", error);
    return NextResponse.json({ error: "클레임 로드 실패" }, { status: 500 });
  }
}

export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력이 올바르지 않습니다" },
      { status: 400 },
    );
  }

  const prisma = getPrisma();
  try {
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: { id: true },
    });
    if (!deal) {
      return NextResponse.json(
        { error: "딜을 찾을 수 없습니다" },
        { status: 404 },
      );
    }
    const claim = await prisma.dealClaim.create({
      data: {
        dealId,
        kind: parsed.data.kind,
        text: parsed.data.text,
        evidence: parsed.data.evidence ?? null,
        evidenceType: parsed.data.evidenceType,
        reviewBy: parsed.data.reviewBy ? new Date(parsed.data.reviewBy) : null,
        source: parsed.data.source ?? "운영자 직접",
        // 신규 등록은 언제나 PROPOSED 에서 출발한다 — 승인은 별도 조작.
        status: "PROPOSED",
      },
    });
    return NextResponse.json(claim, { status: 201 });
  } catch (error) {
    console.error("[deals/[id]/claims] POST error:", error);
    return NextResponse.json({ error: "클레임 등록 실패" }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "입력이 올바르지 않습니다" },
      { status: 400 },
    );
  }
  const { claimId, status, ...rest } = parsed.data;

  const prisma = getPrisma();
  try {
    const existing = await prisma.dealClaim.findFirst({
      where: { id: claimId, dealId },
      select: { id: true, evidenceType: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "클레임을 찾을 수 없습니다" },
        { status: 404 },
      );
    }

    // 근거 없는 주장은 승인되지 않는다 — 주장 자체는 근거가 아니다(C1 §2-2).
    const nextEvidenceType = rest.evidenceType ?? existing.evidenceType;
    if (status === "APPROVED" && nextEvidenceType === "NEEDS_SOURCE") {
      return NextResponse.json(
        { error: "근거 미확보(NEEDS_SOURCE) 상태로는 승인할 수 없습니다" },
        { status: 400 },
      );
    }

    const claim = await prisma.dealClaim.update({
      where: { id: claimId },
      data: {
        ...(status ? { status } : {}),
        ...(status === "APPROVED" ? { approvedAt: new Date() } : {}),
        ...(rest.text !== undefined ? { text: rest.text } : {}),
        ...(rest.evidence !== undefined ? { evidence: rest.evidence } : {}),
        ...(rest.evidenceType !== undefined
          ? { evidenceType: rest.evidenceType }
          : {}),
        ...(rest.reviewBy !== undefined
          ? { reviewBy: rest.reviewBy ? new Date(rest.reviewBy) : null }
          : {}),
        ...(rest.rejectedNote !== undefined
          ? { rejectedNote: rest.rejectedNote }
          : {}),
      },
    });
    return NextResponse.json(claim);
  } catch (error) {
    console.error("[deals/[id]/claims] PATCH error:", error);
    return NextResponse.json({ error: "클레임 수정 실패" }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;
  const claimId = new URL(request.url).searchParams.get("claimId");
  if (!claimId) {
    return NextResponse.json(
      { error: "claimId가 필요합니다" },
      { status: 400 },
    );
  }

  const prisma = getPrisma();
  try {
    const result = await prisma.dealClaim.deleteMany({
      where: { id: claimId, dealId },
    });
    if (result.count === 0) {
      return NextResponse.json(
        { error: "클레임을 찾을 수 없습니다" },
        { status: 404 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[deals/[id]/claims] DELETE error:", error);
    return NextResponse.json({ error: "클레임 삭제 실패" }, { status: 500 });
  }
}
