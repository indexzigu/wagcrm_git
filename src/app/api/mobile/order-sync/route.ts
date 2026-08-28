import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/api-auth";
import { naverOrderSnapshotRepository } from "@/repositories/naverOrderSnapshotRepository";
import { runSync } from "@/lib/order-converter/naver-order-sync";
import {
  applyRateLimit,
  buildFreshResponse,
  raceWithTimeout,
  resolveRefreshRatePerMinute,
  resolveRefreshTtlSeconds,
  shouldTriggerSync,
  SYNC_WAIT_TIMEOUT_MS,
  type RateWindowState,
} from "@/lib/mobile-order-refresh";

/**
 * POST /api/mobile/order-sync — 모바일 캠페인 상세 "매출 당겨서 새로고침" 전용
 * 수동 동기화 트리거 (오너 승인 2026-07-15, 설계 옵션 C, TTL 90s).
 *
 * 계약(P7):
 * - 모바일 매출 GET은 동기화 트리거 금지(불변) — 수동 최신화는 이 POST 1종뿐.
 * - 신선도 게이트: 최신 NaverOrderSnapshot.lastCallTime만 select(주문 블롭
 *   미조회). TTL(기본 90s, env MOBILE_ORDER_REFRESH_TTL_S 60~120 클램프)
 *   이내면 네이버 API 호출 없이 { status:"fresh" } 200 반환 — 429가 아니다.
 * - stale이면 기존 runSync('CHANGED')를 그대로 재사용한다(in-flight dedupe·
 *   45s 쿨다운 포함). 8초 안에 끝나지 않으면 { status:"syncing" }으로 먼저
 *   응답하고 동기화는 백그라운드에서 완주한다.
 * - 금지: revalidateCrmTags 등 revalidate 계열 호출, FULL 모드,
 *   sweepDeliveringOrders·클레임 알림 등 크론 부가작업 탑재.
 * - 분당 기본 3회 초과(인메모리 고정창)만 429 + Retry-After — env
 *   MOBILE_ORDER_REFRESH_RPM(1~10 클램프)로 조절(2026-07-15 오너 지시 10→3 하향).
 */
export async function POST() {
  const auth = await requireAuth();
  if (!auth.authenticated) return auth.response;

  const g = globalThis as typeof globalThis & {
    __mobileOrderRefreshRate?: RateWindowState;
  };
  const decision = applyRateLimit(
    g.__mobileOrderRefreshRate,
    Date.now(),
    resolveRefreshRatePerMinute(),
  );
  g.__mobileOrderRefreshRate = decision.state;
  if (!decision.allowed) {
    return NextResponse.json(
      { error: "Too many refresh requests" },
      {
        status: 429,
        headers: { "Retry-After": String(decision.retryAfterSeconds ?? 60) },
      },
    );
  }

  try {
    const ttlSeconds = resolveRefreshTtlSeconds();
    const meta = await naverOrderSnapshotRepository.latestSyncMeta();
    const lastCallTime = meta?.lastCallTime ?? null;
    const now = new Date();

    if (lastCallTime && !shouldTriggerSync(lastCallTime, now, ttlSeconds)) {
      return NextResponse.json(buildFreshResponse(lastCallTime, ttlSeconds));
    }

    // runSync는 내부에서 예외를 삼켜 SyncResult.error로 돌려주므로 reject하지
    // 않는다. 타임아웃 시에도 이 Promise는 계속 진행돼 스냅샷을 완주한다.
    const raced = await raceWithTimeout(runSync("CHANGED"), SYNC_WAIT_TIMEOUT_MS);

    if (raced.timedOut) {
      return NextResponse.json({
        status: "syncing",
        asOf: lastCallTime ? lastCallTime.toISOString() : null,
      });
    }

    const result = raced.value;
    if (result.error && result.affectedDates.length === 0) {
      // 전면 실패(부분 성공 없음)는 삼키지 않고 게이트웨이 오류로 알린다(P0).
      console.error("POST /api/mobile/order-sync sync failed:", result.error);
      return NextResponse.json({ error: result.error }, { status: 502 });
    }

    return NextResponse.json({
      status: "synced",
      asOf: result.fetchedAt,
      changed: result.affectedDates.length,
    });
  } catch (error) {
    console.error("POST /api/mobile/order-sync failed:", error);
    return NextResponse.json(
      { error: (error as Error).message || "Failed to refresh orders" },
      { status: 500 },
    );
  }
}
