import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { captureActiveCampaignStories } from "@/lib/story-capture";

// "지금 수집" 온디맨드 트리거 — /admin/stories 버튼이 호출. 크론과 동일한 브라우저 수집 경로를
// 관리자 세션으로 즉시 실행한다(Vercel 자동 주기 외에 수동으로 돌리고 싶을 때). 브라우저를 서버에서
// 띄우므로 시간이 걸린다(maxDuration 상향).
export const maxDuration = 300;

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // body { sellerId? } — 캠페인 상세 셀러별 수집이 사용. 없으면 기존 전역 수집(하위호환).
  // 서버는 어느 쪽이든 수집창 교집합을 스스로 재검증한다(클라이언트 신뢰 안 함).
  const body = (await request.json().catch(() => null)) as { sellerId?: unknown } | null;
  const sellerId = typeof body?.sellerId === "string" && body.sellerId ? body.sellerId : undefined;

  // 수동 "지금 수집"은 일일 게이트를 우회(force) — 관리자가 명시적으로 재수집을 원한 것.
  const result = await captureActiveCampaignStories(
    getPrisma(),
    new Date(),
    true,
    sellerId ? [sellerId] : undefined,
  );
  return NextResponse.json({ ok: true, ...result });
}
