import { NextResponse } from "next/server";
import { z } from "zod";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import {
  buildGroupExpectedReceivables,
  type ExpectedReceivable,
} from "@/lib/tax-invoice-mail/expected-receivables";
import { loadCampaignSettlementFacts } from "@/lib/tax-invoice-mail/campaign-facts";
import {
  applyReceiptDecision,
  revertReceiptDecision,
  ReceiptDecisionRejected,
} from "@/services/taxInvoiceReceiptDecisionService";

/**
 * 수취 계산서 **결정** 엔드포인트 — 이 기능에서 유일하게 쓰는 경로다.
 *
 * 스캔(`GET ../tax-invoice-receipts`)의 무쓰기·무흔적 계약은 그대로 유지된다. 자동 확정을
 * 붙이지 않는 이유(잘못 발행된 계산서가 「확인됨」으로 굳는다)도 그대로다 — 여기서 쓰는
 * 근거는 판정이 아니라 **오너의 클릭**이다(오너 확정 2026-08-12: 항상 1클릭 승인 대기).
 *
 * ## 대상 검증 — 클라이언트가 보낸 key 를 그대로 믿지 않는다
 *
 * 승인 대상은 **서버가 다시 만든 기대 건 집합 안에 있어야** 한다. 그러지 않으면 브랜드몰처럼
 * 그 필드가 「발행」 의무인 조합에 수취 완료를 찍을 수 있다(의무표는
 * `expected-receivables.ts` 헤더가 정본). 기대 건 생성은 스캔과 **같은 SSOT**
 * (`loadCampaignSettlementFacts` + `buildGroupExpectedReceivables`)를 쓴다 — 여기서 다시
 * 조립하면 두 표면이 서로 다른 대상을 승인 가능하다고 말한다.
 */

/** 승인 대상 검증용 조회 창. 스캔 기본(90일)보다 넉넉히 잡는다 — 오래된 건도 승인할 수 있어야 한다. */
const DECISION_LOOKUP_DAYS = 365;

const bodySchema = z.object({
  issueId: z.string().min(1),
  action: z.enum(["approve", "dismiss", "revert"]),
  /** 승인 대상 기대 건 key(`campaignId:slot`). approve 일 때만 의미가 있다. */
  targetKeys: z.array(z.string().min(1)).optional(),
  /** 계산서 작성일자 — 수취일시에 쓸 값. approve 인데 없으면 결정만 기록한다. */
  writtenDate: z.string().date().nullable().optional(),
  observedTotal: z.number().int().nullable().optional(),
  expectedTotal: z.number().int().nullable().optional(),
  signalSummary: z.unknown().optional(),
});

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const raw: unknown = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
  }
  const body = parsed.data;
  const prisma = getPrisma();

  if (body.action === "revert") {
    const result = await revertReceiptDecision(prisma, body.issueId);
    if (!result.found) {
      return NextResponse.json({ error: "되돌릴 결정 기록이 없습니다." }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      cleared: result.cleared,
      // 승인 이후 오너가 직접 바꾼 값은 건드리지 않았다 — 조용히 넘기지 않고 알린다.
      skipped: result.skipped,
    });
  }

  if (body.action === "dismiss") {
    await applyReceiptDecision(prisma, {
      issueId: body.issueId,
      decision: "DISMISSED",
      matchedKeys: [],
      appliedDate: null,
      observedTotal: body.observedTotal ?? null,
      expectedTotal: body.expectedTotal ?? null,
      amountDelta: resolveDelta(body.observedTotal, body.expectedTotal),
      signalSummary: body.signalSummary ?? null,
    });
    return NextResponse.json({ ok: true });
  }

  // ── approve
  const targetKeys = body.targetKeys ?? [];
  if (targetKeys.length === 0) {
    return NextResponse.json({ error: "승인 대상이 지정되지 않았습니다." }, { status: 400 });
  }

  const facts = await loadCampaignSettlementFacts(prisma, { sinceDays: DECISION_LOOKUP_DAYS });
  const expected: ExpectedReceivable[] = [
    ...facts.solo.flatMap((item) => buildGroupExpectedReceivables([item])),
    ...[...facts.byGroup.values()].flatMap((members) => buildGroupExpectedReceivables(members)),
  ];
  const validKeys = new Set(expected.map((item) => item.key));

  const unknownKeys = targetKeys.filter((key) => !validKeys.has(key));
  if (unknownKeys.length > 0) {
    // 삼키지 않는다 — 부분 승인으로 넘어가면 오너는 전부 처리된 줄 안다(P0).
    return NextResponse.json(
      { error: "승인 대상이 현재 정산 기대 건에 없습니다. 화면을 새로 조회해 주세요.", unknownKeys },
      { status: 409 },
    );
  }

  const matched = expected.filter((item) => targetKeys.includes(item.key));
  const trackable = matched.filter((item) => item.trackingField !== null);
  if (trackable.length === 0) {
    return NextResponse.json(
      { error: "이 건은 완료를 기록할 자리가 없습니다." },
      { status: 422 },
    );
  }

  try {
    const result = await applyReceiptDecision(prisma, {
      issueId: body.issueId,
      decision: "APPROVED",
      matchedKeys: trackable.map((item) => item.key),
      // ⚠️ 수취일시에는 **계산서 작성일자**를 쓴다(발행일이므로). 오늘 날짜로 대신 찍으면
      //    없는 사실을 만들어 내므로, 없으면 서비스가 승인 자체를 거부한다.
      appliedDate: body.writtenDate ? new Date(`${body.writtenDate}T00:00:00.000Z`) : null,
      observedTotal: body.observedTotal ?? null,
      expectedTotal: body.expectedTotal ?? null,
      amountDelta: resolveDelta(body.observedTotal, body.expectedTotal),
      signalSummary: body.signalSummary ?? null,
    });

    return NextResponse.json({ ok: true, applied: result.applied });
  } catch (error) {
    // 승인이 성립하지 않은 경우는 **거부로 응답한다.** 200 으로 넘기면 화면이 「승인됨」을
    // 그리는데 수취일시는 비어 있는 상태가 되고, 그 건은 다음 스캔에서 제안조차 뜨지 않는다
    // (교차 검증에서 잡힌 실제 결함, 2026-08-12).
    if (error instanceof ReceiptDecisionRejected) {
      return NextResponse.json(
        { error: error.message, code: error.code, detail: error.detail },
        { status: error.code === "MISSING_WRITTEN_DATE" ? 422 : 409 },
      );
    }
    throw error;
  }
}

/** 관측 − 기대. 둘 다 알 때만 값이 된다(누락을 0으로 치지 않는다). */
function resolveDelta(
  observed: number | null | undefined,
  expected: number | null | undefined,
): number | null {
  return typeof observed === "number" && typeof expected === "number" ? observed - expected : null;
}
