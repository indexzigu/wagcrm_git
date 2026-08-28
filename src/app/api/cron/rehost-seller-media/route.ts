import { NextResponse } from "next/server";
import { withSystemTaskStatus } from "@/lib/system-task-status";
import { getPrisma } from "@/lib/prisma";
import { SELLER_METRICS_INVALIDATION_TAGS, revalidateCrmTags } from "@/lib/cache-tags";
import { verifyCronAuth } from "@/lib/cron-auth";
import {
  countPendingThumbs,
  isMediaRehostConfigured,
  rehostSellerMedia,
  type RehostResult,
} from "@/lib/seller-analysis/mediaRehost";

// 피드 썸네일 재호스팅 sweep (스펙 §8 개정) — 10분 주기 크론.
// analyze가 저장한 인스타 CDN URL(수일 내 만료)을 시간차 다운로드로 전용 공개 버킷에 옮긴다.
// 최초 분석 계정의 썸네일 완비까지 수 분~십수 분 = 레퍼런스 서비스와 동일한 지연 특성(의도된 것).
export const maxDuration = 300;

async function handler(request: Request) {
  if (!verifyCronAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isMediaRehostConfigured()) {
    return NextResponse.json({ skipped: "storage env 미설정 (SUPABASE_SERVICE_ROLE_KEY 필요)" });
  }

  const prisma = getPrisma();
  // SellerAiProfile은 소규모(분석된 셀러만) — 전체 조회 후 JS 필터가 단순·충분
  const profiles = await prisma.sellerAiProfile.findMany({
    select: { sellerId: true, aiTags: true, analyzedAt: true },
  });
  const needy = profiles
    .map((p) => ({ sellerId: p.sellerId, pending: countPendingThumbs(p.aiTags), analyzedAt: p.analyzedAt }))
    .filter((p) => p.pending > 0)
    // 최근 분석 우선(신선한 URL부터 — 만료 전에 확보)
    .sort((a, b) => (b.analyzedAt?.getTime() ?? 0) - (a.analyzedAt?.getTime() ?? 0));

  if (needy.length === 0) {
    return NextResponse.json({ ok: true, message: "대기 항목 없음", profiles: profiles.length });
  }

  // 함수 시간예산(300s) 내에서 순차 처리 — 남으면 다음 sweep으로
  const deadlineMs = Date.now() + 240_000;
  const results: RehostResult[] = [];
  for (const target of needy.slice(0, 3)) {
    if (Date.now() >= deadlineMs) break;
    const result = await rehostSellerMedia(prisma, target.sellerId, { deadlineMs });
    results.push(result);
  }

  // 이벤트 기반 무효화(2026-07-10): 실제로 재호스팅한 게 있을 때만 셀러 상세/목록 캐시를 깬다.
  if (results.length > 0) {
    revalidateCrmTags(SELLER_METRICS_INVALIDATION_TAGS);
  }

  return NextResponse.json({
    ok: true,
    queued: needy.length,
    processed: results,
  });
}

export const GET = withSystemTaskStatus("rehost-seller-media", handler);
