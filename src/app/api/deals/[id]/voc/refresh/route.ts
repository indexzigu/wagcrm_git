import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import {
  analyzeVocForDeal,
  evaluateManualRefreshGate,
} from "@/lib/order-converter/voc-insight";

/**
 * 수동 "분석 갱신"(PR B, §6-2) — 딜 상세 요약 카드의 보조 액션. 같은 단일 딜 엔진
 * (analyzeVocForDeal)을 쿨다운(5분)·최소 VOC 게이트 뒤에서 1회 호출한다.
 * 이 라우트는 의도된 LLM 트리거 경로다(I1의 읽기 경로 아님 — /voc GET과 분리된 이유).
 *
 * 동시성(코드리뷰 H1 반영): in-flight 체크·set을 **첫 DB await보다 앞의 동기 구간**에서 수행
 * (persistDealReviews 선례와 동형 — TOCTOU 차단). 게이트 판정은 락 안에서 하고, LLM 호출 전에
 * 스냅샷을 touch(updatedAt 갱신)해 인스턴스 간 쿨다운 사각(분석 완료까지 updatedAt이 안 바뀌는
 * 창)을 LLM 45s → Prisma 왕복 1회로 좁힌다.
 */

type Context = { params: Promise<{ id: string }> };

type RefreshOutcome =
  | { kind: "below-min" }
  | { kind: "cooldown"; retryAfterSec: number }
  | { kind: "done"; ok: boolean; inputTokens: number | null; outputTokens: number | null; error?: string };

const inFlight = new Map<string, Promise<RefreshOutcome>>();

async function runGatedRefresh(dealId: string): Promise<RefreshOutcome> {
  const prisma = getPrisma();
  const [snapshot, qnaTotal, sources] = await Promise.all([
    prisma.vocInsightSnapshot.findUnique({ where: { dealId }, select: { updatedAt: true } }),
    prisma.productQna.count({ where: { dealId } }),
    prisma.dealVocSource.findMany({ where: { dealId }, select: { reviewCount: true } }),
  ]);
  const totalVoc = qnaTotal + sources.reduce((sum, s) => sum + (s.reviewCount || 0), 0);

  const gate = evaluateManualRefreshGate({
    now: new Date(),
    lastAttemptAt: snapshot?.updatedAt ?? null,
    totalVoc,
  });
  if (!gate.allowed) {
    if (gate.reason === "below-min") return { kind: "below-min" };
    return { kind: "cooldown", retryAfterSec: gate.retryAfterSec };
  }

  // 시도 "시작" 시각을 기록(touch) — 다른 인스턴스의 쿨다운 게이트가 즉시 이 시도를 본다.
  // create는 성공 이력 없는 기본 행(generatedAt null)이라 dirty 판정(초기 규칙)을 왜곡하지 않는다.
  await prisma.vocInsightSnapshot.upsert({ where: { dealId }, create: { dealId }, update: {} });

  const result = await analyzeVocForDeal(dealId);
  return {
    kind: "done",
    ok: result.ok,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    error: result.error,
  };
}

export async function POST(_request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;

  // ⚠️ 여기부터 inFlight.set까지 await 금지(동기 구간) — 사이에 await이 끼면 TOCTOU 재발(H1).
  if (inFlight.has(dealId)) {
    return NextResponse.json({ error: "이미 분석이 진행 중입니다." }, { status: 409 });
  }
  const run = runGatedRefresh(dealId);
  inFlight.set(dealId, run);

  try {
    const outcome = await run;
    if (outcome.kind === "below-min") {
      return NextResponse.json(
        { error: "분석할 문의·리뷰가 아직 부족합니다. 쌓이면 자동 분석됩니다." },
        { status: 400 },
      );
    }
    if (outcome.kind === "cooldown") {
      return NextResponse.json(
        {
          error: `잠시 후 다시 시도해주세요 (${outcome.retryAfterSec}초 후 가능)`,
          retryAfterSec: outcome.retryAfterSec,
        },
        { status: 429 },
      );
    }
    if (!outcome.ok) {
      // 실패 사유는 스냅샷 lastError에도 기록돼 있다(analyzeVocForDeal) — 화면 강등 표시용.
      return NextResponse.json({ error: outcome.error ?? "분석 실패" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens });
  } catch (error) {
    console.error("[deals/[id]/voc/refresh] error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "분석 갱신 실패" },
      { status: 500 },
    );
  } finally {
    inFlight.delete(dealId);
  }
}
