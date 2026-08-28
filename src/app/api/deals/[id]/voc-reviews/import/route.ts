import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/prisma";
import { requireAuth } from "@/lib/api-auth";
import {
  persistDealReviews,
  normalizeImportedReviews,
  VOC_CHANNELS,
  type VocChannel,
} from "@/lib/order-converter/voc-store";

export const maxDuration = 60;

type Context = { params: Promise<{ id: string }> };

/**
 * 리뷰 수동 임포트 — 스크랩 불가 소스(협조 브랜드 몰·CSV 내보내기)를 오너가 직접 적재한다(계획서 §2-C/D3).
 * 코퍼스는 Google Drive에 저장(Supabase 의존 최소화). Drive 미연결이면 명확한 에러(503)로 실패한다.
 *
 * body: { channel: VocChannel, productUrl?, originProductNo?, channelProductNo?, reviews: unknown[] }
 */
export async function POST(request: Request, context: Context) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const { id: dealId } = await context.params;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "JSON 본문을 파싱할 수 없습니다." }, { status: 400 });
  }

  const channel = String(body.channel ?? "");
  if (!VOC_CHANNELS.includes(channel as VocChannel)) {
    return NextResponse.json(
      { error: `channel은 ${VOC_CHANNELS.join(" | ")} 중 하나여야 합니다.` },
      { status: 400 },
    );
  }

  const received = Array.isArray(body.reviews) ? body.reviews.length : 0;
  const reviews = normalizeImportedReviews(body.reviews);
  const skipped = received - reviews.length;
  if (reviews.length === 0) {
    return NextResponse.json(
      { error: "유효한 리뷰가 없습니다(rating 1~5·content·작성일 필수).", received, skipped },
      { status: 400 },
    );
  }

  // 딜 존재 확인(고아 소스 방지).
  const prisma = getPrisma();
  const deal = await prisma.deal.findUnique({ where: { id: dealId }, select: { id: true } });
  if (!deal) return NextResponse.json({ error: "딜을 찾을 수 없습니다." }, { status: 404 });

  try {
    const result = await persistDealReviews({
      dealId,
      channel,
      productUrl: typeof body.productUrl === "string" ? body.productUrl : null,
      originProductNo: typeof body.originProductNo === "string" ? body.originProductNo : null,
      channelProductNo: typeof body.channelProductNo === "string" ? body.channelProductNo : null,
      incoming: reviews,
    });
    // received/accepted/skipped를 함께 반환 — 일부만 통과한 부분 실패가 ok:true로 위장되지 않게 한다.
    return NextResponse.json({ ok: true, channel, received, accepted: reviews.length, skipped, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "리뷰 저장 실패";
    // Drive 미연결은 운영자가 조치해야 하는 선결 조건 → 503(서비스 구성 필요).
    const isDriveGate = message.includes("Google Drive 미연결");
    return NextResponse.json({ error: message }, { status: isDriveGate ? 503 : 500 });
  }
}
