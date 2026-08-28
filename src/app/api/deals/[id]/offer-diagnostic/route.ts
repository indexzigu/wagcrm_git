import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import {
  diagnoseOffer,
  MANUAL_ROW_IDS,
  type ManualAnswer,
  type ManualRowId,
  type PriceVerdict,
} from "@/lib/offer/offer-diagnostic";
import { RUN_STATUSES } from "@/lib/recampaign-timing";

// Route segment config "dynamic"은 cacheComponents와 비호환이라 선언하지 않는다.

type Context = { params: Promise<{ id: string }> };

/** 판정 로직이 아는 verdict 만 통과시킨다 — 모르는 값은 스냅샷 없음으로 본다. */
const KNOWN_VERDICTS: readonly string[] = ["OK", "TIE", "VIOLATED", "NO_DATA"];

function toPriceVerdict(raw: string | undefined): PriceVerdict | null {
  return raw && KNOWN_VERDICTS.includes(raw) ? (raw as PriceVerdict) : null;
}

/**
 * 공구 오퍼 진단 (C2 M2) — 읽기 전용.
 *
 * 판정은 `diagnoseOffer` 순수 함수가 하고, 이 라우트는 **입력을 모으는
 * 일만** 한다. 6행 전부 이미 저장된 값에서 나오므로 쓰기도, 신규 테이블도
 * 없다.
 *
 * ⚠️ 옵션 딜(자식)에 대한 요청은 **부모 기준으로 판정한다** — 오퍼는 본품
 * 단위로 성립하고, 옵션 하나만 떼어 보면 "구성 차별 없음"처럼 잘못 읽힌다
 * (C1 §4의 상속 규약과 같은 취지).
 */
export async function GET(_request: Request, { params }: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const prisma = getPrisma();

  const requested = await prisma.deal.findUnique({
    where: { id },
    select: { id: true, parentDealId: true },
  });
  if (!requested) {
    return NextResponse.json(
      { error: "딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  // 옵션이면 부모로 올려서 본다(위 주석의 이유).
  const targetId = requested.parentDealId ?? requested.id;

  const deal = await prisma.deal.findUnique({
    where: { id: targetId },
    select: {
      id: true,
      dealName: true,
      listPrice: true,
      sellingPrice: true,
      shippingFee: true,
      freeShippingThreshold: true,
      supplementaryInfo: true,
      // 앵콜 이력은 옵션 캠페인까지 합쳐야 "이 오퍼가 몇 번 돌았나"가 된다 —
      // 개수(마찰·구성 차별 행)와 id(이력 조회)를 한 번에 받는다.
      options: { select: { id: true } },
    },
  });
  if (!deal) {
    return NextResponse.json(
      { error: "딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }

  const dealIds = [targetId, ...deal.options.map((o) => o.id)];

  const [latestSnapshot, approvedClaims, offerAnswers, priorRunCount] =
    await Promise.all([
      prisma.priceMonitorSnapshot.findFirst({
        where: { dealId: targetId },
        orderBy: { snapshotDate: "desc" },
        select: { verdict: true, snapshotDate: true },
      }),
      prisma.dealClaim.findMany({
        where: {
          dealId: targetId,
          kind: "APPROVED_CLAIM",
          status: "APPROVED",
        },
        select: { evidenceType: true },
      }),
      prisma.dealOfferAnswer.findMany({
        where: { dealId: targetId },
        select: { rowId: true, verdict: true, note: true },
      }),
      // 앵콜 이력 — 시작일이 도래한 실행 상태 캠페인만 센다. 제안·준비는
      // 아직 시장 반응이 없어 이력이 아니다(`RUN_STATUSES` 와 같은 어휘).
      prisma.salesCampaign.count({
        where: {
          dealId: { in: dealIds },
          status: { in: [...RUN_STATUSES] },
          startDate: { lte: new Date() },
        },
      }),
    ]);

  // 루브릭이 아는 행만 통과시킨다 — 옛 행 식별자가 남아 있어도 판정을 흔들지
  // 않는다(행 세트는 바뀔 수 있고, DB 는 문자열로 들고 있다).
  const manualAnswers: Partial<Record<ManualRowId, ManualAnswer>> = {};
  for (const answer of offerAnswers) {
    if ((MANUAL_ROW_IDS as readonly string[]).includes(answer.rowId)) {
      manualAnswers[answer.rowId as ManualRowId] = {
        verdict: answer.verdict,
        note: answer.note,
      };
    }
  }

  const diagnosis = diagnoseOffer({
    listPrice: deal.listPrice ? Number(deal.listPrice) : null,
    sellingPrice: Number(deal.sellingPrice),
    priceVerdict: toPriceVerdict(latestSnapshot?.verdict),
    shippingFee: deal.shippingFee ? Number(deal.shippingFee) : null,
    freeShippingThreshold: deal.freeShippingThreshold
      ? Number(deal.freeShippingThreshold)
      : null,
    optionCount: deal.options.length,
    supplementaryInfo: deal.supplementaryInfo,
    approvedClaimCount: approvedClaims.length,
    measuredClaimCount: approvedClaims.filter(
      (c) => c.evidenceType === "MEASURED",
    ).length,
    // 셀러 적합도 점수 기능이 아직 없다 → 이 행은 NA 로 빠진다(스펙 §4-⑨).
    sellerFit: null,
    priorRunCount,
    manualAnswers,
  });

  return NextResponse.json({
    ...diagnosis,
    dealId: deal.id,
    dealName: deal.dealName,
    /** 요청 대상이 옵션이라 부모로 올려 판정했는지 — UI가 그 사실을 밝힌다. */
    resolvedFromParent: targetId !== requested.id,
    priceSnapshotDate: latestSnapshot?.snapshotDate ?? null,
  });
}

// zod 의 enum 기본 메시지는 영문("Invalid input")이라 그대로 두면 운영자에게
// 영문이 노출된다 — 사용자 대면 문구는 한국어가 기본이다.
const answerSchema = z.object({
  rowId: z.enum(MANUAL_ROW_IDS, { message: "진단 루브릭에 없는 항목입니다" }),
  verdict: z.enum(["PASS", "FAIL", "UNKNOWN"], {
    message: "판정은 확인함·미충족·모름 중 하나여야 합니다",
  }),
  note: z
    .string()
    .trim()
    .max(1000, "메모는 1000자 이내로 입력하세요")
    .optional()
    .nullable(),
});

/**
 * 수동 행 응답 저장 (C2 M3).
 *
 * 옵션 딜로 들어와도 **부모에 저장한다** — GET 이 부모 기준으로 판정하므로
 * 저장도 같은 곳이어야 한다. 그러지 않으면 답을 넣었는데 진단이 안 바뀐다.
 */
export async function PUT(request: Request, { params }: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id } = await params;
  const prisma = getPrisma();

  const parsed = answerSchema.safeParse(await request.json().catch(() => null));
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
    select: { id: true, parentDealId: true },
  });
  if (!deal) {
    return NextResponse.json(
      { error: "딜을 찾을 수 없습니다" },
      { status: 404 },
    );
  }
  const targetId = deal.parentDealId ?? deal.id;

  const { rowId, verdict, note } = parsed.data;
  const saved = await prisma.dealOfferAnswer.upsert({
    where: { dealId_rowId: { dealId: targetId, rowId } },
    create: { dealId: targetId, rowId, verdict, note: note ?? null },
    update: { verdict, note: note ?? null },
    select: { rowId: true, verdict: true, note: true, updatedAt: true },
  });

  return NextResponse.json({ answer: saved, dealId: targetId });
}
