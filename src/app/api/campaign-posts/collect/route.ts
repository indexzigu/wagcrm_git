import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { getPrisma } from "@/lib/prisma";
import { refreshCampaignWindowPosts } from "@/lib/campaign-posts-refresh";

// 게시물(피드+릴스) 수동 수집 — 캠페인 상세 순차 버튼(1단계)·/admin/stories 전체 수집이 호출.
// 일간 크론(collect-campaign-posts)과 같은 경량 Tier0 경로(Graph 1콜/셀러, Gemini·유료 폴백
// 없음)라 수초 안에 끝난다. analyze(전체 재분석)와 달리 postsPreview·postsCollectedAt만 갱신
// — AI 재분석은 셀러 상세의 "재분석" 버튼이 담당한다(오너 2026-07-13: 발행 확인은 경량으로).
export const maxDuration = 300;

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  // body { sellerId? } — 캠페인 상세 셀러별 수집이 사용. 없으면 수집창 셀러 전원(하위 stories/collect
  // 와 동일 계약). 서버가 수집창 교집합을 스스로 재검증한다(클라이언트 신뢰 안 함).
  const body = (await request.json().catch(() => null)) as { sellerId?: unknown } | null;
  const sellerId = typeof body?.sellerId === "string" && body.sellerId ? body.sellerId : undefined;

  // 수동 수집은 일일 게이트를 우회(force) — 관리자가 명시적으로 재수집을 원한 것.
  const result = await refreshCampaignWindowPosts(
    getPrisma(),
    new Date(),
    true,
    sellerId ? [sellerId] : undefined,
  );
  return NextResponse.json({ ok: true, ...result });
}
